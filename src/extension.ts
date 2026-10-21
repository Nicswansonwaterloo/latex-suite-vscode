import {
	createFunctionAdapter,
	trimReplacement,
	firstTabstopByIndex,
	normalizeReplacementEol,
	type VisualSelectionInfo,
	type EditorSelectionSnapshot,
	captureSelection,
	selectionMatches,
	selectionBoundsMatch,
	type VisualTypingOperation,
	type AutoClosedPairOperation,
	type TypedChangeUndoBase,
	type AutomaticExpansionOptions,
	mapSelectionAcrossChange,
	replaceTextRange,
	applyTextEdits,
	mapSelectionAcrossTextEdits,
	mapPlanAcrossRestoredChange,
	mapAutoClosedPairAcrossRestoredChange,
	isCollapsedAt,
	detectAutoClosePair,
	detectAutoSurround,
	detectVisualTyping,
	parseVisualSelection,
	getLinePrefix,
	preserveLinePrefix,
	setCursor,
	isRecord,
	errorDetail,
} from "./editor/edits";
import * as path from "node:path";
import * as vscode from "vscode";
import { getConfig, isSupportedDocument, type LatexSuiteConfig } from "./config";
import { parseContext, scanContext, type ParsedContext, type CursorContext } from "./core/context";
import {
	findTabOutTarget,
	findUnenclosedClosingTarget,
	getMatrixScope,
	matrixExitTarget,
	planAutoFraction,
	planBracketEnlargements,
	planMatrixCell,
	planMatrixNewline,
	type EditPlan,
	type TextEditPlan,
} from "./core/features";
import type { ResultInsert } from "./core/nodes";
import {
	canMatchAnySnippetTrigger,
	matchFirstSnippet,
	parseKeyName,
	type MatchContext,
	type SnippetMatch,
} from "./core/snippets";
import { toVscodeSnippet } from "./core/vscodeSnippet";
import {
	SnippetRepository,
	type SnippetBundle,
	type SnippetFunctionAdapter,
} from "./snippetRepository";

interface EditOptions {
	visualSelection?: VisualSelectionInfo;
	preserveTriggerOnUndo?: boolean;
	undoBase?: TypedChangeUndoBase;
	autoClosedPair?: AutoClosedPairOperation;
	undoStopAfter?: boolean;
}

const EXTENSION_ID = "qmvis.latex-suite-vscode";

export function activate(extensionContext: vscode.ExtensionContext): vscode.Disposable {
	const output = vscode.window.createOutputChannel("LaTeX Suite", { log: true });
	const controller = new LatexSuiteController(output);
	extensionContext.subscriptions.push(output, controller);
	return controller;
}

export function deactivate(): void {
	// All resources are owned by the extension context subscriptions.
}

export class LatexSuiteController implements vscode.Disposable {
	private readonly repository: SnippetRepository;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly documentSnapshots = new Map<string, { version: number; text: string }>();
	private readonly editorSelections = new Map<string, { version: number; selection: EditorSelectionSnapshot }>();
	private readonly documentChangeTasks = new Set<Promise<void>>();
	private readonly mutatingDocuments = new Set<string>();
	private lastScan: {
		document: vscode.TextDocument;
		version: number;
		source: string;
		mathFenceLanguages: string;
		context: ParsedContext;
	} | undefined;
	private configurationGeneration = 0;
	private readonly shutdown = new vscode.CancellationTokenSource();
	private disposed = false;
	private warnedAboutTrust = false;

	constructor(private readonly output: vscode.LogOutputChannel) {
		this.repository = new SnippetRepository(output);
		for (const document of vscode.workspace.textDocuments) {
			this.rememberDocument(document);
		}
		if (vscode.window.activeTextEditor) {
			this.rememberEditorSelection(vscode.window.activeTextEditor);
		}

		this.disposables.push(
			this.repository,
			vscode.workspace.onDidOpenTextDocument((document) => this.rememberDocument(document)),
			vscode.workspace.onDidCloseTextDocument((document) => {
				const key = document.uri.toString();
				this.documentSnapshots.delete(key);
				this.editorSelections.delete(key);
				if (this.lastScan?.document === document) {
					this.lastScan = undefined;
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => this.handleDocumentChange(event)),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.rememberEditorSelection(editor);
				}
				void this.refreshContextKeys();
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				this.rememberEditorSelection(event.textEditor);
				void this.refreshContextKeys();
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("latexSuite")) {
					this.configurationGeneration += 1;
					this.documentSnapshots.clear();
					this.editorSelections.clear();
					for (const document of vscode.workspace.textDocuments) {
						this.rememberDocument(document);
					}
					if (vscode.window.activeTextEditor) {
						this.rememberEditorSelection(vscode.window.activeTextEditor);
					}
					void this.refreshContextKeys();
				}
			}),
			vscode.commands.registerCommand("latexSuite.expandSnippet", () => this.expandSnippet()),
			vscode.commands.registerCommand("latexSuite.expandSnippetByKey", (argument?: unknown) => this.expandSnippetByKey(argument)),
			vscode.commands.registerCommand("latexSuite.autoFraction", () => this.runAutoFractionCommand()),
			vscode.commands.registerCommand("latexSuite.nextBracketOrEquation", () => this.navigateBracketOrEquation()),
			vscode.commands.registerCommand("latexSuite.matrixCell", () => this.insertMatrixCell()),
			vscode.commands.registerCommand("latexSuite.matrixNewline", () => this.insertMatrixNewline()),
			vscode.commands.registerCommand("latexSuite.matrixExit", () => this.exitMatrix()),
			vscode.commands.registerCommand("latexSuite.internal.matrixNewline", () => this.insertMatrixNewlineFromKeybinding()),
			vscode.commands.registerCommand("latexSuite.internal.matrixExit", () => this.exitMatrixFromKeybinding()),
			vscode.commands.registerCommand("latexSuite.internal.waitForIdle", () => this.waitForDocumentChanges()),
			vscode.commands.registerCommand("latexSuite.tab", () => this.runContextualTab()),
			vscode.commands.registerCommand("latexSuite.reloadSnippets", () => this.reloadSnippets()),
			vscode.commands.registerCommand("latexSuite.addSnippetFile", () => this.addSourceFile("snippets.files")),
			vscode.commands.registerCommand("latexSuite.addVariableFile", () => this.addSourceFile("snippets.variableFiles")),
			vscode.commands.registerCommand("latexSuite.toggleEnabled", () => this.toggleEnabled()),
			vscode.commands.registerCommand("latexSuite.openSettings", () =>
				vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID}`),
			),
		);
		void this.refreshContextKeys();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.configurationGeneration += 1;
		this.shutdown.cancel();
		this.shutdown.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.documentSnapshots.clear();
		this.editorSelections.clear();
		this.documentChangeTasks.clear();
		this.mutatingDocuments.clear();
		this.lastScan = undefined;
		void this.refreshContextKeys();
	}

	private rememberDocument(document: vscode.TextDocument): void {
		if (isSupportedDocument(document)) {
			this.documentSnapshots.set(document.uri.toString(), {
				version: document.version,
				text: document.getText(),
			});
		}
	}

	private rememberEditorSelection(editor: vscode.TextEditor): void {
		if (isSupportedDocument(editor.document) && editor.selections.length === 1) {
			this.editorSelections.set(editor.document.uri.toString(), {
				version: editor.document.version,
				selection: captureSelection(editor),
			});
		}
	}

	private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		const task = this.runDocumentChange(event);
		this.documentChangeTasks.add(task);
		void task.then(() => {
			this.documentChangeTasks.delete(task);
		});
	}

	private async runDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
		try {
			await this.onDocumentChange(event);
		} catch (error) {
			this.reportAsyncFailure("Document-change handling failed", error);
			try {
				await this.refreshContextKeys();
			} catch (refreshError) {
				this.reportAsyncFailure(
					"Context refresh after document-change failure failed",
					refreshError,
				);
			}
		}
	}

	private reportAsyncFailure(message: string, error: unknown): void {
		try {
			this.output.error(`${message}: ${errorDetail(error)}`);
		} catch {
			// The output channel may already be disposed during extension shutdown.
		}
	}

	private async waitForDocumentChanges(): Promise<void> {
		while (this.documentChangeTasks.size > 0) {
			await Promise.all([...this.documentChangeTasks]);
		}
	}

	private async onDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const document = event.document;
		if (!isSupportedDocument(document)) {
			return;
		}
		const key = document.uri.toString();
		const previous = this.documentSnapshots.get(key);
		const currentText = document.getText();
		this.documentSnapshots.set(key, { version: document.version, text: currentText });

		if (this.mutatingDocuments.has(key)) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (
			!editor ||
			editor.document !== document ||
			editor.selections.length !== 1 ||
			event.reason !== undefined
		) {
			void this.refreshContextKeys();
			return;
		}
		const previousSelection = this.editorSelections.get(key);
		const surroundCandidate = previous
			? detectAutoSurround(event.contentChanges, previous.text)
			: null;
		const surroundedSelection = surroundCandidate &&
			previous &&
			previousSelection?.version === previous.version &&
			selectionBoundsMatch(previousSelection.selection, surroundCandidate.oldStart, surroundCandidate.oldEnd)
			? surroundCandidate
			: null;
		const previousText = previous?.text;
		if (surroundedSelection && previousText !== undefined) {
			const config = getConfig(document);
			const expectedConfiguration = this.configurationGeneration;
			const expectedVersion = document.version;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (
				expectedConfiguration !== this.configurationGeneration ||
				!config.enabled ||
				!config.snippets.enabled ||
				editor.document.version !== expectedVersion ||
				vscode.window.activeTextEditor !== editor
			) {
				void this.refreshContextKeys();
				return;
			}
			const expectedSelection = captureSelection(editor);
			const expanded = await this.tryVisualExpansion(
				editor,
				previousText,
				config,
				expectedVersion,
				expectedConfiguration,
				surroundedSelection,
				expectedSelection,
				previousSelection?.selection,
			);
			if (expanded) {
				await this.runRecursiveExpansions(editor, config.snippets.recursionLimit > 0);
			}
			void this.refreshContextKeys();
			return;
		}
		const autoClosedPair = previousText === undefined
			? null
			: detectAutoClosePair(event.contentChanges, previousText);
		if (autoClosedPair) {
			const config = getConfig(document);
			const expectedConfiguration = this.configurationGeneration;
			const expectedVersion = document.version;
			if (
				expectedConfiguration !== this.configurationGeneration ||
				!config.enabled ||
				!config.snippets.enabled ||
				!await this.waitForCollapsedSelection(editor, expectedVersion, autoClosedPair.cursor)
			) {
				void this.refreshContextKeys();
				return;
			}
			// VS Code publishes the opening-character edit before its auto-closing
			// service has necessarily materialized the matching delimiter.
			const settlement = await this.waitForAutoCloseSettlement(
				editor,
				autoClosedPair,
				expectedConfiguration,
			);
			if (!settlement) {
				void this.refreshContextKeys();
				return;
			}
			const settledVersion = settlement.version;
			this.rememberDocument(document);
			const materializedPair = settlement.materializedPair;
			const expanded = await this.tryAutomaticExpansion(
				editor,
				autoClosedPair.cursor,
				config,
				settledVersion,
				captureSelection(editor),
				expectedConfiguration,
				{
					autoClosedPair: materializedPair ?? autoClosedPair,
					undoBase: {
						currentStart: autoClosedPair.currentStart,
						currentEnd: materializedPair?.currentEnd ?? autoClosedPair.cursor,
						previousText: previousText!.slice(
							autoClosedPair.currentStart,
							autoClosedPair.currentStart,
						),
					},
				},
			);
			if (expanded) {
				await this.runRecursiveExpansions(editor, config.snippets.recursionLimit > 0);
			}
			void this.refreshContextKeys();
			return;
		}
		if (event.contentChanges.length !== 1) {
			void this.refreshContextKeys();
			return;
		}
		const change = event.contentChanges[0];
		const visualTyping = change.rangeLength > 0 && previous
			? detectVisualTyping(change, previous.text)
			: null;
		const isSingleCharacter = !change.text.includes("\n") &&
			!change.text.includes("\r") &&
			Array.from(change.text).length === 1;
		if (!isSingleCharacter && !visualTyping) {
			void this.refreshContextKeys();
			return;
		}
		const expectedCursor = change.rangeOffset + change.text.length;

		const config = getConfig(document);
		const expectedConfiguration = this.configurationGeneration;
		if (!config.enabled) {
			void this.refreshContextKeys();
			return;
		}
		const expectedVersion = document.version;
		// VS Code publishes the text change before its corresponding selection
		// change. Yield once so cursor-based guards observe the post-type state.
		const requiresCollapsedSelection = change.rangeLength === 0 ||
			visualTyping?.replacementLength === change.text.length;
		if (
			requiresCollapsedSelection &&
			!await this.waitForCollapsedSelection(editor, expectedVersion, expectedCursor)
		) {
			void this.refreshContextKeys();
			return;
		}
		if (!requiresCollapsedSelection) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (
				editor.document.version !== expectedVersion ||
				vscode.window.activeTextEditor !== editor
			) {
				void this.refreshContextKeys();
				return;
			}
		}
		if (expectedConfiguration !== this.configurationGeneration) {
			void this.refreshContextKeys();
			return;
		}
		const expectedSelection = captureSelection(editor);
		let expanded = false;
		if (config.snippets.enabled) {
			if (change.rangeLength > 0 && previous) {
				expanded = await this.tryVisualExpansion(
					editor,
					previous.text,
					config,
					expectedVersion,
					expectedConfiguration,
					{
						oldStart: change.rangeOffset,
						oldEnd: change.rangeOffset + change.rangeLength,
						currentStart: change.rangeOffset,
						currentEnd: change.rangeOffset + (visualTyping?.replacementLength ?? change.text.length),
						triggerKey: visualTyping?.trigger ?? change.text,
					},
					expectedSelection,
					previousSelection?.selection,
				);
			} else if (change.rangeLength === 0) {
				expanded = await this.tryAutomaticExpansion(
					editor,
					expectedCursor,
					config,
					expectedVersion,
					expectedSelection,
					expectedConfiguration,
					previous === undefined ? undefined : {
						undoBase: {
							currentStart: change.rangeOffset,
							currentEnd: change.rangeOffset + change.text.length,
							previousText: previous.text.slice(
								change.rangeOffset,
								change.rangeOffset + change.rangeLength,
							),
						},
					},
				);
			}
		}
		if (expectedConfiguration !== this.configurationGeneration) {
			void this.refreshContextKeys();
			return;
		}

		if (!expanded && change.text === "/" && config.autoFraction.enabled) {
			const contextOffset = change.rangeOffset;
			const context = this.scan(currentText, contextOffset, document, config);
			const oldSelection = change.rangeLength > 0 && previous
				? {
					start: change.rangeOffset,
					end: change.rangeOffset + change.rangeLength,
					text: previous.text.slice(change.rangeOffset, change.rangeOffset + change.rangeLength),
				}
				: undefined;
			const plan = planAutoFraction(
				currentText,
				contextOffset,
				context,
				config.autoFraction,
				oldSelection,
				expectedCursor,
			);
			if (plan) {
				expanded = await this.applyPlan(
					editor,
					plan,
					config,
					expectedVersion,
					expectedSelection,
					"auto-fraction",
					{ preserveTriggerOnUndo: oldSelection === undefined },
				);
			}
		}

		if (expanded) {
			await this.runRecursiveExpansions(editor, config.snippets.recursionLimit > 0);
		}
		void this.refreshContextKeys();
	}

	private async tryVisualExpansion(
		editor: vscode.TextEditor,
		oldSource: string,
		config: LatexSuiteConfig,
		expectedVersion: number,
		expectedConfiguration: number,
		operation: VisualTypingOperation,
		expectedSelection: EditorSelectionSnapshot,
		adapterSelection?: EditorSelectionSnapshot,
	): Promise<boolean> {
		const { oldStart, oldEnd } = operation;
		const visualSelection = parseVisualSelection(oldSource, oldStart, oldEnd);
		const originalSelection = visualSelection.original;
		const context = this.scan(oldSource, oldEnd, editor.document, config);
		const bundle = await this.getBundle(editor.document, config);
		if (
			expectedConfiguration !== this.configurationGeneration ||
			!this.repository.isCurrent(bundle) ||
			!this.operationIsCurrent(editor, expectedVersion, expectedSelection)
		) {
			return false;
		}
		const match = this.matchSafely(bundle.snippets, {
			before: oldSource.slice(0, oldStart),
			after: oldSource.slice(oldEnd),
			selection: visualSelection.parsed,
			originalSelection,
			mode: context.mode,
			scopes: context.latexStack,
			automatic: false,
			triggerKey: parseKeyName(operation.triggerKey, process.platform === "darwin"),
			wordDelimiters: config.snippets.wordDelimiters,
			adapter: createFunctionAdapter(
				editor.document,
				oldSource,
				adapterSelection?.anchor ?? oldStart,
				adapterSelection?.active ?? oldEnd,
			),
		});
		if (!match) {
			return false;
		}
		return this.applyMatch(
			editor,
			match,
			operation.currentStart,
			operation.currentEnd,
			context,
			config,
			expectedVersion,
			expectedSelection,
			{ visualSelection, preserveTriggerOnUndo: false, undoStopAfter: config.snippets.recursionLimit === 0 },
		);
	}

	private async tryAutomaticExpansion(
		editor: vscode.TextEditor,
		cursor: number,
		config: LatexSuiteConfig,
		expectedVersion: number,
		expectedSelection: EditorSelectionSnapshot,
		expectedConfiguration: number,
		options: AutomaticExpansionOptions = {},
	): Promise<boolean> {
		const physicalSource = editor.document.getText();
		const source = options.autoClosedPair
			? physicalSource.slice(0, options.autoClosedPair.cursor) +
				physicalSource.slice(options.autoClosedPair.currentEnd)
			: physicalSource;
		const bundle = await this.getBundle(editor.document, config);
		if (
			expectedConfiguration !== this.configurationGeneration ||
			!this.repository.isCurrent(bundle) ||
			!this.operationIsCurrent(editor, expectedVersion, expectedSelection)
		) {
			return false;
		}
		if (!canMatchAnySnippetTrigger(bundle.snippets, {
			before: source.slice(0, cursor),
			after: source.slice(cursor),
			automatic: true,
			wordDelimiters: config.snippets.wordDelimiters,
		})) {
			return false;
		}
		const context = this.scan(source, cursor, editor.document, config);
		const match = this.matchSafely(bundle.snippets, this.matchContext(
			editor.document,
			source,
			cursor,
			context,
			config,
			true,
		));
		if (!match) {
			return false;
		}
		const preserveTriggerOnUndo = options.preserveTriggerOnUndo ?? match.snippet.options.undoKey;
		return this.applyMatch(
			editor,
			match,
			match.replaceStart,
			match.replaceEnd,
			context,
			config,
			expectedVersion,
			expectedSelection,
			{
				preserveTriggerOnUndo,
				undoBase: preserveTriggerOnUndo ? undefined : options.undoBase,
				autoClosedPair: options.autoClosedPair,
				undoStopAfter: config.snippets.recursionLimit === 0,
			},
		);
	}

	private async expandSnippet(editor = vscode.window.activeTextEditor, triggerKey?: string): Promise<boolean> {
		if (!this.usableEditor(editor)) {
			return false;
		}
		const config = getConfig(editor.document);
		if (!config.enabled || !config.snippets.enabled) {
			return false;
		}
		const source = editor.document.getText();
		const expectedVersion = editor.document.version;
		const expectedSelection = captureSelection(editor);
		const selection = editor.selection;
		const start = editor.document.offsetAt(selection.start);
		const end = editor.document.offsetAt(selection.end);
		const anchor = editor.document.offsetAt(selection.anchor);
		const active = editor.document.offsetAt(selection.active);
		const visualSelection = selection.isEmpty ? undefined : parseVisualSelection(source, start, end);
		const context = this.scan(source, end, editor.document, config);
		const expectedConfiguration = this.configurationGeneration;
		const bundle = await this.getBundle(editor.document, config);
		if (
			expectedConfiguration !== this.configurationGeneration ||
			!this.repository.isCurrent(bundle) ||
			editor.document.getText() !== source ||
			!this.operationIsCurrent(editor, expectedVersion, expectedSelection)
		) {
			return false;
		}
		const match = this.matchSafely(bundle.snippets, {
			...this.matchContext(editor.document, source, start, context, config, false),
			before: source.slice(0, start),
			after: source.slice(end),
			selection: visualSelection?.parsed,
			originalSelection: visualSelection?.original,
			triggerKey,
			adapter: createFunctionAdapter(editor.document, source, anchor, active),
		});
		if (
			!match ||
			editor.document.getText() !== source ||
			!this.operationIsCurrent(editor, expectedVersion, expectedSelection)
		) {
			return false;
		}
		return this.applyMatch(
			editor,
			match,
			match.replaceStart,
			match.replaceEnd,
			context,
			config,
			expectedVersion,
			expectedSelection,
			{ visualSelection },
		);
	}

	private async expandSnippetByKey(argument?: unknown): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor)) {
			return false;
		}
		let requestedKey = typeof argument === "string"
			? argument
			: isRecord(argument) && typeof argument.triggerKey === "string"
				? argument.triggerKey
				: undefined;
		requestedKey ??= await vscode.window.showInputBox({
			prompt: "LaTeX Suite triggerKey (for example Ctrl-a)",
			ignoreFocusOut: true,
		});
		if (!requestedKey) {
			return false;
		}

		if (vscode.window.activeTextEditor !== editor) {
			return false;
		}
		return this.expandSnippet(editor, parseKeyName(requestedKey, process.platform === "darwin"));
	}

	private async applyMatch(
		editor: vscode.TextEditor,
		match: SnippetMatch<SnippetFunctionAdapter>,
		start: number,
		end: number,
		context: CursorContext,
		config: LatexSuiteConfig,
		expectedVersion: number,
		expectedSelection: EditorSelectionSnapshot,
		options: EditOptions = {},
	): Promise<boolean> {
		let replacement = match.replacement;
		if (context.mode.inlineMath && config.snippets.removeTrailingWhitespace) {
			replacement = trimReplacement(replacement);
		}
		if (config.debug !== "off") {
			this.output.info(`${match.snippet.description}: ${String(match.snippet.trigger)} -> ${replacement.insert}`);
			if (config.debug === "verbose") {
				this.output.debug(JSON.stringify({ start, end, mode: context.mode, scopes: context.latexStack }));
			}
		}
		return this.applyPlan(
			editor,
			{ start, end, replacement },
			config,
			expectedVersion,
			expectedSelection,
			"snippet",
			options,
		);
	}

	private async applyPlan(
		editor: vscode.TextEditor,
		plan: EditPlan,
		config: LatexSuiteConfig,
		expectedVersion: number,
		expectedSelection: EditorSelectionSnapshot,
		label: string,
		options: EditOptions = {},
	): Promise<boolean> {
		const { visualSelection, preserveTriggerOnUndo = true, undoBase, autoClosedPair, undoStopAfter = true } = options;
		if (!this.operationIsCurrent(editor, expectedVersion, expectedSelection)) {
			return false;
		}
		const key = editor.document.uri.toString();
		this.mutatingDocuments.add(key);
		try {
			let currentPlan = plan;
			let currentSelection = expectedSelection;
			let currentAutoClosedPair = autoClosedPair;
			let isolatedUndoBase = false;
			if (undoBase) {
				const sourceBeforeRestore = editor.document.getText();
				const versionBeforeRestore = editor.document.version;
				const sourceAfterRestore = replaceTextRange(
					sourceBeforeRestore,
					undoBase.currentStart,
					undoBase.currentEnd,
					undoBase.previousText,
				);
				const selectionAfterRestore = mapSelectionAcrossChange(currentSelection, undoBase);
				const undoCoversSyntheticClose = Boolean(
					currentAutoClosedPair?.syntheticClose &&
					currentAutoClosedPair.currentEnd > currentAutoClosedPair.cursor &&
					undoBase.currentEnd >= currentAutoClosedPair.currentEnd,
				);
				const mappingChange = undoCoversSyntheticClose && currentAutoClosedPair
					? { ...undoBase, currentEnd: currentAutoClosedPair.cursor }
					: undoBase;
				const restored = await editor.edit((builder) => {
					builder.replace(
						new vscode.Range(
							editor.document.positionAt(undoBase.currentStart),
							editor.document.positionAt(undoBase.currentEnd),
						),
						undoBase.previousText,
					);
				}, { undoStopBefore: false, undoStopAfter: true });
				if (
					!restored ||
					!this.mutationResultIsCurrent(
						editor,
						versionBeforeRestore,
						sourceBeforeRestore !== sourceAfterRestore,
						sourceAfterRestore,
						selectionAfterRestore,
						true,
					)
				) {
					this.output.warn(`VS Code rejected ${label} undo-boundary edit`);
					return false;
				}
				currentSelection = selectionAfterRestore;
				currentPlan = mapPlanAcrossRestoredChange(currentPlan, mappingChange, sourceBeforeRestore);
				if (currentAutoClosedPair) {
					currentAutoClosedPair = undoCoversSyntheticClose
						? undefined
						: mapAutoClosedPairAcrossRestoredChange(currentAutoClosedPair, undoBase);
				}
				isolatedUndoBase = true;
				this.rememberDocument(editor.document);
			}
			let removedAutoClose = false;
			if (
				currentAutoClosedPair &&
				currentAutoClosedPair.currentEnd > currentAutoClosedPair.cursor
			) {
				const sourceBeforeAutoCloseRemoval = editor.document.getText();
				const versionBeforeAutoCloseRemoval = editor.document.version;
				const removal = {
					currentStart: currentAutoClosedPair.cursor,
					currentEnd: currentAutoClosedPair.currentEnd,
					previousText: "",
				};
				const sourceAfterAutoCloseRemoval = replaceTextRange(
					sourceBeforeAutoCloseRemoval,
					removal.currentStart,
					removal.currentEnd,
					removal.previousText,
				);
				const selectionAfterAutoCloseRemoval = mapSelectionAcrossChange(currentSelection, removal);
				const removed = await editor.edit((builder) => {
					builder.delete(new vscode.Range(
						editor.document.positionAt(currentAutoClosedPair!.cursor),
						editor.document.positionAt(currentAutoClosedPair!.currentEnd),
					));
				}, {
					undoStopBefore: preserveTriggerOnUndo && !isolatedUndoBase,
					undoStopAfter: false,
				});
				if (
					!removed ||
					!this.mutationResultIsCurrent(
						editor,
						versionBeforeAutoCloseRemoval,
						true,
						sourceAfterAutoCloseRemoval,
						selectionAfterAutoCloseRemoval,
						true,
					)
				) {
					this.output.warn(`VS Code rejected ${label} auto-close preparation edit`);
					return false;
				}
				currentSelection = selectionAfterAutoCloseRemoval;
				removedAutoClose = true;
				currentAutoClosedPair = undefined;
				this.rememberDocument(editor.document);
			}

			const start = editor.document.positionAt(currentPlan.start);
			const end = editor.document.positionAt(currentPlan.end);
			const prefix = visualSelection?.linePrefix ?? getLinePrefix(editor.document, start);
			const replacement = preserveLinePrefix(
				currentPlan.replacement,
				prefix,
				visualSelection?.prefixWasSelected ?? false,
				editor.options,
			);
			const bracketEdits = this.planProspectiveBracketEnlargements(
				editor,
				currentPlan,
				replacement,
				config,
			);
			const sourceBeforeInsert = editor.document.getText();
			const versionBeforeInsert = editor.document.version;
			const normalizedReplacement = normalizeReplacementEol(replacement, editor.document.eol);
			const sourceAfterInsert = replaceTextRange(
				sourceBeforeInsert,
				currentPlan.start,
				currentPlan.end,
				normalizedReplacement.insert,
			);
			const firstNormalizedTabstop = firstTabstopByIndex(normalizedReplacement);
			const selectionAfterInsert = firstNormalizedTabstop
				? {
					anchor: currentPlan.start + firstNormalizedTabstop.from,
					active: currentPlan.start + firstNormalizedTabstop.to,
				}
				: {
					anchor: currentPlan.start + normalizedReplacement.insert.length,
					active: currentPlan.start + normalizedReplacement.insert.length,
				};
			const inserted = await editor.insertSnippet(
				new vscode.SnippetString(toVscodeSnippet(replacement)),
				new vscode.Range(start, end),
				{
					keepWhitespace: true,
					undoStopBefore: removedAutoClose ? false : preserveTriggerOnUndo || isolatedUndoBase,
					undoStopAfter: bracketEdits.length === 0 && undoStopAfter,
				},
			);
			if (!inserted) {
				this.output.warn(`VS Code rejected ${label} edit`);
				return false;
			}
			const firstTabstop = firstTabstopByIndex(replacement);
			if (
				autoClosedPair &&
				firstTabstop &&
				replacement.insert === autoClosedPair.open + autoClosedPair.close &&
				firstTabstop.from === autoClosedPair.open.length &&
				firstTabstop.to === firstTabstop.from
			) {
				const position = editor.document.positionAt(currentPlan.start + firstTabstop.from);
				editor.selection = new vscode.Selection(position, position);
			}
			if (!this.mutationResultIsCurrent(
				editor,
				versionBeforeInsert,
				sourceBeforeInsert !== sourceAfterInsert,
				sourceAfterInsert,
				selectionAfterInsert,
				false,
			)) {
				this.output.warn(`Editor changed during ${label} insertion; skipping follow-up edits`);
				return false;
			}
			currentSelection = selectionAfterInsert;
			this.rememberDocument(editor.document);
			if (bracketEdits.length > 0) {
				const sourceBeforeBracketEnlargement = editor.document.getText();
				const versionBeforeBracketEnlargement = editor.document.version;
				const sourceAfterBracketEnlargement = applyTextEdits(
					sourceBeforeBracketEnlargement,
					bracketEdits,
				);
				const selectionAfterBracketEnlargement = mapSelectionAcrossTextEdits(
					currentSelection,
					bracketEdits,
				);
				if (
					!await this.applyBracketEnlargements(editor, bracketEdits, undoStopAfter) ||
					!this.mutationResultIsCurrent(
						editor,
						versionBeforeBracketEnlargement,
						true,
						sourceAfterBracketEnlargement,
						selectionAfterBracketEnlargement,
						false,
					)
				) {
					this.output.warn(`VS Code rejected ${label} bracket-enlargement edit`);
					return false;
				}
			}
			return true;
		} finally {
			this.mutatingDocuments.delete(key);
			this.rememberDocument(editor.document);
		}
	}

	private planProspectiveBracketEnlargements(
		editor: vscode.TextEditor,
		plan: EditPlan,
		replacement: ResultInsert,
		config: LatexSuiteConfig,
	): TextEditPlan[] {
		if (
			!config.bracketEnlargement.enabled ||
			!config.bracketEnlargement.triggers.some((trigger) => replacement.insert.includes(trigger))
		) {
			return [];
		}
		const prospectiveReplacement = normalizeReplacementEol(replacement, editor.document.eol);
		const current = editor.document.getText();
		const source = current.slice(0, plan.start) + prospectiveReplacement.insert + current.slice(plan.end);
		const firstTabstop = firstTabstopByIndex(prospectiveReplacement);
		const cursor = plan.start + (firstTabstop?.from ?? prospectiveReplacement.insert.length);
		const context = scanContext(source, cursor, {
			language: editor.document.languageId === "latex" ? "latex" : "markdown",
			mathFenceLanguages: config.forceMathLanguages,
		});
		return context.innerMathBounds
			? planBracketEnlargements(
				source,
				context.innerMathBounds,
				config.bracketEnlargement.triggers,
				config.bracketEnlargement.insertSpaces,
			)
			: [];
	}

	private async applyBracketEnlargements(
		editor: vscode.TextEditor,
		edits: readonly TextEditPlan[],
		undoStopAfter: boolean,
	): Promise<boolean> {
		return editor.edit((builder) => {
			for (const edit of edits) {
				builder.replace(
					new vscode.Range(editor.document.positionAt(edit.start), editor.document.positionAt(edit.end)),
					edit.text,
				);
			}
		}, { undoStopBefore: false, undoStopAfter });
	}

	private async runRecursiveExpansions(editor: vscode.TextEditor, closeUndoGroup: boolean): Promise<void> {
		try {
			for (let pass = 0; ; pass += 1) {
				if (!this.usableEditor(editor) || !editor.selection.isEmpty) {
					break;
				}
				const config = getConfig(editor.document);
				const expectedConfiguration = this.configurationGeneration;
				if (!config.enabled || !config.snippets.enabled || pass >= config.snippets.recursionLimit) {
					break;
				}
				const expanded = await this.tryAutomaticExpansion(
					editor,
					editor.document.offsetAt(editor.selection.active),
					config,
					editor.document.version,
					captureSelection(editor),
					expectedConfiguration,
					{ preserveTriggerOnUndo: false },
				);
				if (!expanded) {
					break;
				}
			}
		} finally {
			if (closeUndoGroup) {
				await this.closeUndoGroup(editor);
			}
		}
	}

	private async closeUndoGroup(editor: vscode.TextEditor): Promise<void> {
		const key = editor.document.uri.toString();
		this.mutatingDocuments.add(key);
		try {
			const closed = await editor.edit(
				(builder) => builder.insert(editor.selection.active, ""),
				{ undoStopBefore: false, undoStopAfter: true },
			);
			if (!closed) {
				this.output.warn("VS Code rejected recursive-expansion undo boundary");
			}
		} finally {
			this.mutatingDocuments.delete(key);
			this.rememberDocument(editor.document);
		}
	}

	private async runAutoFractionCommand(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor)) {
			return false;
		}
		const config = getConfig(editor.document);
		if (!config.enabled || !config.autoFraction.enabled) {
			return false;
		}
		const source = editor.document.getText();
		const start = editor.document.offsetAt(editor.selection.start);
		const end = editor.document.offsetAt(editor.selection.end);
		const context = this.scan(source, end, editor.document, config);
		const plan = planAutoFraction(
			source,
			end,
			context,
			config.autoFraction,
			editor.selection.isEmpty ? undefined : { start, end, text: source.slice(start, end) },
			end,
		);
		return plan
			? this.applyPlan(
				editor,
				plan,
				config,
				editor.document.version,
				captureSelection(editor),
				"auto-fraction",
			)
			: false;
	}

	private async runContextualTab(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor)) {
			await vscode.commands.executeCommand("tab");
			return;
		}
		const config = getConfig(editor.document);
		if (!config.enabled) {
			await vscode.commands.executeCommand("tab");
			return;
		}
		const commandVersion = editor.document.version;
		const commandSelection = captureSelection(editor);
		const commandConfiguration = this.configurationGeneration;
		if (config.snippets.enabled) {
			if (await this.expandSnippet(editor)) {
				return;
			}
			if (
				commandConfiguration !== this.configurationGeneration ||
				!this.operationIsCurrent(editor, commandVersion, commandSelection)
			) {
				return;
			}
		}
		if (!editor.selection.isEmpty) {
			await vscode.commands.executeCommand("tab");
			return;
		}
		const source = editor.document.getText();
		const cursor = editor.document.offsetAt(editor.selection.active);
		const context = this.scan(source, cursor, editor.document, config);
		const matrix = config.matrixShortcuts.enabled ? getMatrixScope(context, config.matrixShortcuts) : null;
		if (matrix && context.innerMathBounds && config.tabOut.enabled) {
			const target = findUnenclosedClosingTarget(source, cursor, context.innerMathBounds, config.tabOut.closingSymbols);
			if (target !== null) {
				setCursor(editor, target);
				return;
			}
		}
		if (matrix) {
			await this.applyTextEdit(editor, planMatrixCell(cursor));
			return;
		}
		if (await this.navigateBracketOrEquation(editor)) {
			return;
		}
		if (
			commandConfiguration !== this.configurationGeneration ||
			!this.operationIsCurrent(editor, commandVersion, commandSelection)
		) {
			return;
		}
		await vscode.commands.executeCommand("tab");
	}

	private async navigateBracketOrEquation(editor = vscode.window.activeTextEditor): Promise<boolean> {
		if (!this.usableEditor(editor) || !editor.selection.isEmpty) {
			return false;
		}
		const config = getConfig(editor.document);
		if (!config.enabled || !config.tabOut.enabled) {
			return false;
		}
		const source = editor.document.getText();
		const cursor = editor.document.offsetAt(editor.selection.active);
		const context = this.scan(source, cursor, editor.document, config);
		const bounds = context.innerMathBounds;
		if (!bounds) {
			return false;
		}
		const target = findTabOutTarget(source, cursor, bounds, config.tabOut.closingSymbols);
		if (target !== null) {
			setCursor(editor, target);
			return true;
		}
		const remaining = source.slice(cursor, bounds.inner_end);
		if (config.tabOut.exitEquationOnlyAtEndOfLine && remaining.trim()) {
			return false;
		}
		if (!bounds.closed) {
			return false;
		}
		if (!source.slice(bounds.outer_start, bounds.outer_end).includes("\n")) {
			setCursor(editor, bounds.outer_end);
			return true;
		}
		return this.exitMultilineEquation(editor, bounds.outer_start, bounds.outer_end, cursor);
	}

	private async exitMultilineEquation(
		editor: vscode.TextEditor,
		outerStart: number,
		outerEnd: number,
		cursor: number,
	): Promise<boolean> {
		const document = editor.document;
		const startLine = document.lineAt(document.positionAt(outerStart).line);
		const endLine = document.lineAt(document.positionAt(outerEnd).line);
		const currentLine = document.lineAt(document.positionAt(cursor).line);
		const indentation = startLine.text.match(/^\s*/)?.[0] ?? "";
		const trimmedCurrentLine = currentLine.text.trimEnd();
		const trimStart = currentLine.range.start.translate(0, trimmedCurrentLine.length);
		const hasTrailingWhitespace = trimmedCurrentLine.length !== currentLine.text.length;
		let targetLine: number;
		let targetColumn: number;
		let nextLine: vscode.TextLine | undefined;
		let appendLine = false;
		if (endLine.lineNumber === document.lineCount - 1) {
			appendLine = true;
			targetLine = endLine.lineNumber + 1;
			targetColumn = indentation.length;
		} else {
			nextLine = document.lineAt(endLine.lineNumber + 1);
			targetLine = nextLine.lineNumber;
			targetColumn = nextLine.isEmptyOrWhitespace ? indentation.length : 0;
		}

		const normalizeBlankLine = nextLine?.isEmptyOrWhitespace === true && nextLine.text !== indentation;
		if (!appendLine && !normalizeBlankLine && !hasTrailingWhitespace) {
			setCursor(editor, document.offsetAt(new vscode.Position(targetLine, targetColumn)));
			return true;
		}

		const key = document.uri.toString();
		this.mutatingDocuments.add(key);
		try {
			const edited = await editor.edit((builder) => {
				const combineTrimAndAppend = appendLine &&
					hasTrailingWhitespace &&
					currentLine.lineNumber === endLine.lineNumber;
				if (combineTrimAndAppend) {
					builder.replace(new vscode.Range(trimStart, currentLine.range.end), `\n${indentation}`);
				} else {
					if (hasTrailingWhitespace) {
						builder.delete(new vscode.Range(trimStart, currentLine.range.end));
					}
					if (appendLine) {
						builder.insert(endLine.range.end, `\n${indentation}`);
					}
				}
				if (normalizeBlankLine && nextLine) {
					builder.replace(nextLine.range, indentation);
				}
			});
			if (!edited) {
				return false;
			}
			setCursor(editor, document.offsetAt(new vscode.Position(targetLine, targetColumn)));
			return true;
		} finally {
			this.mutatingDocuments.delete(key);
			this.rememberDocument(document);
		}
	}

	private async insertMatrixCell(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor) || !editor.selection.isEmpty) {
			return false;
		}
		const config = getConfig(editor.document);
		const source = editor.document.getText();
		const cursor = editor.document.offsetAt(editor.selection.active);
		const context = this.scan(source, cursor, editor.document, config);
		if (!config.enabled || !config.matrixShortcuts.enabled || !getMatrixScope(context, config.matrixShortcuts)) {
			return false;
		}
		return this.applyTextEdit(editor, planMatrixCell(cursor));
	}

	private async insertMatrixNewline(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor) || !editor.selection.isEmpty) {
			return false;
		}
		const config = getConfig(editor.document);
		const source = editor.document.getText();
		const cursor = editor.document.offsetAt(editor.selection.active);
		const context = this.scan(source, cursor, editor.document, config);
		const scope = config.enabled && config.matrixShortcuts.enabled
			? getMatrixScope(context, config.matrixShortcuts)
			: null;
		if (!scope) {
			return false;
		}
		return this.applyPlan(
			editor,
			planMatrixNewline(source, cursor, scope),
			config,
			editor.document.version,
			captureSelection(editor),
			"matrix row",
		);
	}

	private async insertMatrixNewlineFromKeybinding(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		const version = editor?.document.version;
		const selection = editor && this.usableEditor(editor) ? captureSelection(editor) : undefined;
		const handled = await this.insertMatrixNewline();
		if (
			!handled &&
			editor &&
			version !== undefined &&
			selection &&
			this.operationIsCurrent(editor, version, selection)
		) {
			await vscode.commands.executeCommand("type", { text: "\n" });
		}
		return handled;
	}

	private async exitMatrix(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!this.usableEditor(editor) || !editor.selection.isEmpty) {
			return false;
		}
		const config = getConfig(editor.document);
		const source = editor.document.getText();
		const cursor = editor.document.offsetAt(editor.selection.active);
		const context = this.scan(source, cursor, editor.document, config);
		const scope = config.enabled && config.matrixShortcuts.enabled
			? getMatrixScope(context, config.matrixShortcuts)
			: null;
		if (!scope) {
			return false;
		}
		setCursor(editor, matrixExitTarget(source, cursor, scope));
		return true;
	}

	private async exitMatrixFromKeybinding(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		const version = editor?.document.version;
		const selection = editor && this.usableEditor(editor) ? captureSelection(editor) : undefined;
		const handled = await this.exitMatrix();
		if (
			!handled &&
			editor &&
			version !== undefined &&
			selection &&
			this.operationIsCurrent(editor, version, selection)
		) {
			await vscode.commands.executeCommand("type", { text: "\n" });
		}
		return handled;
	}

	private async applyTextEdit(editor: vscode.TextEditor, edit: { start: number; end: number; text: string }): Promise<boolean> {
		const key = editor.document.uri.toString();
		this.mutatingDocuments.add(key);
		try {
			return await editor.edit((builder) => builder.replace(
				new vscode.Range(editor.document.positionAt(edit.start), editor.document.positionAt(edit.end)),
				edit.text,
			));
		} finally {
			this.mutatingDocuments.delete(key);
			this.rememberDocument(editor.document);
		}
	}

	private scan(source: string, offset: number, document: vscode.TextDocument, config: LatexSuiteConfig): CursorContext {
		const mathFenceLanguages = config.forceMathLanguages.join("\u0000");
		if (
			this.lastScan?.document === document &&
			this.lastScan.version === document.version &&
			this.lastScan.source === source &&
			this.lastScan.mathFenceLanguages === mathFenceLanguages
		) {
			return this.lastScan.context.at(offset);
		}
		const context = parseContext(source, {
			language: document.languageId === "latex" || /\.tex$/i.test(document.uri.path) ? "latex" : "markdown",
			mathFenceLanguages: config.forceMathLanguages,
		});
		this.lastScan = {
			document,
			version: document.version,
			source,
			mathFenceLanguages,
			context,
		};
		return context.at(offset);
	}

	private matchSafely(
		snippets: SnippetBundle["snippets"],
		context: MatchContext<SnippetFunctionAdapter>,
	): SnippetMatch<SnippetFunctionAdapter> | null {
		try {
			return matchFirstSnippet(snippets, context);
		} catch (error) {
			this.output.error(`Snippet replacement failed: ${errorDetail(error)}`);
			return null;
		}
	}

	private matchContext(
		document: vscode.TextDocument,
		source: string,
		cursor: number,
		context: CursorContext,
		config: LatexSuiteConfig,
		automatic?: boolean,
	): MatchContext<SnippetFunctionAdapter> {
		return {
			before: source.slice(0, cursor),
			after: source.slice(cursor),
			mode: context.mode,
			scopes: context.latexStack,
			automatic,
			wordDelimiters: config.snippets.wordDelimiters,
			adapter: createFunctionAdapter(document, source, cursor, cursor),
		};
	}

	private async getBundle(document: vscode.TextDocument, config: LatexSuiteConfig): Promise<SnippetBundle> {
		const bundle = await this.repository.get(document, config);
		if (!this.disposed && bundle.customSourcesSkipped && !this.warnedAboutTrust) {
			this.warnedAboutTrust = true;
			void vscode.window.showWarningMessage(
				"LaTeX Suite did not execute custom snippets because this workspace is not trusted.",
			);
		}
		return bundle;
	}

	private usableEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
		return Boolean(!this.disposed && editor && !editor.document.isClosed && isSupportedDocument(editor.document) && editor.selections.length === 1);
	}

	private operationIsCurrent(
		editor: vscode.TextEditor,
		expectedVersion: number,
		expectedSelection: EditorSelectionSnapshot,
	): boolean {
		return !this.disposed && !editor.document.isClosed && vscode.window.activeTextEditor === editor &&
			editor.document.version === expectedVersion &&
			editor.selections.length === 1 &&
			selectionMatches(editor, expectedSelection);
	}

	private mutationResultIsCurrent(
		editor: vscode.TextEditor,
		versionBefore: number,
		contentChanged: boolean,
		expectedSource: string,
		expectedSelection: EditorSelectionSnapshot,
		requireSingleSelection: boolean,
	): boolean {
		const versionDelta = editor.document.version - versionBefore;
		return !this.disposed && !editor.document.isClosed && vscode.window.activeTextEditor === editor &&
			(!contentChanged || versionDelta === 1) &&
			versionDelta >= 0 &&
			versionDelta <= 1 &&
			editor.document.getText() === expectedSource &&
			(!requireSingleSelection || editor.selections.length === 1) &&
			selectionBoundsMatch(
				captureSelection(editor),
				Math.min(expectedSelection.anchor, expectedSelection.active),
				Math.max(expectedSelection.anchor, expectedSelection.active),
			);
	}

	private async waitForCollapsedSelection(
		editor: vscode.TextEditor,
		expectedVersion: number,
		expectedOffset: number,
	): Promise<boolean> {
		const isCurrent = () => !this.disposed && !editor.document.isClosed && vscode.window.activeTextEditor === editor &&
			editor.document.version === expectedVersion &&
			editor.selections.length === 1;
		if (!isCurrent()) {
			return false;
		}
		if (isCollapsedAt(editor, expectedOffset)) {
			return true;
		}
		return new Promise<boolean>((resolve) => {
			const disposables: vscode.Disposable[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: boolean) => {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				for (const disposable of disposables) {
					disposable.dispose();
				}
				resolve(result);
			};
			disposables.push(
				this.shutdown.token.onCancellationRequested(() => finish(false)),
				vscode.window.onDidChangeTextEditorSelection((event) => {
					if (event.textEditor === editor && isCurrent() && isCollapsedAt(editor, expectedOffset)) {
						finish(true);
					}
				}),
				vscode.window.onDidChangeActiveTextEditor(() => {
					if (!isCurrent()) {
						finish(false);
					}
				}),
				vscode.workspace.onDidChangeTextDocument((event) => {
					if (event.document === editor.document && editor.document.version !== expectedVersion) {
						finish(false);
					}
				}),
			);
			timer = setTimeout(() => finish(isCurrent() && isCollapsedAt(editor, expectedOffset)), 250);
		});
	}

	private async waitForAutoCloseSettlement(
		editor: vscode.TextEditor,
		operation: AutoClosedPairOperation,
		expectedConfiguration: number,
	): Promise<{ version: number; materializedPair?: AutoClosedPairOperation } | null> {
		const isCurrent = () => !this.disposed && !editor.document.isClosed && expectedConfiguration === this.configurationGeneration &&
			vscode.window.activeTextEditor === editor &&
			editor.selections.length === 1 &&
			isCollapsedAt(editor, operation.cursor);
		const materializedPair = (): AutoClosedPairOperation | undefined => {
			if (!operation.syntheticClose || !isCurrent()) {
				return undefined;
			}
			return editor.document.getText().startsWith(operation.close, operation.cursor)
				? { ...operation, currentEnd: operation.cursor + operation.close.length }
				: undefined;
		};
		if (!isCurrent()) {
			return null;
		}
		const alreadyMaterialized = materializedPair();
		if (alreadyMaterialized || !operation.syntheticClose) {
			return { version: editor.document.version, materializedPair: alreadyMaterialized };
		}

		const initialVersion = editor.document.version;
		return new Promise((resolve) => {
			const disposables: vscode.Disposable[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: { version: number; materializedPair?: AutoClosedPairOperation } | null) => {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				for (const disposable of disposables) {
					disposable.dispose();
				}
				resolve(result);
			};
			const check = () => {
				if (!isCurrent()) {
					finish(null);
					return;
				}
				const settled = materializedPair();
				if (settled) {
					finish({ version: editor.document.version, materializedPair: settled });
				}
			};
			disposables.push(
				this.shutdown.token.onCancellationRequested(() => finish(null)),
				vscode.workspace.onDidChangeTextDocument((event) => {
					if (event.document !== editor.document) {
						return;
					}
					if (editor.document.version !== initialVersion && !materializedPair()) {
						finish(null);
						return;
					}
					check();
				}),
				vscode.window.onDidChangeTextEditorSelection((event) => {
					if (event.textEditor === editor) {
						check();
					}
				}),
				vscode.window.onDidChangeActiveTextEditor(() => check()),
				vscode.workspace.onDidChangeConfiguration(() => {
					if (expectedConfiguration !== this.configurationGeneration) {
						finish(null);
					}
				}),
			);
			timer = setTimeout(() => {
				if (!isCurrent()) {
					finish(null);
					return;
				}
				finish({ version: editor.document.version, materializedPair: materializedPair() });
			}, 250);
		});
	}

	private async refreshContextKeys(): Promise<void> {
		try {
			await this.updateContextKeys();
		} catch (error) {
			this.reportAsyncFailure("Context refresh failed", error);
		}
	}

	private async updateContextKeys(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		let inMatrix = false;
		if (this.usableEditor(editor) && editor.selection.isEmpty) {
			const config = getConfig(editor.document);
			if (config.enabled) {
				const source = editor.document.getText();
				const cursor = editor.document.offsetAt(editor.selection.active);
				const context = this.scan(source, cursor, editor.document, config);
				inMatrix = config.matrixShortcuts.enabled && getMatrixScope(context, config.matrixShortcuts) !== null;
			}
		}
		await vscode.commands.executeCommand(
			"setContext", "latexSuite.supportedDocument",
			Boolean(!this.disposed && editor && isSupportedDocument(editor.document)),
		);
		await vscode.commands.executeCommand("setContext", "latexSuite.inMatrix", inMatrix);
	}

	private async reloadSnippets(): Promise<void> {
		this.repository.clear();
		const editor = vscode.window.activeTextEditor;
		if (editor && isSupportedDocument(editor.document)) {
			const expectedConfiguration = this.configurationGeneration;
			const bundle = await this.getBundle(editor.document, getConfig(editor.document));
			if (
				expectedConfiguration !== this.configurationGeneration ||
				!this.repository.isCurrent(bundle)
			) {
				return;
			}
			if (bundle.errors.length === 0) {
				void vscode.window.showInformationMessage(`LaTeX Suite loaded ${bundle.snippets.length} snippets.`);
			} else {
				void vscode.window.showWarningMessage(
					`LaTeX Suite loaded ${bundle.snippets.length} snippets with ${bundle.errors.length} error(s). See the output channel.`,
				);
			}
		}
		void this.refreshContextKeys();
	}

	private async addSourceFile(setting: "snippets.files" | "snippets.variableFiles"): Promise<void> {
		const document = vscode.window.activeTextEditor?.document;
		const folder = (document && vscode.workspace.getWorkspaceFolder(document.uri))
			?? vscode.workspace.workspaceFolders?.[0];
		const variableFile = setting === "snippets.variableFiles";
		const selected = await vscode.window.showOpenDialog({
			title: variableFile ? "Add LaTeX Suite Variable File" : "Add LaTeX Suite Snippet File",
			openLabel: "Add File",
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: folder?.uri,
		});
		if (!selected?.length || this.disposed) {
			return;
		}
		const configuration = vscode.workspace.getConfiguration("latexSuite", folder?.uri);
		const selectedFile = selected[0];
		const file = selectedFile.scheme === "file" ? selectedFile.fsPath : selectedFile.toString();
		// Never copy effective workspace overrides into User settings.
		const files = configuration.inspect<string[]>(setting)?.globalValue ?? [];
		const identity = (uri: vscode.Uri) => uri.scheme === "file" ? vscode.Uri.file(uri.fsPath).toString() : uri.toString();
		const alreadyConfigured = files.some(entry => {
			if (entry === file) {
				return true;
			}
			try {
				const uri = path.isAbsolute(entry) ? vscode.Uri.file(entry) : vscode.Uri.parse(entry, true);
				return identity(uri) === identity(selectedFile);
			} catch {
				return false;
			}
		});
		if (!alreadyConfigured) {
			await configuration.update(setting, [...files, file], vscode.ConfigurationTarget.Global);
		}
		if (this.disposed) {
			return;
		}
		this.repository.clear();
		await this.refreshContextKeys();
		const values = configuration.inspect<string[]>(setting);
		const overrideNote = values?.workspaceValue !== undefined || values?.workspaceFolderValue !== undefined
			? " Existing workspace settings override this User setting."
			: "";
		void vscode.window.showInformationMessage(`LaTeX Suite file configured in User settings.${overrideNote}`);
	}

	private async toggleEnabled(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const scope = editor?.document;
		const configuration = vscode.workspace.getConfiguration("latexSuite", scope);
		const enabled = configuration.get("enabled", true);
		const target = scope && vscode.workspace.getWorkspaceFolder(scope.uri)
			? vscode.ConfigurationTarget.WorkspaceFolder
			: vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
		await configuration.update("enabled", !enabled, target);
		void vscode.window.showInformationMessage(`LaTeX Suite typing shortcuts ${enabled ? "disabled" : "enabled"}.`);
	}
}
