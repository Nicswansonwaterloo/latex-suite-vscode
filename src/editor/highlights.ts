import * as vscode from "vscode";
import { getConfig, isSupportedDocument, type LatexSuiteConfig } from "../config";
import type { OffsetRange, ParsedContext } from "../core/context";
import { MathHighlightIndex, matchingBrackets } from "../core/highlights";

export function registerMathHighlights(
	parse: (source: string, document: vscode.TextDocument, config: LatexSuiteConfig) => ParsedContext,
	decorate: (editor: vscode.TextEditor, style: vscode.TextEditorDecorationType, ranges: vscode.Range[]) => void =
		(editor, style, ranges) => editor.setDecorations(style, ranges),
): vscode.Disposable {
	const foreground = (id: string) => vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor(id),
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});
	const depths = [1, 2, 3].map(level => foreground(`editorBracketHighlight.foreground${level}`));
	const unmatched = foreground("editorBracketHighlight.unexpectedBracket.foreground");
	const delimiters = {
		inlineMath: foreground("latexSuite.inlineMathDelimiter"),
		blockMath: foreground("latexSuite.blockMathDelimiter"),
		codeMath: foreground("latexSuite.mathFenceDelimiter"),
		unmatched,
	};
	const cursorPair = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor("editorBracketMatch.background"),
		border: "1px solid",
		borderColor: new vscode.ThemeColor("editorBracketMatch.border"),
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	const indexes = new WeakMap<ParsedContext, MathHighlightIndex>();
	interface EditorState {
		timer?: NodeJS.Timeout;
		cursorIndex?: MathHighlightIndex;
		applied: Set<vscode.TextEditorDecorationType>;
	}
	const states = new Map<vscode.TextEditor, EditorState>();
	const hiddenStyles = new WeakMap<vscode.TextEditor, Set<vscode.TextEditorDecorationType>>();
	function range(document: vscode.TextDocument, offsets: OffsetRange): vscode.Range {
		return new vscode.Range(document.positionAt(offsets.start), document.positionAt(offsets.end));
	}

	function apply(editor: vscode.TextEditor, state: EditorState, style: vscode.TextEditorDecorationType, ranges: vscode.Range[]) {
		if (ranges.length) {
			decorate(editor, style, ranges);
			state.applied.add(style);
		} else if (state.applied.delete(style)) {
			decorate(editor, style, []);
		}
	}

	function drawCursor(editor: vscode.TextEditor, state: EditorState) {
		const ranges: vscode.Range[] = [];
		if (state.cursorIndex) {
			const seen = new Set<number>();
			for (const selection of editor.selections) {
				if (!selection.isEmpty) { continue; }
				const offset = editor.document.offsetAt(selection.active);
				const nearby = state.cursorIndex.bracketsIn(offset - 1, offset + 1);
				for (const mark of matchingBrackets(nearby, offset)) {
					if (!seen.has(mark.start)) {
						seen.add(mark.start);
						ranges.push(range(editor.document, mark));
					}
				}
			}
		}
		apply(editor, state, cursorPair, ranges);
	}

	function draw(editor: vscode.TextEditor, state: EditorState) {
		const groups = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
		function add(style: vscode.TextEditorDecorationType, mark: OffsetRange) {
			const ranges = groups.get(style) ?? [];
			ranges.push(range(editor.document, mark));
			groups.set(style, ranges);
		}

		const document = editor.document;
		const config = getConfig(document);
		const { bracketPairs, matchingBracket, mathDelimiters } = config.highlighting;
		state.cursorIndex = undefined;
		if (config.enabled && isSupportedDocument(document) && (bracketPairs || matchingBracket || mathDelimiters)) {
			const source = document.getText();
			const parsed = parse(source, document, config);
			const index = indexes.get(parsed) ?? new MathHighlightIndex(source, parsed);
			indexes.set(parsed, index);
			if (matchingBracket) { state.cursorIndex = index; }
			for (const visible of editor.visibleRanges) {
				const start = document.offsetAt(visible.start);
				const end = document.offsetAt(visible.end);
				if (bracketPairs) {
					for (const bracket of index.bracketsIn(start, end)) {
						add(bracket.mate ? depths[bracket.depth % depths.length] : unmatched, bracket);
					}
				}
				if (mathDelimiters) {
					for (const delimiter of index.delimitersIn(start, end)) {
						add(delimiters[delimiter.kind], delimiter);
					}
				}
			}
		}
		for (const style of [...depths, ...Object.values(delimiters)]) {
			apply(editor, state, style, groups.get(style) ?? []);
		}
		drawCursor(editor, state);
	}

	function schedule(editor: vscode.TextEditor) {
		const state = states.get(editor);
		if (!state) { return; }
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			draw(editor, state);
		}, 65);
	}

	function syncVisible(editors: readonly vscode.TextEditor[]) {
		for (const [editor, state] of states) {
			if (!editors.includes(editor)) {
				clearTimeout(state.timer);
				hiddenStyles.set(editor, state.applied);
				states.delete(editor);
			}
		}
		for (const editor of editors) {
			if (!states.has(editor)) {
				states.set(editor, { applied: hiddenStyles.get(editor) ?? new Set() });
				schedule(editor);
			}
		}
	}

	syncVisible(vscode.window.visibleTextEditors);
	return vscode.Disposable.from(
		...depths, ...Object.values(delimiters), cursorPair,
		vscode.window.onDidChangeVisibleTextEditors(syncVisible),
		vscode.window.onDidChangeTextEditorVisibleRanges(event => schedule(event.textEditor)),
		vscode.workspace.onDidChangeTextDocument(event => {
			if (!event.contentChanges.length) { return; }
			for (const editor of states.keys()) {
				if (editor.document === event.document) { schedule(editor); }
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			for (const editor of states.keys()) {
				if (event.affectsConfiguration("latexSuite", editor.document)) { schedule(editor); }
			}
		}),
		vscode.window.onDidChangeTextEditorSelection(event => {
			const state = states.get(event.textEditor);
			if (state && !state.timer) { drawCursor(event.textEditor, state); }
		}),
		new vscode.Disposable(() => {
			for (const state of states.values()) { clearTimeout(state.timer); }
			states.clear();
		}),
	);
}
