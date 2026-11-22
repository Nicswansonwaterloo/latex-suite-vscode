import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { getConfig, type LatexSuiteConfig } from "../config";
import { SnippetRepository } from "../snippetRepository";
import { PollingSourceWatcher, SnippetFileWatcher } from "../snippetFileWatcher";
import { matchFirstSnippet } from "../core/snippets";

suite("snippet collection selection", () => {
	let repository: SnippetRepository;
	let output: vscode.OutputChannel;
	let document: vscode.TextDocument;
	let config: LatexSuiteConfig;
	let directory: string;
	const custom = '[{ trigger: "customOnly", replacement: "CUSTOM", options: "tA" }]';

	suiteSetup(() => { output = vscode.window.createOutputChannel("Snippet collection tests"); });
	suiteTeardown(() => output.dispose());

	setup(async () => {
		repository = new SnippetRepository(output);
		document = await vscode.workspace.openTextDocument({ language: "markdown" });
		config = getConfig(document);
		Object.assign(config.snippets, { source: "", files: [], variablesSource: "", variableFiles: [] });
		directory = await mkdtemp(path.join(tmpdir(), "latex-suite-collection-"));
	});

	teardown(async () => {
		repository.dispose();
		await rm(directory, { recursive: true, force: true });
	});

	async function file(name: string, source: string): Promise<string> {
		const uri = vscode.Uri.file(path.join(directory, name));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
		return uri.fsPath;
	}

	test("uses bundled snippets with no sources or only blank entries", async () => {
		const defaults = await repository.get(document, config);
		assert.ok(defaults.snippets.length > 100);
		assert.deepEqual(defaults.errors, []);
		config.snippets.source = " \n ";
		config.snippets.files = ["", " \t "];
		const blank = await repository.get(document, config);
		assert.deepEqual(blank.snippets.map(s => s.trigger), defaults.snippets.map(s => s.trigger));
	});

	test("custom inline snippets replace bundled snippets", async () => {
		config.snippets.source = custom;
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets.map(s => s.trigger), ["customOnly"]);
		assert.deepEqual(bundle.errors, []);
	});

	test("custom files and inline source form one collection without defaults", async () => {
		config.snippets.source = custom;
		config.snippets.files = [await file("custom.js", '[{ trigger: "fileOnly", replacement: "FILE", options: "tA" }]')];
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets.map(s => s.trigger).sort(), ["customOnly", "fileOnly"]);
		assert.deepEqual(bundle.errors, []);
	});

	test("an explicit empty inline collection does not restore defaults", async () => {
		config.snippets.source = "[]";
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets, []);
		assert.deepEqual(bundle.errors, []);
	});

	test("an empty custom file does not restore defaults", async () => {
		config.snippets.files = [await file("empty.js", "")];
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets, []);
	});

	test("an empty custom directory does not restore defaults", async () => {
		config.snippets.files = [directory];
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets, []);
		assert.deepEqual(bundle.errors, []);
	});

	test("a missing custom file reports an error without restoring defaults", async () => {
		config.snippets.files = [path.join(directory, "missing.js")];
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets, []);
		assert.equal(bundle.errors.length, 1);
		assert.match(bundle.errors[0], /missing\.js/);
	});

	test("moving and restoring an external ancestor updates an explicitly configured file", async function () {
		this.timeout(15_000);
		const team = path.join(directory, "team");
		const moved = path.join(directory, "moved");
		const file = path.join(team, "sources", "user.js");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, custom);
		config.snippets.files = [file];
		const initial = await repository.get(document, config);
		assert.deepEqual(initial.errors, []);

		// An external OS watch starts asynchronously. Observe a real edit before
		// performing the directory rename, which may produce only a single event.
		const deadline = Date.now() + 4000;
		while (repository.isCurrent(initial) && Date.now() < deadline) {
			await writeFile(file, custom);
			await delay(400);
		}
		assert.ok(!repository.isCurrent(initial), "external watcher is receiving changes");
		for (const [from, to, missing] of [[team, moved, true], [moved, team, false]] as const) {
			await rename(from, to);
			const deadline = Date.now() + 4000;
			let bundle = await repository.get(document, config);
			while ((bundle.errors.length > 0) !== missing && Date.now() < deadline) {
				await delay(40);
				bundle = await repository.get(document, config);
			}
			assert.equal(bundle.errors.length, missing ? 1 : 0);
			assert.deepEqual(bundle.snippets.map(s => s.trigger), missing ? [] : ["customOnly"]);
		}
	});

	test("source watchers coalesce create/change/delete bursts and cancel pending reloads on disposal", async () => {
		const createWatcher = vscode.workspace.createFileSystemWatcher;
		const events = {
			create: new vscode.EventEmitter<vscode.Uri>(), change: new vscode.EventEmitter<vscode.Uri>(),
			delete: new vscode.EventEmitter<vscode.Uri>(),
		};
		let watched = 0;
		let watchedForChanges = 0;
		let disposed = 0;
		let reloaded = 0;
		const uri = vscode.Uri.parse("source-watch:/parent/sources");
		let watcher: SnippetFileWatcher | undefined;
		try {
			vscode.workspace.createFileSystemWatcher = (_pattern, _ignoreCreate, ignoreChanges) => {
				watched++;
				if (!ignoreChanges) { watchedForChanges++; }
				return {
					ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false,
					onDidCreate: events.create.event, onDidChange: events.change.event, onDidDelete: events.delete.event,
					dispose: () => { disposed++; },
				};
			};
			watcher = new SnippetFileWatcher([uri, uri], () => { reloaded++; });
			watcher.setDirectory(uri, true);
			watcher.setDirectory(uri, true);
			assert.equal(watchedForChanges, 2, "only the entry and its recursive watcher observe ordinary saves");
			assert.ok(watched > 2, "containing directories are watched for create/delete events");
			events.delete.fire(uri);
			events.create.fire(uri);
			events.change.fire(uri);
			assert.equal(reloaded, 0);
			await delay(300);
			assert.equal(reloaded, 1);
			events.change.fire(uri);
			watcher.dispose();
			await delay(300);
			assert.equal(reloaded, 1, "disposal cancels the pending event");
			assert.equal(disposed, watched);
		} finally {
			vscode.workspace.createFileSystemWatcher = createWatcher;
			watcher?.dispose();
			for (const event of Object.values(events)) { event.dispose(); }
		}
	});

	test("polling detects nested changes and missing directories without holding rename locks", async function () {
		this.timeout(15_000);
		const root = path.join(directory, "polled");
		const moved = path.join(directory, "moved");
		const nested = path.join(root, "nested");
		let changes = 0;
		const watcher = new PollingSourceWatcher(vscode.Uri.file(root), () => { changes++; });
		async function changed(action: () => Promise<unknown>) {
			const previous = changes;
			await action();
			const deadline = Date.now() + 3000;
			while (changes === previous && Date.now() < deadline) { await delay(20); }
			assert.ok(changes > previous, "source metadata change was detected");
		}
		try {
			await watcher.ready;
			await changed(async () => {
				await mkdir(nested, { recursive: true });
				await writeFile(path.join(nested, "source.js"), custom);
			});
			await changed(() => writeFile(path.join(nested, "source.js"), custom + "\n// edited"));
			await changed(() => rename(root, moved));
			await changed(() => rename(moved, root));
			await changed(() => rm(path.join(nested, "source.js")));
			watcher.dispose();
			const stopped = changes;
			await writeFile(path.join(nested, "new.js"), custom);
			await delay(1100);
			assert.equal(changes, stopped, "disposal stops polling");
		} finally {
			watcher.dispose();
		}
	});

	test("invalid custom JavaScript reports an error without restoring defaults", async () => {
		config.snippets.source = "export default [";
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets, []);
		assert.equal(bundle.errors.length, 1);
		assert.match(bundle.errors[0], /inline snippets/);
	});

	test("a failing file preserves valid custom sources without adding defaults", async () => {
		config.snippets.source = custom;
		config.snippets.files = [await file("broken.js", 'throw new Error("broken source");')];
		const bundle = await repository.get(document, config);
		assert.deepEqual(bundle.snippets.map(s => s.trigger), ["customOnly"]);
		assert.equal(bundle.errors.length, 1);
		assert.match(bundle.errors[0], /broken source/);
	});

	test("variable overrides retain bundled variables and do not select custom snippets", async () => {
		config.snippets.variablesSource = '({ GREEK: "inlineOverride", EXTRA: "extra" })';
		config.snippets.variableFiles = [await file("variables.js", '({ GREEK: "fileOverride" })')];
		const defaults = await repository.get(document, config);
		assert.ok(defaults.snippets.length > 100);
		assert.equal(defaults.variables["${GREEK}"], "fileOverride");
		assert.equal(defaults.variables["${EXTRA}"], "extra");
		assert.ok(defaults.variables["${SYMBOL}"]);
		config.snippets.source = custom;
		const customBundle = await repository.get(document, config);
		assert.deepEqual(customBundle.snippets.map(s => s.trigger), ["customOnly"]);
		assert.deepEqual(customBundle.variables, defaults.variables);
	});

	for (const location of ["inline", "file"]) {
		for (const ending of ["", ";"]) {
			test(`loads quoted variable keys from ${location} source ending in ${JSON.stringify(ending)}`, async () => {
				const source = `{
					// Upstream variable files use quoted placeholder names.
					"\${GREEK}": "alpha|beta",
					"\${OPERATORNAMES}": "End|Hom|Aut|Mat|wt|GL|char|Pic|disc|trd"
				}${ending}`;
				if (location === "file") {
					config.snippets.variableFiles = [await file("variables.js", source)];
				} else {
					config.snippets.variablesSource = source;
				}
				config.snippets.source = `[{
					trigger: "(\${OPERATORNAMES})",
					replacement: "\\\\operatorname{[[0]]}",
					options: "rmA"
				}]`;
				const bundle = await repository.get(document, config);
				assert.deepEqual(bundle.errors, []);
				for (const name of bundle.variables["${OPERATORNAMES}"].split("|")) {
					const match = matchFirstSnippet(bundle.snippets, {
						before: `$${name}`, automatic: true,
						mode: {
							inlineMath: true, blockMath: false, codeMath: false,
							text: false, codeBlock: false, code: false,
							textEnv: false, snippetlessEnv: false,
						},
					});
					assert.equal(match?.replacement.insert, `\\operatorname{${name}}`);
				}
			});
		}
	}

	test("simulated trust gate: Restricted Mode uses defaults without evaluating or reading custom sources", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted")!;
		const grantDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "onDidGrantWorkspaceTrust")!;
		const grant = new vscode.EventEmitter<void>();
		const createWatcher = vscode.workspace.createFileSystemWatcher;
		const settings = vscode.workspace.getConfiguration("latexSuite", document);
		const oldFiles = settings.inspect<string[]>("snippets.files")?.globalValue;
		let watches = 0;
		try {
			const files = ["trust-test:/missing.js"];
			await settings.update("snippets.files", files, vscode.ConfigurationTarget.Global);
			repository.dispose();
			Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, get: () => false });
			Object.defineProperty(vscode.workspace, "onDidGrantWorkspaceTrust", { configurable: true, value: grant.event });
			vscode.workspace.createFileSystemWatcher = (...args) => { watches++; return createWatcher(...args); };
			repository = new SnippetRepository(output);
			config.snippets.source = 'throw new Error("must not execute")';
			config.snippets.variablesSource = config.snippets.source;
			config.snippets.files = files;
			config.snippets.variableFiles = config.snippets.files;
			const bundle = await repository.get(document, config);
			assert.ok(bundle.snippets.length > 100);
			assert.deepEqual(bundle.errors, []);
			assert.equal(bundle.customSourcesSkipped, true);
			assert.equal(watches, 0);
			Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, get: () => true });
			grant.fire();
			assert.equal(repository.isCurrent(bundle), false);
			assert.ok(watches > 0, "granting trust starts watches for the configured paths");
			const trusted = await repository.get(document, config);
			assert.deepEqual(trusted.snippets, []);
			assert.equal(trusted.errors.length, 4);
			assert.equal(trusted.customSourcesSkipped, false);
		} finally {
			vscode.workspace.createFileSystemWatcher = createWatcher;
			Object.defineProperty(vscode.workspace, "onDidGrantWorkspaceTrust", grantDescriptor);
			Object.defineProperty(vscode.workspace, "isTrusted", descriptor);
			grant.dispose();
			await settings.update("snippets.files", oldFiles, vscode.ConfigurationTarget.Global);
		}
	});

	for (const legacyMode of ["extend", "replace", "defaultsOnly"]) {
		test(`ignores legacy ${legacyMode} values`, async () => {
			assert.equal("mode" in config.snippets, false);
			Object.assign(config.snippets, { mode: legacyMode });
			assert.ok((await repository.get(document, config)).snippets.length > 100);
			config.snippets.source = custom;
			assert.deepEqual((await repository.get(document, config)).snippets.map(s => s.trigger), ["customOnly"]);
		});
	}
});
