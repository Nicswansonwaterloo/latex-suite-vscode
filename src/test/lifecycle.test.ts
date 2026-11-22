import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { setTimeout as delay } from "node:timers/promises";
import { parseContext } from "../core/context";
import { registerMathHighlights } from "../editor/highlights";
import { LatexSuiteController } from "../extension";

// This suite runs in its own host and disposes the startup controller before
// testing fresh controllers. Only pending-wait observation needs private access.
interface LifecycleObservation {
	waitForCollapsedSelection(editor: vscode.TextEditor, version: number, offset: number): Promise<boolean>;
	operationIsCurrent(editor: vscode.TextEditor, version: number, selection: { anchor: number; active: number }): boolean;
	refreshContextKeys(): Promise<void>;
}

suite("controller lifecycle", () => {
	let output: vscode.LogOutputChannel;
	suiteSetup(async () => {
		const controller = await vscode.extensions.getExtension<vscode.Disposable>("qmvis.latex-suite-vscode")!.activate();
		controller.dispose();
		output = vscode.window.createOutputChannel("Lifecycle tests", { log: true });
	});
	suiteTeardown(() => output.dispose());

	test("cursor movement reuses bracket pairs and changing each setting clears its decorations", async () => {
		const document = await vscode.workspace.openTextDocument({ language: "markdown", content: "$ ( ab ) $" });
		const settings = vscode.workspace.getConfiguration("latexSuite", document);
		const keys = ["highlighting.bracketPairs", "highlighting.matchingBracket", "highlighting.mathDelimiters"];
		const previous = keys.map(key => settings.inspect<boolean>(key)?.globalValue);
		const selectionEvent = new vscode.EventEmitter<vscode.TextEditorSelectionChangeEvent>();
		const visible = Object.getOwnPropertyDescriptor(vscode.window, "visibleTextEditors")!;
		const onSelection = Object.getOwnPropertyDescriptor(vscode.window, "onDidChangeTextEditorSelection")!;
		const painted = new Map<string, string>();
		// VS Code exposes no decoration getter. Record the ranges sent to the editor
		// while using its real document, settings events, ranges and decoration types.
		const editor = {
			document,
			selections: [new vscode.Selection(0, 5, 0, 5)],
			visibleRanges: [new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))],
			setDecorations(style: vscode.TextEditorDecorationType, ranges: vscode.Range[]) {
				painted.set(style.key, ranges.map(r => document.getText(r)).join(""));
			},
		} as unknown as vscode.TextEditor;
		let registrations: vscode.Disposable | undefined;
		let parses = 0;
		const colors = () => [...painted.values()].filter(Boolean).sort();
		async function expectColors(expected: string[]) {
			const deadline = Date.now() + 2000;
			while (colors().join(",") !== expected.join(",") && Date.now() < deadline) {
				await delay(20);
			}
			assert.deepEqual(colors(), expected);
		}
		try {
			for (const key of keys) { await settings.update(key, true, vscode.ConfigurationTarget.Global); }
			Object.defineProperty(vscode.window, "visibleTextEditors", { configurable: true, get: () => [editor] });
			Object.defineProperty(vscode.window, "onDidChangeTextEditorSelection", { ...onSelection, value: selectionEvent.event });
			registrations = registerMathHighlights(source => { parses++; return parseContext(source); });
			await expectColors(["$$", "()"]);
			const initialParses = parses;
			editor.selections = [new vscode.Selection(0, 2, 0, 2)];
			selectionEvent.fire({ textEditor: editor, selections: editor.selections, kind: vscode.TextEditorSelectionChangeKind.Keyboard });
			await expectColors(["$$", "()", "()"]);
			assert.equal(parses, initialParses);

			await settings.update(keys[0], false, vscode.ConfigurationTarget.Global);
			await expectColors(["$$", "()"]);
			await settings.update(keys[2], false, vscode.ConfigurationTarget.Global);
			await expectColors(["()"]);
			await settings.update(keys[1], false, vscode.ConfigurationTarget.Global);
			await expectColors([]);
		} finally {
			registrations?.dispose();
			Object.defineProperty(vscode.window, "visibleTextEditors", visible);
			Object.defineProperty(vscode.window, "onDidChangeTextEditorSelection", onSelection);
			selectionEvent.dispose();
			for (const [index, key] of keys.entries()) { await settings.update(key, previous[index], vscode.ConfigurationTarget.Global); }
		}
	});

	test("real disposal unregisters commands, cancels pending waits, and invalidates operations", async () => {
		assert.equal((await vscode.commands.getCommands(true)).includes("latexSuite.internal.waitForIdle"), false);
		const document = await vscode.workspace.openTextDocument({ language: "plaintext", content: "ab" });
		const editor = await vscode.window.showTextDocument(document);
		const controller = new LatexSuiteController(output);
		const observation = controller as unknown as LifecycleObservation;
		try {
			assert.ok((await vscode.commands.getCommands(true)).includes("latexSuite.internal.waitForIdle"));
			assert.equal(observation.operationIsCurrent(editor, document.version, { anchor: 0, active: 0 }), true);
			const pending = observation.waitForCollapsedSelection(editor, document.version, 1);
			controller.dispose();
			assert.equal(await pending, false);
			assert.equal(observation.operationIsCurrent(editor, document.version, { anchor: 0, active: 0 }), false);
			assert.equal((await vscode.commands.getCommands(true)).includes("latexSuite.internal.waitForIdle"), false);
			assert.doesNotThrow(() => controller.dispose(), "disposal is idempotent");
		} finally {
			controller.dispose();
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});

	test("background context refresh logs command failures without rejecting", async () => {
		const controller = new LatexSuiteController(output);
		const observation = controller as unknown as LifecycleObservation;
		const execute = vscode.commands.executeCommand;
		const log = output.error;
		const reported: string[] = [];
		try {
			await observation.refreshContextKeys();
			vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
				if (command === "setContext") { throw new Error("injected context command failure"); }
				return execute(command, ...args);
			}) as typeof execute;
			output.error = (message: string) => { reported.push(message); };
			await assert.doesNotReject(observation.refreshContextKeys());
			assert.ok(reported.some(message => message.includes("injected context command failure")));
		} finally {
			vscode.commands.executeCommand = execute;
			output.error = log;
			controller.dispose();
		}
	});
});
