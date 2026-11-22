import { createRequire } from "node:module";
import * as path from "node:path";
import {
	parse,
	type AssignmentExpression,
	type ExportDefaultDeclaration,
	type ExpressionStatement,
	type Identifier,
	type Literal,
	type MemberExpression,
	type Node,
} from "acorn";
import * as vscode from "vscode";
import { getConfig, type LatexSuiteConfig } from "./config";
import { type ReadOnlyCodeMirrorState } from "./core/editorAdapter";
import { createLatexSuiteApi, type LatexSuiteApi } from "./core/nodes";
import {
	normalizeSnippetVariables,
	parseSnippets,
	sortSnippets,
	type Snippet,
	type SnippetVariables,
} from "./core/snippets";
import defaultSnippetVariablesSource from "./upstream/default_snippet_variables.js";
import defaultSnippetSource from "./upstream/default_snippets.js";
import { ALL_MACROS } from "./upstream/macros";
import { SnippetFileWatcher } from "./snippetFileWatcher";

export interface SnippetFunctionAdapter {
	state: ReadOnlyCodeMirrorState;
	document: vscode.TextDocument;
}

export interface SnippetBundle {
	snippets: Snippet<SnippetFunctionAdapter>[];
	variables: SnippetVariables;
	errors: string[];
	customSourcesSkipped: boolean;
	generation: { current: boolean };
}

interface SourceFile {
	identifier: string;
	source: string;
	uri?: vscode.Uri;
}

type Resource = Pick<vscode.TextDocument, "uri" | "languageId">;

interface Collection {
	resource: Resource;
	config: LatexSuiteConfig;
	settingsKey: string;
	generation: SnippetBundle["generation"];
	watcher?: SnippetFileWatcher;
	pending?: Promise<SnippetBundle>;
}

/** Loads and caches executable upstream-format snippet modules per resource. */
export class SnippetRepository implements vscode.Disposable {
	private readonly collections = new Map<string, Collection>();
	private readonly disposables: vscode.Disposable[];

	constructor(private readonly output: vscode.OutputChannel) {
		this.disposables = [
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("latexSuite.snippets")) {
					for (const { resource } of this.collections.values()) {
						if (event.affectsConfiguration("latexSuite.snippets", resource)) {
							this.getCollection(resource, getConfig(resource));
						}
					}
				}
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				for (const { resource } of this.collections.values()) {
					this.getCollection(resource, getConfig(resource));
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				for (const [key, collection] of this.collections) {
					// Relative paths for a loose document fall back to the first workspace folder.
					if (!vscode.workspace.getWorkspaceFolder(collection.resource.uri) || key !== collectionKey(collection.resource)) {
						this.discard(collection);
						this.collections.delete(key);
					}
				}
			}),
		];
	}

	get(resource: Resource, config: LatexSuiteConfig): Promise<SnippetBundle> {
		const collection = this.getCollection(resource, config);
		collection.pending ??= this.load(collection, collection.generation);
		return collection.pending;
	}

	private getCollection(resource: Resource, config: LatexSuiteConfig): Collection {
		const key = collectionKey(resource);
		const settingsKey = JSON.stringify({
			trusted: vscode.workspace.isTrusted,
			files: config.snippets.files,
			source: config.snippets.source,
			variableFiles: config.snippets.variableFiles,
			variablesSource: config.snippets.variablesSource,
		});
		const previous = this.collections.get(key);
		if (previous?.settingsKey === settingsKey) {
			return previous;
		}
		if (previous) {
			this.discard(previous);
		}
		const collection: Collection = {
			resource: { uri: resource.uri, languageId: resource.languageId },
			config, settingsKey, generation: { current: true },
		};
		if (vscode.workspace.isTrusted) {
			const paths = nonEmptyConfiguredPaths([...config.snippets.files, ...config.snippets.variableFiles]);
			const uris: vscode.Uri[] = [];
			for (const configuredPath of paths) {
				try {
					uris.push(resolveConfiguredUri(configuredPath, resource.uri));
				} catch {
					// The loader reports unresolved paths together with read and parse errors.
				}
			}
			collection.watcher = new SnippetFileWatcher(uris, () => {
				if (!collection.pending) {
					return;
				}
				collection.generation.current = false;
				collection.generation = { current: true };
				collection.pending = this.load(collection, collection.generation);
				void collection.pending.catch((error: unknown) => this.output.appendLine(formatError("Automatic snippet reload", error)));
			});
		}
		this.collections.set(key, collection);
		return collection;
	}

	private discard(collection: Collection): void {
		collection.generation.current = false;
		collection.watcher?.dispose();
	}

	clear(): void {
		for (const collection of this.collections.values()) {
			this.discard(collection);
		}
		this.collections.clear();
	}

	isCurrent(bundle: SnippetBundle): boolean {
		return bundle.generation.current;
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.clear();
	}

	private async load(
		collection: Collection,
		generation: SnippetBundle["generation"],
	): Promise<SnippetBundle> {
		const { config } = collection;
		const errors: string[] = [];
		const loadCustom = vscode.workspace.isTrusted;
		const variables: SnippetVariables = {};
		// Snippet files may extend this array. Keep those mutations within one
		// bundle load so clearing the cache always starts from the upstream list.
		const allMacros = [...ALL_MACROS];

		const defaultVariables = evaluateSnippetModule(
			defaultSnippetVariablesSource,
			"bundled:default_snippet_variables.js",
			createLatexSuiteApi({ allMacros }),
		);
		Object.assign(variables, normalizeSnippetVariables(assertVariableObject(defaultVariables)));

		if (loadCustom) {
			const variableSources = await this.collectSources(
				collection, generation,
				config.snippets.variableFiles,
				config.snippets.variablesSource,
				"inline snippet variables",
				errors,
			);
			if (!generation.current) {
				return staleBundle(generation);
			}
			for (const source of variableSources) {
				try {
					const value = evaluateSnippetModule(
						source.source,
						source.identifier,
						createLatexSuiteApi({ snippetVariables: variables, allMacros }),
						source.uri,
					);
					Object.assign(variables, normalizeSnippetVariables(assertVariableObject(value)));
				} catch (error) {
					errors.push(formatError(source.identifier, error));
				}
			}
		}

		const api = createLatexSuiteApi({ snippetVariables: variables, allMacros });
		const rawSources: SourceFile[] = [];
		// Select by configuration, not by successful loading: empty or broken
		// custom collections must never silently bring back bundled triggers.
		const useCustomSnippets = loadCustom && Boolean(
			config.snippets.source.trim() || nonEmptyConfiguredPaths(config.snippets.files).length,
		);
		if (!useCustomSnippets) {
			rawSources.push({ identifier: "bundled:default_snippets.js", source: defaultSnippetSource });
		}
		if (useCustomSnippets) {
			const customSources = await this.collectSources(
				collection, generation,
				config.snippets.files,
				config.snippets.source,
				"inline snippets",
				errors,
			);
			if (!generation.current) {
				return staleBundle(generation);
			}
			rawSources.push(...customSources);
		}

		const snippets: Snippet<SnippetFunctionAdapter>[] = [];
		for (const source of rawSources) {
			try {
				const value = evaluateSnippetModule(source.source, source.identifier, api, source.uri);
				snippets.push(...parseSnippets<SnippetFunctionAdapter>(value, variables, {
					isMacOS: process.platform === "darwin",
				}));
			} catch (error) {
				errors.push(formatError(source.identifier, error));
			}
		}

		for (const error of errors) {
			this.output.appendLine(error);
		}
		return {
			snippets: sortSnippets(snippets),
			variables,
			errors,
			customSourcesSkipped: !loadCustom && hasCustomSources(config),
			generation,
		};
	}

	private async collectSources(
		collection: Collection,
		generation: SnippetBundle["generation"],
		configuredPaths: readonly string[],
		inlineSource: string,
		inlineIdentifier: string,
		errors: string[],
	): Promise<SourceFile[]> {
		const sources: SourceFile[] = [];
		if (inlineSource.trim()) {
			sources.push({ identifier: inlineIdentifier, source: inlineSource });
		}
		for (const configuredPath of nonEmptyConfiguredPaths(configuredPaths)) {
			try {
				const uri = resolveConfiguredUri(configuredPath, collection.resource.uri);
				sources.push(...await readSourceUri(uri, (directory) => {
					if (generation.current) {
						collection.watcher?.setDirectory(uri, directory);
					}
				}));
			} catch (error) {
				errors.push(formatError(configuredPath, error));
			}
		}
		return sources;
	}
}

function collectionKey(resource: Resource): string {
	const folder = vscode.workspace.getWorkspaceFolder(resource.uri)?.uri.toString() ?? "";
	return JSON.stringify([folder, resource.languageId]);
}

function staleBundle(generation: SnippetBundle["generation"]): SnippetBundle {
	return {
		snippets: [],
		variables: {},
		errors: [],
		customSourcesSkipped: false,
		generation,
	};
}

/** Ignore blank array entries without rewriting valid path text. */
export function nonEmptyConfiguredPaths(configuredPaths: readonly string[]): string[] {
	return configuredPaths.filter((configuredPath) => configuredPath.trim().length > 0);
}

/** Evaluate an upstream, CommonJS, or bare-expression snippet module. */
export function evaluateSnippetModule(
	source: string,
	identifier: string,
	api: LatexSuiteApi,
	uri?: vscode.Uri,
): unknown {
	const requireFrom = uri?.scheme === "file" ? uri.fsPath : __filename;
	const nativeRequire = createRequire(requireFrom);
	const compatibleRequire = (request: string): unknown =>
		request === "latex-suite" ? api : nativeRequire(request);
	const sourceUrl = identifier.replace(/[\r\n]/g, " ");
	let syntax: ModuleSyntax;
	let expression: ModuleFactory | null = null;
	try {
		syntax = scanModuleSyntax(source);
	} catch (error) {
		// Bare objects with quoted keys (or multiple properties) are valid
		// expressions but invalid module statements. Compile without executing
		// before accepting this shape, preserving errors for malformed sources.
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		expression = tryCompileExpression(source, sourceUrl);
		if (!expression) {
			throw error;
		}
		syntax = { exportDefault: null, usesCommonJsExports: false };
	}

	if (syntax.exportDefault) {
		const transformed = source.slice(0, syntax.exportDefault.start) +
			"module.exports.default =" + source.slice(syntax.exportDefault.end);
		const module = createCommonJsModule();
		compileCommonJs(transformed, sourceUrl)(
			compatibleRequire,
			module,
			module.exports,
			moduleFilename(uri, identifier),
			moduleDirname(uri),
		);
		return getCommonJsExport(module, true);
	}

	// Compile both possible shapes before running either one. In particular, a
	// bare array containing side effects must not first execute as an empty
	// CommonJS module and then execute a second time as an expression.
	if (!syntax.usesCommonJsExports) {
		expression ??= tryCompileExpression(source, sourceUrl);
		if (expression) {
			const module = createCommonJsModule();
			return expression(
				compatibleRequire,
				module,
				module.exports,
				moduleFilename(uri, identifier),
				moduleDirname(uri),
			);
		}
	}

	const module = createCommonJsModule();
	compileCommonJs(source, sourceUrl)(
		compatibleRequire,
		module,
		module.exports,
		moduleFilename(uri, identifier),
		moduleDirname(uri),
	);
	return getCommonJsExport(module, false);
}

interface CommonJsModule {
	exports: unknown;
}

type ModuleFactory = (
	require: (request: string) => unknown,
	module: CommonJsModule,
	exports: unknown,
	filename: string,
	dirname: string,
) => unknown;

function createCommonJsModule(): CommonJsModule {
	return { exports: {} };
}

function compileCommonJs(source: string, identifier: string): ModuleFactory {
	return new Function(
		"require",
		"module",
		"exports",
		"__filename",
		"__dirname",
		`"use strict";\n${source}\n//# sourceURL=latex-suite:${identifier}`,
	) as ModuleFactory;
}

function tryCompileExpression(source: string, identifier: string): ModuleFactory | null {
	const candidates = [source];
	const withoutTrailingSemicolon = source.trimEnd().replace(/;+$/, "");
	if (withoutTrailingSemicolon !== source.trimEnd()) {
		candidates.push(withoutTrailingSemicolon);
	}
	for (const candidate of candidates) {
		try {
			return new Function(
				"require",
				"module",
				"exports",
				"__filename",
				"__dirname",
				`"use strict";\nreturn (\n${candidate}\n);\n//# sourceURL=latex-suite:${identifier}`,
			) as ModuleFactory;
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw error;
			}
		}
	}
	return null;
}

function getCommonJsExport(module: CommonJsModule, requireDefault: boolean): unknown {
	if (typeof module.exports === "object" && module.exports !== null && "default" in module.exports) {
		return (module.exports as Record<string, unknown>).default;
	}
	if (requireDefault) {
		return undefined;
	}
	return module.exports;
}

function moduleFilename(uri: vscode.Uri | undefined, identifier: string): string {
	return uri?.scheme === "file" ? uri.fsPath : identifier;
}

function moduleDirname(uri: vscode.Uri | undefined): string {
	return uri?.scheme === "file" ? path.dirname(uri.fsPath) : "";
}

interface ModuleSyntax {
	exportDefault: { start: number; end: number } | null;
	usesCommonJsExports: boolean;
}

/** Parse module syntax so comments, strings, templates, and regexes stay opaque. */
function scanModuleSyntax(source: string): ModuleSyntax {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
	const declaration = program.body.find((node): node is ExportDefaultDeclaration =>
		node.type === "ExportDefaultDeclaration",
	);
	return {
		exportDefault: declaration
			? { start: declaration.start, end: declaration.declaration.start }
			: null,
		usesCommonJsExports: program.body.some(isCommonJsExportStatement),
	};
}

function isCommonJsExportStatement(node: Node): boolean {
	if (node.type !== "ExpressionStatement") {
		return false;
	}
	const expression = (node as ExpressionStatement).expression;
	return expression.type === "AssignmentExpression" &&
		isCommonJsExportTarget((expression as AssignmentExpression).left);
}

function isCommonJsExportTarget(node: Node): boolean {
	if (node.type !== "MemberExpression") {
		return false;
	}
	const member = node as MemberExpression;
	if (member.object.type === "Identifier" && (member.object as Identifier).name === "exports") {
		return true;
	}
	if (
		memberName(member) === "exports" &&
		member.object.type === "Identifier" &&
		(member.object as Identifier).name === "module"
	) {
		return true;
	}
	return member.object.type === "MemberExpression" && isCommonJsExportTarget(member.object);
}

function memberName(member: MemberExpression): string | null {
	if (!member.computed && member.property.type === "Identifier") {
		return (member.property as Identifier).name;
	}
	if (member.computed && member.property.type === "Literal") {
		const value = (member.property as Literal).value;
		return typeof value === "string" ? value : null;
	}
	return null;
}

function assertVariableObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected a snippet-variable object");
	}
	return value as Record<string, unknown>;
}

async function readSourceUri(uri: vscode.Uri, onRootType?: (directory: boolean) => void): Promise<SourceFile[]> {
	const stat = await vscode.workspace.fs.stat(uri);
	onRootType?.((stat.type & vscode.FileType.Directory) !== 0);
	if ((stat.type & vscode.FileType.Directory) === 0) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return [{ identifier: uri.toString(), source: new TextDecoder().decode(bytes), uri }];
	}

	const entries = await vscode.workspace.fs.readDirectory(uri);
	const sources: SourceFile[] = [];
	for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
		const child = vscode.Uri.joinPath(uri, name);
		if ((type & vscode.FileType.Directory) !== 0) {
			sources.push(...await readSourceUri(child));
		} else if ((type & vscode.FileType.File) !== 0) {
			const bytes = await vscode.workspace.fs.readFile(child);
			sources.push({ identifier: child.toString(), source: new TextDecoder().decode(bytes), uri: child });
		}
	}
	return sources;
}

export function resolveConfiguredUri(configuredPath: string, resource: vscode.Uri): vscode.Uri {
	// A Windows drive path (for example C:\\snippets.js) also looks like a URI
	// scheme. Resolve native absolute paths before applying the URI test.
	if (path.isAbsolute(configuredPath)) {
		return vscode.Uri.file(configuredPath);
	}
	if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(configuredPath)) {
		return vscode.Uri.parse(configuredPath, true);
	}
	const folder = vscode.workspace.getWorkspaceFolder(resource)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) {
		throw new Error(`Cannot resolve relative snippet path without a workspace folder: ${configuredPath}`);
	}
	return vscode.Uri.joinPath(folder, ...configuredPath.replaceAll("\\", "/").split("/").filter(Boolean));
}

function hasCustomSources(config: LatexSuiteConfig): boolean {
	return Boolean(
		config.snippets.source.trim() ||
		config.snippets.variablesSource.trim() ||
		config.snippets.files.length ||
		config.snippets.variableFiles.length,
	);
}

function formatError(identifier: string, error: unknown): string {
	const detail = error instanceof Error ? error.stack ?? error.message : String(error);
	return `[${identifier}] ${detail}`;
}
