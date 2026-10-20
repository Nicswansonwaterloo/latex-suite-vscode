import * as assert from "node:assert/strict";
import * as vscode from "vscode";
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
