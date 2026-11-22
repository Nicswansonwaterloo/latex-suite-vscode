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
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 5, 0, 5);
		const settings = vscode.workspace.getConfiguration("latexSuite", document);
		const keys = ["highlighting.bracketPairs", "highlighting.matchingBracket", "highlighting.mathDelimiters"];
		const previous = keys.map(key => settings.inspect<boolean>(key)?.globalValue);
		const painted = new Map<string, string>();
		// Observe a real editor: mocking only visibleTextEditors leaves the native
		// visibility events able to remove the fake editor during host startup.
		let registrations: vscode.Disposable | undefined;
		const parsed = parseContext(document.getText());
		let bracketVisits = 0;
		const tracked = { ...parsed, isIgnored: (offset: number) => { bracketVisits++; return parsed.isIgnored(offset); } };
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
			registrations = registerMathHighlights(() => tracked, (target, style, ranges) => {
				if (target === editor) { painted.set(style.key, ranges.map(r => document.getText(r)).join("")); }
				target.setDecorations(style, ranges);
			});
			await expectColors(["$$", "()"]);
			const initialVisits = bracketVisits;
			assert.ok(initialVisits > 0);
			editor.selection = new vscode.Selection(0, 2, 0, 2);
			await expectColors(["$$", "()", "()"]);
			assert.equal(bracketVisits, initialVisits, "cursor movement reuses the bracket scan");

			await settings.update(keys[0], false, vscode.ConfigurationTarget.Global);
			await expectColors(["$$", "()"]);
			await settings.update(keys[2], false, vscode.ConfigurationTarget.Global);
			await expectColors(["()"]);
			await settings.update(keys[1], false, vscode.ConfigurationTarget.Global);
			await expectColors([]);
		} finally {
			registrations?.dispose();
			for (const [index, key] of keys.entries()) { await settings.update(key, previous[index], vscode.ConfigurationTarget.Global); }
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
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
