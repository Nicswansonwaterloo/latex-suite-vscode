const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

// Commands can resolve before the extension host receives the new selection.
async function expectEventually(read, expected) {
	const deadline = Date.now() + 5000;
	while (read() !== expected && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal(read(), expected);
}

exports.run = async () => {
	const extension = vscode.extensions.getExtension(process.env.LATEX_SUITE_TEST_ID);
	assert.ok(extension, 'installed extension is discoverable');
	assert.equal(path.dirname(extension.extensionPath), process.env.LATEX_SUITE_INSTALLED_DIR,
		'test must use the installed VSIX, never the development checkout');
	const restricted = process.env.LATEX_SUITE_RESTRICTED === '1';
	assert.equal(vscode.workspace.isTrusted, !restricted, 'real workspace trust state');
	await extension.activate();
	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '$par$' });
	const editor = await vscode.window.showTextDocument(document);
	editor.selection = new vscode.Selection(0, 4, 0, 4);
	assert.equal(await vscode.commands.executeCommand('latexSuite.expandSnippet'), true);
	assert.equal(document.getText(), '$\\frac{ \\partial y }{ \\partial x }$');
	const selection = () => document.getText(editor.selection);
	const cursor = () => document.offsetAt(editor.selection.active);
	await expectEventually(selection, 'y');
	await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
	await expectEventually(selection, 'x');
	await vscode.commands.executeCommand('jumpToPrevSnippetPlaceholder');
	await expectEventually(selection, 'y');
	await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
	await expectEventually(selection, 'x');
	await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
	await expectEventually(cursor, document.getText().length - 1);
	assert.equal(await vscode.commands.executeCommand('latexSuite.previousBracketOrEquation'), true);
	await expectEventually(cursor, document.getText().lastIndexOf('{'));
	await vscode.commands.executeCommand('latexSuite.tab');
	await expectEventually(cursor, document.getText().length - 1);
	await vscode.commands.executeCommand('latexSuite.tab');
	await expectEventually(cursor, document.getText().length);
	await vscode.commands.executeCommand('leaveSnippet');
	const typed = await vscode.workspace.openTextDocument({ language: 'markdown', content: '$$' });
	const typingEditor = await vscode.window.showTextDocument(typed);
	typingEditor.selection = new vscode.Selection(0, 1, 0, 1);
	for (const text of '@a') { await vscode.commands.executeCommand('type', { text }); }
	await expectEventually(() => typed.getText(), '$\\alpha$');
	console.log(`Installed VSIX smoke passed (${restricted ? 'Restricted Mode' : 'trusted'}): activation, bundled snippets, native placeholders, forward and reverse tab-out, automatic typing.`);
};
