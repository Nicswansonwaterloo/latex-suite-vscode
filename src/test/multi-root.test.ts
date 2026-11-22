import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { getConfig } from "../config";
import { SnippetRepository, type SnippetBundle } from "../snippetRepository";

suite("multi-root snippet loading", () => {
	test("switching source settings disposes old watches and installs the new path", async () => {
		const folder = vscode.workspace.workspaceFolders![0];
		const resource = { uri: vscode.Uri.joinPath(folder.uri, "watch-settings.md"), languageId: "markdown" };
		const configuration = vscode.workspace.getConfiguration("latexSuite", resource);
		const setting = "snippets.files";
		const saved = configuration.inspect<string[]>(setting)?.workspaceFolderValue;
		const id = randomUUID();
		const oldName = `old-${id}.js`;
		const newName = `new-${id}.js`;
		const createWatcher = vscode.workspace.createFileSystemWatcher;
		const output = vscode.window.createOutputChannel("Watcher settings tests");
		const repository = new SnippetRepository(output);
		const oldWatches = new Set<vscode.FileSystemWatcher>();
		let watchingNew = false;
		try {
			// Use a virtual source to exercise native watchers on every OS.
			await configuration.update(setting, [`watch-settings:/${oldName}`], vscode.ConfigurationTarget.WorkspaceFolder);
			vscode.workspace.createFileSystemWatcher = (...args) => {
				const watcher = createWatcher(...args);
				const [pattern] = args;
				if (typeof pattern !== "string" && pattern.pattern === oldName) {
					oldWatches.add(watcher);
					const dispose = watcher.dispose.bind(watcher);
					watcher.dispose = () => { oldWatches.delete(watcher); dispose(); };
				}
				if (typeof pattern !== "string" && pattern.pattern === newName) { watchingNew = true; }
				return watcher;
			};
			const old = await repository.get(resource, getConfig(resource));
			assert.ok(oldWatches.size > 0);
			await configuration.update(setting, [`watch-settings:/${newName}`], vscode.ConfigurationTarget.WorkspaceFolder);
			assert.equal(repository.isCurrent(old), false);
			assert.equal(oldWatches.size, 0);
			assert.ok(watchingNew);
			const current = await repository.get(resource, getConfig(resource));
			assert.ok(current.errors.some(error => error.includes(newName)));
		} finally {
			repository.dispose();
			output.dispose();
			vscode.workspace.createFileSystemWatcher = createWatcher;
			await configuration.update(setting, saved, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	test("file changes reload nested snippets and variables only in their configured folder", async function () {
		this.timeout(30_000);
		const folders = vscode.workspace.workspaceFolders!;
		assert.equal(folders.length, 2);
		const name = `source-watch-${randomUUID()}`;
		const directory = vscode.Uri.joinPath(folders[0].uri, name);
		const resources = folders.map(folder => ({ uri: vscode.Uri.joinPath(folder.uri, "watch.md"), languageId: "markdown" }));
		const configs = resources.map((resource) => {
			const config = getConfig(resource);
			Object.assign(config.snippets, {
				files: [`${name}/snippets`], source: "",
				variableFiles: [`${name}/vars[1].js`], variablesSource: "",
			});
			return config;
		});
		const output = vscode.window.createOutputChannel("Snippet file watcher tests");
		const repository = new SnippetRepository(output);
		const get = (index: number) => repository.get(resources[index], configs[index]);
		const write = (uri: vscode.Uri, source: string) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
		const snippets = (trigger: string) => JSON.stringify([{ trigger, replacement: "result", options: "m" }]);
		async function until(matches: (bundle: SnippetBundle) => boolean, reason: string): Promise<SnippetBundle> {
			const deadline = Date.now() + 5000;
			let bundle = await get(0);
			while (!matches(bundle) && Date.now() < deadline) {
				await delay(40);
				bundle = await get(0);
			}
			assert.ok(matches(bundle), reason);
			return bundle;
		}
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(directory, "snippets", "nested"));
			const initial = await get(0);
			assert.equal(initial.errors.length, 1, "missing variable source is reported");
			const other = await get(1);
			const variableFile = vscode.Uri.joinPath(directory, "vars[1].js");
			const nested = vscode.Uri.joinPath(directory, "snippets", "nested");
			const snippetFile = vscode.Uri.joinPath(nested, "snippet.js");
			await write(variableFile, '({ WATCHED: "created" })');
			await write(snippetFile, snippets("created"));
			await until(bundle => bundle.variables["${WATCHED}"] === "created" && bundle.snippets[0]?.trigger === "created", "new files loaded");
			assert.equal(repository.isCurrent(initial), false);

			await write(variableFile, '({ WATCHED: "saved" })');
			await write(snippetFile, snippets("saved"));
			await until(bundle => bundle.variables["${WATCHED}"] === "saved" && bundle.snippets[0]?.trigger === "saved", "existing sources reloaded");

			await vscode.workspace.fs.rename(nested, vscode.Uri.joinPath(directory, "moved"));
			await until(bundle => bundle.snippets.length === 0, "renaming a subtree out of the collection removes its snippets");
			await vscode.workspace.fs.delete(variableFile);
			await until(bundle => bundle.errors.length === 1 && !bundle.variables["${WATCHED}"], "deleted source reported through the loader");
			assert.equal(await get(1), other, "unrelated folder retains its original bundle");
			assert.ok(repository.isCurrent(other));
		} finally {
			repository.dispose();
			output.dispose();
			await vscode.workspace.fs.delete(directory, { recursive: true });
		}
	});

	test("the same relative source resolves independently in each document's folder", async () => {
		const folders = vscode.workspace.workspaceFolders;
		assert.equal(folders?.length, 2);
		const keys = ["snippets.files", "snippets.source", "snippets.variableFiles", "snippets.variablesSource"];
		const saved: Array<{ config: vscode.WorkspaceConfiguration; key: string; value: unknown }> = [];
		const files: vscode.Uri[] = [];
		try {
			for (const [index, folder] of folders!.entries()) {
				const config = vscode.workspace.getConfiguration("latexSuite", folder.uri);
				for (const key of keys) {
					saved.push({ config, key, value: config.inspect(key)?.workspaceFolderValue });
					await config.update(key, key === "snippets.files" ? ["shared.js"] : key.endsWith("Files") ? [] : "", vscode.ConfigurationTarget.WorkspaceFolder);
				}
				const source = vscode.Uri.joinPath(folder.uri, "shared.js");
				const note = vscode.Uri.joinPath(folder.uri, "note.md");
				files.push(source, note);
				await vscode.workspace.fs.writeFile(source, new TextEncoder().encode(`[{ trigger: "probe", replacement: "FOLDER${index}", options: "m" }]`));
				await vscode.workspace.fs.writeFile(note, new TextEncoder().encode("$probe$"));
			}
			await vscode.extensions.getExtension("qmvis.latex-suite-vscode")!.activate();
			for (const index of [0, 1, 0]) {
				const document: vscode.TextDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folders![index].uri, "note.md"));
				const editor = await vscode.window.showTextDocument(document);
				editor.selection = new vscode.Selection(0, 6, 0, 6);
				assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
				assert.equal(document.getText(), `$FOLDER${index}$`);
				await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			}
		} finally {
			for (const { config, key, value } of saved) { await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder); }
			for (const uri of files) { await vscode.workspace.fs.delete(uri); }
		}
	});
});
