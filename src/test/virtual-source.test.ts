import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("virtual sources and delayed loading", () => {
	const sourceUri = vscode.Uri.parse("latex-suite-test:/snippets.js");
	const config = () => vscode.workspace.getConfiguration("latexSuite");
	let registration: vscode.Disposable;
	let changes: vscode.EventEmitter<vscode.FileChangeEvent[]>;
	let previous: Map<string, unknown>;
	let entered: () => void;
	let release: (() => void) | undefined;
	let releases: Array<() => void>;
	let readStarted: Promise<void>;
	let reads: number;
	const marker = globalThis as typeof globalThis & { latexSuiteReplacementCalls?: number };

	setup(async () => {
		previous = new Map(["enabled", "snippets.files", "snippets.source", "snippets.variableFiles", "snippets.variablesSource"].map(key => [key, config().inspect(key)?.globalValue]));
		changes = new vscode.EventEmitter();
		reads = 0;
		releases = [];
		marker.latexSuiteReplacementCalls = 0;
		readStarted = new Promise(resolve => { entered = resolve; });
		registration = vscode.workspace.registerFileSystemProvider(sourceUri.scheme, {
			onDidChangeFile: changes.event,
			watch: () => new vscode.Disposable(() => {}),
			stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 100 }),
			readDirectory: () => [],
			createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
			writeFile: () => { throw vscode.FileSystemError.NoPermissions(); },
			delete: () => { throw vscode.FileSystemError.NoPermissions(); },
			rename: () => { throw vscode.FileSystemError.NoPermissions(); },
			readFile: async uri => {
				assert.equal(uri.toString(), sourceUri.toString());
				reads++;
				await new Promise<void>(resolve => { release = resolve; releases.push(resolve); entered(); });
				return new TextEncoder().encode('[{ trigger: "probe", options: "m", replacement: () => { globalThis.latexSuiteReplacementCalls++; return "VIRTUAL"; } }]');
			},
		}, { isReadonly: true });
		await vscode.extensions.getExtension("qmvis.latex-suite-vscode")!.activate();
		for (const [key, value] of Object.entries({ enabled: true, "snippets.files": [sourceUri.toString()], "snippets.source": "", "snippets.variablesSource": "", "snippets.variableFiles": [] })) {
			await config().update(key, value, vscode.ConfigurationTarget.Global);
		}
	});

	teardown(async () => {
		for (const resolve of releases) { resolve(); }
		release = undefined;
		for (const [key, value] of previous) { await config().update(key, value, vscode.ConfigurationTarget.Global); }
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		registration.dispose();
		changes.dispose();
		delete marker.latexSuiteReplacementCalls;
	});

	test("a file reload during a pending expansion uses the newest collection", async () => {
		const document = await vscode.workspace.openTextDocument({ language: "markdown", content: "$probe$" });
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 6, 0, 6);
		const pending = vscode.commands.executeCommand<boolean>("latexSuite.expandSnippet");
		await readStarted;
		const releaseFirst = release!;
		readStarted = new Promise(resolve => { entered = resolve; });
		changes.fire([{ type: vscode.FileChangeType.Changed, uri: sourceUri }]);
		await readStarted;
		releaseFirst();
		release!();
		assert.equal(await pending, true);
		assert.equal(document.getText(), "$VIRTUAL$");
		assert.equal(reads, 2);
		assert.equal(marker.latexSuiteReplacementCalls, 1, "only the current bundle is executed");
	});

	for (const interruption of ["none", "selection", "document", "configuration"] as const) {
		test(`delayed non-file source: ${interruption === "none" ? "expands through workspace.fs" : "rejects a stale " + interruption}`, async () => {
			const document = await vscode.workspace.openTextDocument({ language: "markdown", content: "$probe$" });
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(0, 6, 0, 6);
			const pending = vscode.commands.executeCommand<boolean>("latexSuite.expandSnippet");
			await readStarted; // Deterministically hold I/O until the competing action finishes.
			if (interruption === "selection") { editor.selection = new vscode.Selection(0, 0, 0, 0); }
			if (interruption === "document") { await editor.edit(builder => builder.insert(new vscode.Position(0, 0), "changed ")); }
			if (interruption === "configuration") { await config().update("enabled", false, vscode.ConfigurationTarget.Global); }
			release!();
			assert.equal(await pending, interruption === "none");
			assert.equal(document.getText(), interruption === "none" ? "$VIRTUAL$" : interruption === "document" ? "changed $probe$" : "$probe$");
			assert.equal(marker.latexSuiteReplacementCalls, interruption === "none" ? 1 : 0);
			assert.equal(reads, 1);
		});
	}
});
