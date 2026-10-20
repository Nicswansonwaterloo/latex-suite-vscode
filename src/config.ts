import * as vscode from "vscode";

export type DebugLevel = "off" | "info" | "verbose";

export interface DelimitedRegion {
	open: string;
	close: string;
}

export interface LatexSuiteConfig {
	enabled: boolean;
	snippets: {
		enabled: boolean;
		files: string[];
		source: string;
		variableFiles: string[];
		variablesSource: string;
		recursionLimit: number;
		wordDelimiters: string;
		removeTrailingWhitespace: boolean;
	};
	forceMathLanguages: string[];
	autoFraction: {
		enabled: boolean;
		symbol: string;
		breakingCharacters: string;
		excludedRegions: DelimitedRegion[];
	};
	matrixShortcuts: {
		enabled: boolean;
		environments: string[];
		macros: string[];
	};
	tabOut: {
		enabled: boolean;
		closingSymbols: Set<string>;
		exitEquationOnlyAtEndOfLine: boolean;
	};
	bracketEnlargement: {
		enabled: boolean;
		triggers: string[];
		insertSpaces: boolean;
	};
	debug: DebugLevel;
}

const DEFAULT_WORD_DELIMITERS = "., +-\n\t:;!?\\/{}[]()=~$'\"|`<>*^%#@&";

export function getConfig(document: vscode.TextDocument): LatexSuiteConfig {
	const config = vscode.workspace.getConfiguration("latexSuite", document);
	return {
		enabled: config.get("enabled", true),
		snippets: {
			enabled: config.get("snippets.enabled", true),
			files: config.get<string[]>("snippets.files", []),
			source: config.get("snippets.source", ""),
			variableFiles: config.get<string[]>("snippets.variableFiles", []),
			variablesSource: config.get("snippets.variablesSource", ""),
			recursionLimit: clamp(config.get("snippets.recursionLimit", 0), 0, 10),
			wordDelimiters: decodeEscapes(config.get("snippets.wordDelimiters", DEFAULT_WORD_DELIMITERS)),
			removeTrailingWhitespace: config.get("snippets.removeTrailingWhitespace", true),
		},
		forceMathLanguages: config.get<string[]>("forceMathLanguages", ["math"]),
		autoFraction: {
			enabled: config.get("autoFraction.enabled", true),
			symbol: config.get("autoFraction.symbol", "\\frac"),
			breakingCharacters: decodeEscapes(config.get("autoFraction.breakingCharacters", "+-=\\t")),
			excludedRegions: config.get<DelimitedRegion[]>("autoFraction.excludedRegions", [
				{ open: "^{", close: "}" },
				{ open: "\\pu{", close: "}" },
			]),
		},
		matrixShortcuts: {
			enabled: config.get("matrixShortcuts.enabled", true),
			environments: config.get<string[]>("matrixShortcuts.environments", [
				"pmatrix", "cases", "align", "gather", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "array", "matrix",
			]),
			macros: config.get<string[]>("matrixShortcuts.macros", ["eqalign"]),
		},
		tabOut: {
			enabled: config.get("tabOut.enabled", true),
			closingSymbols: new Set(config.get<string[]>("tabOut.closingSymbols", [
				")", "]", "\\rbrack", "\\}", "\\rbrace", "\\rangle", "\\rvert", "\\rVert", "\\rfloor", "\\rceil", "\\urcorner", "}",
			])),
			exitEquationOnlyAtEndOfLine: config.get("tabOut.exitEquationOnlyAtEndOfLine", true),
		},
		bracketEnlargement: {
			enabled: config.get("bracketEnlargement.enabled", true),
			triggers: config.get<string[]>("bracketEnlargement.triggers", [
				"\\sum", "\\int", "\\frac", "\\prod", "\\bigcup", "\\bigcap",
			]),
			insertSpaces: config.get("bracketEnlargement.insertSpaces", true),
		},
		debug: config.get<DebugLevel>("debug", "off"),
	};
}

export function isSupportedDocument(document: vscode.TextDocument): boolean {
	const extensions = vscode.workspace.getConfiguration("latexSuite", document)
		.get<string[]>("fileExtensions", [".tex", ".md", ".qmd"]);
	const filename = document.uri.path.split("/").pop() ?? "";
	const dot = filename.lastIndexOf(".");
	const extension = dot >= 0
		? filename.slice(dot).toLowerCase()
		: document.isUntitled
			? document.languageId === "latex" ? ".tex" : document.languageId === "markdown" ? ".md" : ""
			: "";
	return extension !== "" && extensions.some(entry => {
		const normalized = entry.trim().toLowerCase();
		return (normalized.startsWith(".") ? normalized : `.${normalized}`) === extension;
	});
}

function decodeEscapes(value: string): string {
	return value.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
