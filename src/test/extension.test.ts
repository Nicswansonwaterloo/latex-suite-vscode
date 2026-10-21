import * as assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isSupportedDocument } from "../config";

suite("LaTeX Suite extension", function () {
	this.timeout(10_000);

	suiteSetup(async () => {
		await resetSnippetLoaderSettings();
		const extension = vscode.extensions.getExtension("qmvis.latex-suite-vscode");
		assert.ok(extension, "extension should be discoverable by its manifest id");
		await extension.activate();
	});

	teardown(async () => {
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	suiteTeardown(async () => {
		await resetSnippetLoaderSettings();
		await setExtensionSetting("enabled", undefined);
	});

	test("keybindings do not depend on asynchronous snippet matching", () => {
		const extension = vscode.extensions.getExtension("qmvis.latex-suite-vscode");
		assert.ok(extension);
		const keybindings = extension.packageJSON.contributes.keybindings as Array<{
			command: string;
			key: string;
			when: string;
		}>;
		const tab = keybindings.find((binding) => binding.key === "tab");
		assert.equal(tab?.command, "latexSuite.tab");
		assert.ok(tab?.when.includes("config.latexSuite.enabled"));
		assert.ok(tab?.when.includes("config.editor.tabCompletion == off"));
		assert.ok(tab?.when.includes("!inlineEditIsVisible"));
		assert.equal(tab?.when.includes("latexSuite.canHandleTab"), false);
		assert.equal(
			keybindings.find((binding) => binding.key === "enter")?.command,
			"latexSuite.internal.matrixNewline",
		);
		assert.equal(
			keybindings.find((binding) => binding.key === "shift+enter")?.command,
			"latexSuite.internal.matrixExit",
		);
	});

	test("file extensions control shortcuts independently of language and update immediately", async () => {
		const settings = vscode.workspace.getConfiguration("latexSuite");
		const previous = settings.inspect<string[]>("fileExtensions")?.globalValue;
		try {
			await setExtensionSetting("fileExtensions", undefined);
			for (const extension of ["tex", "md", "qmd", "QMD"]) {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(`untitled:/latex-suite-default.${extension}`));
				assert.equal(isSupportedDocument(document), true, extension);
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.parse("untitled:/latex-suite-custom.rmd"));
			await vscode.languages.setTextDocumentLanguage(document, "markdown");
			const editor = await vscode.window.showTextDocument(document);
			assert.equal(isSupportedDocument(document), false, "language alone must not enable a named file");
			await typeCharacters("dm");
			assert.equal(document.getText(), "dm");
			await editor.edit(builder => builder.delete(new vscode.Range(document.positionAt(0), document.positionAt(2))));
			await vscode.languages.setTextDocumentLanguage(document, "plaintext");
			await setExtensionSetting("fileExtensions", ["RMD"]);
			assert.equal(isSupportedDocument(document), true);
			await typeCharacters("dm");
			await waitFor(() => normalizeEol(document.getText()) === "$$\n\n$$");
			await setExtensionSetting("fileExtensions", []);
			assert.equal(isSupportedDocument(document), false);
			assert.equal(await vscode.commands.executeCommand("latexSuite.matrixCell"), false);
			const untitled = await vscode.workspace.openTextDocument({ language: "markdown" });
			assert.equal(isSupportedDocument(untitled), false);
		} finally {
			await setExtensionSetting("fileExtensions", previous);
		}
	});

	test("automatically expands an upstream text-mode snippet in Markdown", async () => {
		const editor = await openEditor("markdown", "", 0);
		await typeCharacters("dm");
		await waitFor(() => normalizeEol(editor.document.getText()) === "$$\n\n$$");
		assert.equal(normalizeEol(editor.document.getText()), "$$\n\n$$");
	});

	test("inline math has no extra braces and places the cursor inside", async () => {
		const editor = await openEditor("markdown", "", 0);
		await typeCharacters("mk");
		await waitFor(() => editor.document.getText() === "$$");
		assert.equal(editor.selection.isEmpty, true);
		assert.equal(editor.document.offsetAt(editor.selection.active), 1);
		await typeCharacters("x");
		assert.equal(editor.document.getText(), "$x$");
	});

	test("expands after rapid consecutive type commands", async () => {
		const editor = await openEditor("markdown", "", 0);
		for (const character of "dm") {
			await vscode.commands.executeCommand("type", { text: character });
		}
		await waitForExtensionIdle();
		assert.equal(normalizeEol(editor.document.getText()), "$$\n\n$$");
	});

	test("expands a burst of math typing without per-character idle barriers", async () => {
		const editor = await openEditor("markdown", "$$", 1);
		for (const character of "@a+@b+@g") {
			await vscode.commands.executeCommand("type", { text: character });
		}
		await waitFor(() => editor.document.getText() === "$\\alpha+\\beta+\\gamma$");
		assert.equal(editor.document.getText(), "$\\alpha+\\beta+\\gamma$");
	});

	test("automatically expands math snippets in a LaTeX document", async () => {
		const editor = await openEditor("latex", "$$", 1);
		await typeCharacters("@a");
		await waitFor(() => editor.document.getText() === "$\\alpha$");
		assert.equal(editor.document.getText(), "$\\alpha$");

		await vscode.commands.executeCommand("latexSuite.tab");
		assert.equal(editor.document.offsetAt(editor.selection.active), editor.document.getText().length);
	});

	test("manual expansion enters native placeholder mode", async () => {
		const editor = await openEditor("markdown", "$par$", 4);
		const expanded = await vscode.commands.executeCommand<boolean>("latexSuite.expandSnippet");
		assert.equal(expanded, true);
		assert.equal(editor.document.getText(), "$\\frac{ \\partial y }{ \\partial x }$");
		assert.equal(editor.document.getText(editor.selection), "y");

		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		assert.equal(editor.document.getText(editor.selection), "x");
		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		await vscode.commands.executeCommand("latexSuite.tab");
		assert.equal(editor.document.offsetAt(editor.selection.active), editor.document.getText().length);
	});

	test("a unique last tabstop is the native final cursor", async () => {
		const editor = await openEditor("markdown", "$$", 1);
		await typeCharacters("bf");
		await waitFor(() => editor.document.getText() === "$\\mathbf{}$");
		const inside = editor.document.getText().indexOf("}");
		assert.equal(editor.document.offsetAt(editor.selection.active), inside);
		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		assert.equal(editor.document.offsetAt(editor.selection.active), inside);
	});

	test("automatic bracket snippets adopt VS Code auto-closing pairs", async () => {
		for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
			const editor = await openEditor("markdown", "$$", 1);
			await typeCharacters(open);
			await waitFor(() => editor.document.getText() === `$${open}${close}$`);
			assert.equal(editor.document.getText(), `$${open}${close}$`);
			assert.equal(editor.document.offsetAt(editor.selection.active), 2);
			assert.equal(
				await vscode.commands.executeCommand("latexSuite.nextBracketOrEquation"),
				true,
			);
			assert.equal(editor.document.offsetAt(editor.selection.active), 3);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});

	test("multiline equation tab-out trims whitespace and lands at the block indentation", async () => {
		const source = "  $$\n  x   \n  $$\n  ";
		const editor = await openEditor("markdown", source, source.indexOf("x") + 1);

		assert.equal(
			await vscode.commands.executeCommand("latexSuite.nextBracketOrEquation"),
			true,
		);
		assert.equal(editor.document.getText(), "  $$\n  x\n  $$\n  ");
		assert.deepEqual(editor.selection.active, new vscode.Position(3, 2));
	});

	test("multiline equation tab-out appends an indented CRLF line at EOF", async () => {
		const source = "  $$\r\n  x\r\n  $$";
		const documentFile = vscode.Uri.file(path.join(
			tmpdir(),
			`latex-suite-tab-out-crlf-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
		));
		await vscode.workspace.fs.writeFile(documentFile, new TextEncoder().encode(source));
		try {
			const document = await vscode.workspace.openTextDocument(documentFile);
			const editor = await vscode.window.showTextDocument(document);
			const cursor = document.positionAt(source.indexOf("x") + 1);
			editor.selection = new vscode.Selection(cursor, cursor);

			assert.equal(document.eol, vscode.EndOfLine.CRLF);
			assert.equal(
				await vscode.commands.executeCommand("latexSuite.nextBracketOrEquation"),
				true,
			);
			assert.equal(document.eol, vscode.EndOfLine.CRLF);
			assert.equal(document.getText(), "  $$\r\n  x\r\n  $$\r\n  ");
			assert.deepEqual(editor.selection.active, new vscode.Position(3, 2));
		} finally {
			await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			await vscode.workspace.fs.delete(documentFile);
		}
	});

	test("VS Code visits an empty numbered placeholder before its final cursor", async () => {
		const editor = await openEditor("markdown", "", 0);
		assert.equal(await editor.insertSnippet(new vscode.SnippetString("($1)$0")), true);
		assert.equal(editor.document.getText(), "()");
		assert.equal(editor.document.offsetAt(editor.selection.active), 1);
		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		assert.equal(editor.document.offsetAt(editor.selection.active), 2);
	});

	test("preserves the upstream parn text with unequal repeated defaults", async () => {
		const editor = await openEditor("markdown", "$$", 1);
		await typeCharacters("parn");
		await waitFor(() => editor.document.getText().includes("\\partial"));
		assert.equal(editor.document.getText(), "$\\frac{ \\partial^{n} y }{ \\partial x^{n} }$");
		assert.equal(editor.document.getText(editor.selection), "n");
		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		assert.equal(editor.document.getText(editor.selection), "y");
		await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
		assert.equal(editor.document.getText(editor.selection), "x");
	});

	test("auto-fraction inside brackets triggers bracket enlargement", async () => {
		const editor = await openEditor("markdown", "$(x+1)$", 5);
		await typeCharacters("/");
		await waitFor(() => editor.document.getText().includes("\\frac{1}{}"));
		assert.equal(editor.document.getText(), "$\\left( x+\\frac{1}{} \\right)$");
	});

	test("visual expansion preserves multiline blockquote prefixes", async () => {
		const source = "> $x +\n> y$";
		const editor = await openEditor("markdown", source, 3);
		const start = source.indexOf("x");
		const end = source.indexOf("y") + 1;
		editor.selection = new vscode.Selection(
			editor.document.positionAt(start),
			editor.document.positionAt(end),
		);
		await typeCharacters("S");
		await waitFor(() => editor.document.getText().includes("\\sqrt"));
		assert.equal(editor.document.getText(), "> $\\sqrt{ x +\n> y }$");
	});

	test("visual bracket triggers work through VS Code auto-surround", async () => {
		for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
			const editor = await openEditor("markdown", "$xy$", 3);
			editor.selection = new vscode.Selection(
				editor.document.positionAt(1),
				editor.document.positionAt(3),
			);
			await typeCharacters(open);
			await waitFor(() => editor.document.getText() === `$${open}xy${close}$`);
			assert.equal(editor.document.getText(editor.selection), `${open}xy${close}`);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});

	test("matrix row insertion leaves Tab ready for the next cell", async () => {
		const source = "$$\n\\begin{pmatrix}\na\n\\end{pmatrix}\n$$";
		const editor = await openEditor("markdown", source, source.indexOf("a\n") + 1);
		assert.equal(await vscode.commands.executeCommand("latexSuite.matrixNewline"), true);
		assert.equal(editor.selection.isEmpty, true);
		await vscode.commands.executeCommand("latexSuite.tab");
		assert.ok(normalizeEol(editor.document.getText()).includes("a \\\\\n & \n\\end{pmatrix}"));
	});

	test("matrix newline preserves indentation exactly once", async () => {
		const source = "\\[\n    \\begin{pmatrix}\n    a\n    \\end{pmatrix}\n\\]";
		const cursor = source.indexOf("\n    a") + "\n    a".length;
		const editor = await openEditor("latex", source, cursor);
		assert.equal(await vscode.commands.executeCommand("latexSuite.matrixNewline"), true);
		assert.ok(normalizeEol(editor.document.getText()).includes("    a \\\\\n    \n    \\end{pmatrix}"));
	});

	test("single-line matrix newline leaves Tab ready for a cell", async () => {
		const source = "$\\begin{pmatrix}a\\end{pmatrix}$";
		const editor = await openEditor("markdown", source, source.indexOf("a\\end") + 1);
		assert.equal(await vscode.commands.executeCommand("latexSuite.matrixNewline"), true);
		await vscode.commands.executeCommand("latexSuite.tab");
		assert.equal(editor.document.getText(), "$\\begin{pmatrix}a \\\\   & \\end{pmatrix}$");
	});

	test("matrix commands leave a nonempty selection untouched", async () => {
		const source = "$\\begin{pmatrix}xy\\end{pmatrix}$";
		const contentStart = source.indexOf("xy");
		const editor = await openEditor("markdown", source, contentStart + 1);
		editor.selection = new vscode.Selection(
			editor.document.positionAt(contentStart),
			editor.document.positionAt(contentStart + 2),
		);
		for (const command of ["latexSuite.matrixCell", "latexSuite.matrixNewline", "latexSuite.matrixExit"]) {
			assert.equal(await vscode.commands.executeCommand(command), false);
			assert.equal(editor.document.getText(), source);
			assert.equal(editor.document.getText(editor.selection), "xy");
		}
	});

	test("public matrix commands are no-ops outside a matrix", async () => {
		const source = "plain text";
		const editor = await openEditor("markdown", source, source.length);
		for (const command of ["latexSuite.matrixNewline", "latexSuite.matrixExit"]) {
			assert.equal(await vscode.commands.executeCommand(command), false);
			assert.equal(editor.document.getText(), source);
			assert.equal(editor.document.offsetAt(editor.selection.active), source.length);
		}
	});

	test("stale matrix keybinding commands fall back to a newline", async () => {
		for (const command of ["latexSuite.internal.matrixNewline", "latexSuite.internal.matrixExit"]) {
			const editor = await openEditor("markdown", "plain", 5);
			assert.equal(await vscode.commands.executeCommand(command), false);
			assert.equal(normalizeEol(editor.document.getText()), "plain\n");
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});

	test("contextual Tab uses the normal editor action while disabled", async () => {
		await setExtensionSetting("enabled", false);
		try {
			const expectedEditor = await openEditor("markdown", "ordinary", 0);
			await vscode.commands.executeCommand("tab");
			const expectedText = expectedEditor.document.getText();
			const expectedOffset = expectedEditor.document.offsetAt(expectedEditor.selection.active);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

			const actualEditor = await openEditor("markdown", "ordinary", 0);
			await vscode.commands.executeCommand("latexSuite.tab");
			assert.equal(actualEditor.document.getText(), expectedText);
			assert.equal(actualEditor.document.offsetAt(actualEditor.selection.active), expectedOffset);
		} finally {
			await setExtensionSetting("enabled", undefined);
		}
	});

	test("does not expand simultaneous cursors", async () => {
		const editor = await openEditor("markdown", "$@a @a$", 3);
		editor.selections = [
			new vscode.Selection(new vscode.Position(0, 3), new vscode.Position(0, 3)),
			new vscode.Selection(new vscode.Position(0, 6), new vscode.Position(0, 6)),
		];
		const before = editor.document.getText();
		const expanded = await vscode.commands.executeCommand<boolean>("latexSuite.expandSnippet");
		assert.equal(expanded, false);
		assert.equal(editor.document.getText(), before);
	});

	suite("snippet module loader", () => {
		setup(async () => {
			await setSnippetLoaderSetting("snippets.files", []);
			await setSnippetLoaderSetting("snippets.variableFiles", []);
			await setSnippetLoaderSetting("snippets.variablesSource", "");
		});

		teardown(async () => {
			await resetSnippetLoaderSettings();
		});

		test("ignores export-default text in non-code lexical regions", async () => {
			await setSnippetSource(`
				const stringDecoy = "export default";
				const templateDecoy = \`export default\`;
				const regexDecoy = /export\\s+default/;
				if (false) /export default/.test("");
				// export default [{ trigger: "wrong" }]
				/* export default [{ trigger: "also-wrong" }] */
				module.exports = [{
					trigger: "lexical",
					replacement: "ok",
					options: "t",
				}];
			`);
			const editor = await openEditor("markdown", "lexical", "lexical".length);
			assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
			assert.equal(editor.document.getText(), "ok");
		});

		test("accepts CommonJS, default-export, and bare-expression sources", async () => {
			const formats = [
				[`module.exports = [{ trigger: "fmt", replacement: "commonjs", options: "t" }];`, "commonjs"],
				[`exports.default = [{ trigger: "fmt", replacement: "default", options: "t" }];`, "default"],
				[`export default [{ trigger: "fmt", replacement: "export", options: "t" }];`, "export"],
				[`[{ trigger: "fmt", replacement: "bare", options: "t" }];`, "bare"],
			] as const;
			for (const [source, expected] of formats) {
				await setSnippetSource(source);
				const editor = await openEditor("markdown", "fmt", 3);
				assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
				assert.equal(editor.document.getText(), expected);
			}
		});

		test("loads an unchanged-style snippet file in Markdown and LaTeX", async () => {
			const fixture = vscode.Uri.file(path.resolve(
				__dirname,
				"../../src/test/fixtures/representative-snippets.js",
			));
			await setSnippetLoaderSetting("snippets.files", [fixture.fsPath]);

			const markdown = await openEditor("markdown", "$xha$", 4);
			await typeCharacters("t");
			await waitFor(() => markdown.document.getText() === "$\\hat{x}$");
			assert.equal(markdown.document.getText(), "$\\hat{x}$");

			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			const latexSource = "\\begin{align}23su\\end{align}";
			const latex = await openEditor("latex", latexSource, latexSource.indexOf("\\end"));
			await typeCharacters("m");
			await waitFor(() => latex.document.getText().includes("\\sum_{2}^{3}"));
			assert.equal(latex.document.getText(), "\\begin{align}\\sum_{2}^{3} \\end{align}");
		});

		test("executes a bare expression exactly once", async () => {
			const counterKey = `__latexSuiteLoaderCounter${Date.now()}${Math.random()}`;
			const globals = globalThis as typeof globalThis & Record<string, unknown>;
			globals[counterKey] = 0;
			try {
				await setSnippetSource(`(++globalThis[${JSON.stringify(counterKey)}], [{
					trigger: "once",
					replacement: () => String(globalThis[${JSON.stringify(counterKey)}]),
					options: "t",
				}]);`);
				const editor = await openEditor("markdown", "once", 4);
				assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
				assert.equal(editor.document.getText(), "1");
				assert.equal(globals[counterKey], 1);
			} finally {
				delete globals[counterKey];
			}
		});

		test("loads bare variable objects and exposes common read-only editor APIs", async () => {
			await setSnippetLoaderSetting("snippets.variablesSource", `{ TOKEN: "probe" }`);
			await setSnippetSource(`[{
				trigger: "\${TOKEN}",
				options: "t",
				replacement: (_match, { view }) => {
					const line = view.state.doc.lineAt(view.state.selection.main.head);
					return line.text + ":" + line.number + ":" + view.state.doc.lines;
				},
			}]`);
			const editor = await openEditor("markdown", "first\nprobe", "first\nprobe".length);
			assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
			assert.equal(normalizeEol(editor.document.getText()), "first\nprobe:2:2");
		});

		test("automatically expands End using a quoted operator-name variable", async () => {
			await setSnippetLoaderSetting("snippets.variablesSource", `{
				"\${GREEK}": "alpha|beta",
				"\${OPERATORNAMES}": "End|Hom|Aut|Mat|wt|GL|char|Pic|disc|trd"
			}`);
			await setSnippetSource(`[{
				trigger: "(\${OPERATORNAMES})",
				replacement: "\\\\operatorname{[[0]]}",
				options: "rmA"
			}]`);
			const editor = await openEditor("markdown", "$$", 1);
			await typeCharacters("End");
			await waitFor(() => editor.document.getText() === "$\\operatorname{End}$");
			assert.equal(editor.document.getText(), "$\\operatorname{End}$");
		});

		test("triggerKey copies do not consume an automatic text trigger", async () => {
			await setSnippetSource(`[{
				trigger: "foo",
				triggerKey: "Ctrl-a",
				replacement: "X",
				options: "tA",
			}]`);
			const editor = await openEditor("markdown", "foo", 3);
			assert.equal(
				await vscode.commands.executeCommand("latexSuite.expandSnippetByKey", "Ctrl-a"),
				true,
			);
			assert.equal(editor.document.getText(), "fooX");
		});

		test("implements normal and U automatic-snippet undo behavior", async () => {
			await setSnippetSource(`[
				{ trigger: "n", replacement: "NORMAL", options: "tA" },
				{ trigger: "u", replacement: "SKIP", options: "tAU" },
			]`);
			const normal = await openEditor("markdown", "", 0);
			await typeCharacters("an");
			await waitFor(() => normal.document.getText() === "aNORMAL");
			await vscode.commands.executeCommand("undo");
			assert.equal(normal.document.getText(), "an");

			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			const skip = await openEditor("markdown", "", 0);
			await typeCharacters("au");
			await waitFor(() => skip.document.getText() === "aSKIP");
			await vscode.commands.executeCommand("undo");
			assert.equal(skip.document.getText(), "a");
		});

		test("groups recursive automatic expansions into the first expansion undo step", async () => {
			await setExtensionSetting("snippets.recursionLimit", 1);
			await setSnippetSource(`[
				{ trigger: "a", replacement: "\\\\frac{}{}b", options: "mA" },
				{ trigger: "b", replacement: "c", options: "mA" },
			]`);
			try {
				const editor = await openEditor("markdown", "$(+z)$", 2);
				await typeCharacters("a");
				const expanded = "$\\left( \\frac{}{}c+z \\right)$";
				await waitFor(() => editor.document.getText() === expanded);
				await typeCharacters("x");
				assert.equal(editor.document.getText(), "$\\left( \\frac{}{}cx+z \\right)$");
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), expanded, "later typing must start a new undo group");
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), "$(a+z)$");
			} finally {
				await setExtensionSetting("snippets.recursionLimit", undefined);
			}
		});

		test("keeps a zero-width U-regex trigger and its insertion in one undo step", async () => {
			await setSnippetSource(`[{
				trigger: /(?<=z)/,
				replacement: "!",
				options: "trAU",
			}]`);
			const editor = await openEditor("markdown", "a", 1);
			await typeCharacters("z");
			await waitFor(() => editor.document.getText() === "az!");
			assert.equal(editor.document.getText(), "az!", "a zero-width match must not consume the typed key");

			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), "a", "U should undo the typed key and expansion together");
		});

		test("loads programmable snippet nodes and visits their native placeholders", async () => {
			await setSnippetSource(`
				const { snippet_node, tabstop_node } = require("latex-suite");
				module.exports = [{
					trigger: "nodes",
					options: "t",
					replacement: () => [
						snippet_node("\\\\frac{\${0:numerator}}{"),
						tabstop_node(1, "denominator"),
						snippet_node("} + \${2:tail}$3"),
					],
				}];
			`);
			const editor = await openEditor("markdown", "nodes", 5);
			assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
			assert.equal(editor.document.getText(), "\\frac{numerator}{denominator} + tail");
			assert.equal(editor.document.getText(editor.selection), "numerator");

			await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
			assert.equal(editor.document.getText(editor.selection), "denominator");
			await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
			assert.equal(editor.document.getText(editor.selection), "tail");
			await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
			assert.equal(editor.selection.isEmpty, true);
			assert.equal(editor.document.offsetAt(editor.selection.active), editor.document.getText().length);
		});

		test("does not apply a stale asynchronous manual expansion after the cursor moves", async () => {
			const snippetFile = vscode.Uri.file(path.join(
				tmpdir(),
				`latex-suite-stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.js`,
			));
			await vscode.workspace.fs.writeFile(
				snippetFile,
				new TextEncoder().encode(`module.exports = [{
					trigger: "stale",
					replacement: "EXPANDED",
					options: "t",
				}];`),
			);
			try {
				await setSnippetSource("");
				await setSnippetLoaderSetting("snippets.files", [snippetFile.fsPath]);
				const source = "stale elsewhere";
				const editor = await openEditor("markdown", source, "stale".length);
				const expansion = vscode.commands.executeCommand<boolean>("latexSuite.expandSnippet");
				const moved = editor.document.positionAt(source.length);
				editor.selection = new vscode.Selection(moved, moved);

				assert.equal(await expansion, false);
				assert.equal(editor.document.getText(), source);
				assert.equal(editor.document.offsetAt(editor.selection.active), source.length);
			} finally {
				await vscode.workspace.fs.delete(snippetFile);
			}
		});

		test("does not consume a pre-existing closer when editor auto-closing is disabled", async () => {
			await setSnippetSource(`[{
				trigger: "(",
				replacement: "($0)$1",
				options: "tA",
			}]`);
			const editorConfiguration = vscode.workspace.getConfiguration("editor");
			const previousGlobalValue = editorConfiguration.inspect<string>("autoClosingBrackets")?.globalValue;
			await editorConfiguration.update(
				"autoClosingBrackets",
				"never",
				vscode.ConfigurationTarget.Global,
			);
			try {
				const editor = await openEditor("markdown", ")", 0);
				await typeCharacters("(");
				await waitFor(() => editor.document.getText() === "())");
				assert.equal(editor.document.getText(), "())");
				assert.equal(editor.document.offsetAt(editor.selection.active), 1);
			} finally {
				await editorConfiguration.update(
					"autoClosingBrackets",
					previousGlobalValue,
					vscode.ConfigurationTarget.Global,
				);
			}
		});

		test("custom automatic U quote triggers consume VS Code's synthetic closer", async () => {
			await setSnippetSource(`[{
				trigger: '"',
				replacement: "quoted<$0>$1",
				options: "tAU",
			}]`);
			const editorConfiguration = vscode.workspace.getConfiguration("editor");
			const previousGlobalValue = editorConfiguration.inspect<string>("autoClosingQuotes")?.globalValue;
			await editorConfiguration.update(
				"autoClosingQuotes",
				"always",
				vscode.ConfigurationTarget.Global,
			);
			try {
				const editor = await openEditor("markdown", "", 0);
				await typeCharacters('"');
				await waitFor(() => editor.document.getText() === "quoted<>");

				assert.equal(editor.document.getText(), "quoted<>");
				assert.equal(editor.document.offsetAt(editor.selection.active), "quoted<".length);
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), "");
			} finally {
				await editorConfiguration.update(
					"autoClosingQuotes",
					previousGlobalValue,
					vscode.ConfigurationTarget.Global,
				);
			}
		});

		test("keeps CRLF multiline replacements aligned with bracket enlargement", async () => {
			await setSnippetSource(`[{
				trigger: "crlf",
				replacement: "\\\\frac{\${0:x}}{\${1:y}}\\r\\n+ \\\\sum_{\${2:i}}$3",
				options: "m",
			}]`);
			const source = "$$\r\n(\r\ncrlf\r\n)\r\n$$";
			const documentFile = vscode.Uri.file(path.join(
				tmpdir(),
				`latex-suite-crlf-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
			));
			await vscode.workspace.fs.writeFile(documentFile, new TextEncoder().encode(source));
			try {
				const document = await vscode.workspace.openTextDocument(documentFile);
				const editor = await vscode.window.showTextDocument(document);
				const cursor = document.positionAt(source.indexOf("crlf") + "crlf".length);
				editor.selection = new vscode.Selection(cursor, cursor);
				assert.equal(document.eol, vscode.EndOfLine.CRLF);
				assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
				assert.equal(document.eol, vscode.EndOfLine.CRLF);
				const expandedSource =
					"$$\r\n\\left( \r\n\\frac{x}{y}\r\n+ \\sum_{i}\r\n \\right)\r\n$$";
				assert.equal(
					document.getText(),
					expandedSource,
				);
				assert.equal(document.getText(editor.selection), "x");

				await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
				assert.equal(document.getText(editor.selection), "y");
				await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
				assert.equal(document.getText(editor.selection), "i");
				await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
				assert.equal(editor.selection.isEmpty, true);
				assert.equal(
					document.offsetAt(editor.selection.active),
					expandedSource.indexOf("\r\n \\right)"),
				);

				await vscode.commands.executeCommand("undo");
				assert.equal(document.getText(), source);
			} finally {
				await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
				await vscode.workspace.fs.delete(documentFile);
			}
		});

		test("isolates ALL_MACROS mutations between cache reloads", async () => {
			await setSnippetSource(`
				const suite = require("latex-suite");
				suite.ALL_MACROS.push("__loader_test_macro__");
				module.exports = [{
					trigger: "probe",
					replacement: () => String(suite.ALL_MACROS.filter((name) => name === "__loader_test_macro__").length),
					options: "t",
				}];
			`);
			const first = await openEditor("markdown", "probe", 5);
			assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
			assert.equal(first.document.getText(), "1");

			await vscode.commands.executeCommand("latexSuite.reloadSnippets");
			const second = await openEditor("markdown", "probe", 5);
			assert.equal(await vscode.commands.executeCommand("latexSuite.expandSnippet"), true);
			assert.equal(second.document.getText(), "1");
		});
	});
});

async function setSnippetLoaderSetting(section: string, value: unknown): Promise<void> {
	await setExtensionSetting(section, value);
}

async function setExtensionSetting(section: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration("latexSuite").update(
		section,
		value,
		vscode.ConfigurationTarget.Global,
	);
}

async function setSnippetSource(source: string): Promise<void> {
	await setSnippetLoaderSetting("snippets.source", source);
}

async function resetSnippetLoaderSettings(): Promise<void> {
	for (const setting of ["snippets.files", "snippets.variableFiles", "snippets.variablesSource", "snippets.source"]) {
		await setSnippetLoaderSetting(setting, undefined);
	}
}

async function openEditor(language: "markdown" | "latex", content: string, offset: number): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument({ language, content });
	const editor = await vscode.window.showTextDocument(document);
	const position = document.positionAt(offset);
	editor.selection = new vscode.Selection(position, position);
	return editor;
}

async function typeCharacters(value: string): Promise<void> {
	for (const character of value) {
		await vscode.commands.executeCommand("type", { text: character });
		await waitForExtensionIdle();
	}
}

async function waitForExtensionIdle(): Promise<void> {
	await vscode.commands.executeCommand("latexSuite.internal.waitForIdle");
}

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout) {
			const text = vscode.window.activeTextEditor?.document.getText();
			throw new Error(`Timed out waiting for editor state; text was ${JSON.stringify(text)}`);
		}
		await delay(20);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeEol(value: string): string {
	return value.replaceAll("\r\n", "\n");
}
