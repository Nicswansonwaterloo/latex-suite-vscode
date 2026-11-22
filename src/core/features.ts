import type { CursorContext, LatexScope, MathBounds } from "./context";
import { findOpeningBracket } from "./context";
import type { ResultInsert, TabstopSpec } from "./nodes";

export interface EditPlan {
	start: number;
	end: number;
	replacement: ResultInsert;
}

export interface TextEditPlan {
	start: number;
	end: number;
	text: string;
}

export interface AutoFractionOptions {
	symbol: string;
	breakingCharacters: string;
	excludedRegions: readonly { open: string; close: string }[];
}

export interface MatrixOptions {
	environments: readonly string[];
	macros: readonly string[];
}

const GREEK_NAMES = "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega";
const GREEK_SPACE = new RegExp(`(\\\\(?:${GREEK_NAMES})) ([^ ])`, "g");

/** Port of the upstream backwards numerator scan, independent of an editor. */
export function planAutoFraction(
	source: string,
	cursor: number,
	context: CursorContext,
	options: AutoFractionOptions,
	selection?: { start: number; end: number; text: string },
	consumeUntil = cursor,
): EditPlan | null {
	if (!isStrictlyInMath(context) || !context.innerMathBounds) {
		return null;
	}
	if (options.excludedRegions.some((region) => isWithinDelimitedRegion(source, cursor, context.innerMathBounds!, region))) {
		return null;
	}

	let start: number;
	let numerator: string;
	if (selection && selection.start !== selection.end) {
		start = selection.start;
		numerator = selection.text;
	} else {
		const equationStart = context.innerMathBounds.inner_start;
		const original = source.slice(equationStart, cursor);
		const protectedText = original.replace(GREEK_SPACE, (_match, macro: string, next: string) => `${macro}#${next}`);
		start = equationStart;
		for (let index = protectedText.length - 1; index >= 0; index -= 1) {
			const character = protectedText[index];
			if (character === ")" || character === "]" || character === "}") {
				const opening = findOpeningBracket(protectedText, index);
				if (opening === null) {
					return null;
				}
				index = opening;
			}
			if (` $([{\n${options.breakingCharacters}`.includes(character)) {
				start = equationStart + index + 1;
				break;
			}
		}
		numerator = source.slice(start, cursor);
	}

	if (start === cursor && numerator.length === 0) {
		return null;
	}
	if (hasRedundantOuterParentheses(numerator)) {
		numerator = numerator.slice(1, -1);
	}

	const prefix = `${options.symbol}{`;
	const middle = "}{";
	const suffix = "}";
	const insert = prefix + numerator + middle + suffix;
	const tabstops: TabstopSpec[] = [];
	if (numerator.length === 0) {
		tabstops.push({ index: [0], from: prefix.length, to: prefix.length });
	}
	const denominatorOffset = prefix.length + numerator.length + middle.length;
	tabstops.push({ index: [1], from: denominatorOffset, to: denominatorOffset });
	tabstops.push({ index: [2], from: insert.length, to: insert.length });

	return {
		start,
		end: consumeUntil,
		replacement: { insert, tabstops },
	};
}

export function getMatrixScope(context: CursorContext, options: MatrixOptions): LatexScope | null {
	if (!isStrictlyInMath(context)) {
		return null;
	}
	const environments = new Set(options.environments);
	const macros = new Set(options.macros);
	for (const scope of context.latexStack) {
		if (scope.kind === "math") {
			continue;
		}
		if (scope.kind === "environment" && environments.has(scope.name)) {
			return scope;
		}
		if (scope.kind === "command" && macros.has(scope.name)) {
			return scope;
		}
		return null;
	}
	return null;
}

export function planMatrixCell(cursor: number): TextEditPlan {
	return { start: cursor, end: cursor, text: " & " };
}

export function planMatrixNewline(source: string, cursor: number, scope: LatexScope): EditPlan {
	const scopeText = source.slice(scope.outer_start, scope.outer_end);
	if (!scopeText.includes("\n")) {
		return {
			start: cursor,
			end: cursor,
			replacement: plainReplacement(" \\\\  "),
		};
	}

	const lineStart = source.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
	const linePrefix = source.slice(lineStart, cursor);
	const structuralPrefix = linePrefix.match(/(?:\\begin\{[^}]+\}|\\\\|^)((?:\s|&)+)/)?.[1]?.trimStart() ?? "";
	const text = " \\\\" + "\n" + structuralPrefix;
	return {
		start: cursor,
		end: cursor,
		replacement: plainReplacement(text),
	};
}

export function matrixExitTarget(source: string, cursor: number, scope: LatexScope): number {
	const scopeText = source.slice(scope.outer_start, scope.outer_end);
	if (!scopeText.includes("\n")) {
		return scope.outer_end;
	}
	const lineEnd = source.indexOf("\n", cursor);
	if (lineEnd < 0) {
		return scope.outer_end;
	}
	const nextLineEnd = source.indexOf("\n", lineEnd + 1);
	const nextEnd = nextLineEnd < 0 ? source.length : nextLineEnd;
	const nextLine = source.slice(lineEnd + 1, nextEnd);
	if (scope.kind === "environment") {
		const endPattern = new RegExp(`\\\\end\\{${escapeRegExp(scope.name)}\\}`);
		const match = endPattern.exec(nextLine);
		if (match?.index !== undefined) {
			return lineEnd + 1 + match.index + match[0].length;
		}
	}
	return nextEnd;
}

interface Token {
	text: string;
	start: number;
	end: number;
}

export const LEFT_COMMANDS = new Set(["\\left", "\\bigl", "\\Bigl", "\\biggl", "\\Biggl"]);
export const RIGHT_COMMANDS = new Set(["\\right", "\\bigr", "\\Bigr", "\\biggr", "\\Biggr"]);
export const BRACKET_PAIRS = new Map(Object.entries({
	"(": ")", "[": "]", "{": "}", "\\{": "\\}", "\\lbrace": "\\rbrace",
	"\\lparen": "\\rparen", "\\lbrack": "\\rbrack", "\\langle": "\\rangle",
	"\\lvert": "\\rvert", "\\lVert": "\\rVert", "\\lfloor": "\\rfloor",
	"\\lceil": "\\rceil", "\\ulcorner": "\\urcorner", "\\llcorner": "\\lrcorner",
	"\\lgroup": "\\rgroup", "\\lmoustache": "\\rmoustache",
}));
export const DELIMITERS = new Set([
	...BRACKET_PAIRS.keys(), ...BRACKET_PAIRS.values(),
	"<", ">", "\\lt", "\\gt", "|", "\\vert", "\\|", "\\Vert", "/", "\\\\", "\\backslash",
	"\\uparrow", "\\downarrow", "\\Uparrow", "\\Downarrow", "\\updownarrow", "\\Updownarrow", ".",
]);

/** Return an absolute target immediately after the next configured closer. */
export function findTabOutTarget(source: string, cursor: number, bounds: MathBounds, closingSymbols: ReadonlySet<string>): number | null {
	const text = source.slice(bounds.inner_start, bounds.inner_end);
	const relativeCursor = cursor - bounds.inner_start;
	const tokens = [...tokenizeLatex(text)];
	const first = tokens.findIndex((token) => token.end > relativeCursor);
	for (let index = first < 0 ? tokens.length : first; index < tokens.length; index += 1) {
		const token = tokens[index];
		const previous = tokens[index - 1];
		if (closingSymbols.has(token.text)) {
			if (previous && LEFT_COMMANDS.has(previous.text) && DELIMITERS.has(token.text)) {
				continue;
			}
			return bounds.inner_start + token.end;
		}
		if (RIGHT_COMMANDS.has(token.text)) {
			const next = tokens[index + 1];
			if (!next || !DELIMITERS.has(next.text)) {
				return bounds.inner_start + token.end;
			}
		}
	}
	return null;
}

/** Step before the preceding opener, even if it already has a matching closer. */
export function findReverseTabOutTarget(source: string, cursor: number, bounds: MathBounds, exitOnlyAtStart: boolean): number | null {
	let target: number | null = null;
	let previous = "";
	const relativeCursor = cursor - bounds.inner_start;
	const equation = source.slice(bounds.inner_start, bounds.inner_end);
	for (const token of tokenizeLatex(equation)) {
		if (token.start >= relativeCursor) {
			break;
		}
		if (/^\s/.test(token.text)) {
			continue;
		}
		if (LEFT_COMMANDS.has(token.text)) {
			target = bounds.inner_start + token.start;
		} else if ((BRACKET_PAIRS.has(token.text) || token.text === "<") && !LEFT_COMMANDS.has(previous) && !RIGHT_COMMANDS.has(previous)) {
			target = bounds.inner_start + token.start;
		}
		previous = token.text;
	}
	if (target !== null) {
		return target;
	}
	return exitOnlyAtStart && equation.slice(0, relativeCursor).trim() ? null : bounds.outer_start;
}

/** Used by the matrix Tab shortcut: only skip a closer not enclosed after the cursor. */
export function findUnenclosedClosingTarget(source: string, cursor: number, bounds: MathBounds, closingSymbols: ReadonlySet<string>): number | null {
	const tokens = tokenizeLatex(source.slice(cursor, bounds.inner_end));
	const stack: string[] = [];
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "\\{": "\\}", "\\lbrace": "\\rbrace", "\\langle": "\\rangle", "<": ">", "\\lvert": "\\rvert", "\\lVert": "\\rVert", "\\lfloor": "\\rfloor", "\\lceil": "\\rceil", "\\ulcorner": "\\urcorner" };
	const closers = new Set(Object.values(pairs).filter((value) => closingSymbols.has(value)));
	const openers = new Set(Object.keys(pairs).filter((value) => closers.has(pairs[value])));
	for (const token of tokens) {
		if (openers.has(token.text)) {
			stack.push(token.text);
		} else if (closers.has(token.text)) {
			if (stack.length === 0) {
				return cursor + token.end;
			}
			stack.pop();
		}
	}
	return null;
}

/**
 * Extracted non-visual part of upstream's bracket enlargement feature. The
 * returned insertions are sorted from right to left and can be applied safely.
 */
export function planBracketEnlargements(
	source: string,
	bounds: MathBounds,
	triggers: readonly string[],
	insertSpaces: boolean,
): TextEditPlan[] {
	const offset = bounds.inner_start;
	const text = source.slice(bounds.inner_start, bounds.inner_end);
	const tokens = [...tokenizeLatex(text)];
	const pairs: Record<string, string> = {
		"(": ")", "[": "]", "\\{": "\\}", "\\lbrace": "\\rbrace", "\\langle": "\\rangle",
		"\\lvert": "\\rvert", "\\lVert": "\\rVert", "\\lfloor": "\\rfloor", "\\lceil": "\\rceil", "\\ulcorner": "\\urcorner",
	};
	const structuralPairs: Record<string, string> = { ...pairs, "{": "}" };
	const reverse = new Map(Object.entries(structuralPairs).map(([open, close]) => [close, open]));
	const stack: Array<{ token: Token; tokenIndex: number; close: string }> = [];
	const edits: TextEditPlan[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.text in structuralPairs) {
			stack.push({ token, tokenIndex: index, close: structuralPairs[token.text] });
			continue;
		}
		const expected = reverse.get(token.text);
		if (!expected) {
			continue;
		}
		const opening = stack.at(-1);
		if (!opening || opening.token.text !== expected || opening.close !== token.text) {
			continue;
		}
		stack.pop();
		if (opening.token.text === "{") {
			continue;
		}
		const beforeOpening = tokens[opening.tokenIndex - 1];
		const beforeClosing = tokens[index - 1];
		if ((beforeOpening && LEFT_COMMANDS.has(beforeOpening.text)) || (beforeClosing && RIGHT_COMMANDS.has(beforeClosing.text))) {
			continue;
		}
		const prefix = text.slice(Math.max(0, opening.token.start - 12), opening.token.start);
		if (/\\(?:big|Big|bigg|Bigg|bigl|Bigl|biggl|Biggl)\s*$/.test(prefix)) {
			continue;
		}
		const content = text.slice(opening.token.end, token.start);
		if (!triggers.some((trigger) => content.includes(trigger))) {
			continue;
		}
		const space = insertSpaces ? " " : "";
		edits.push(
			{ start: offset + token.start, end: offset + token.start, text: `${space}\\right` },
			{ start: offset + opening.token.end, end: offset + opening.token.end, text: space },
			{ start: offset + opening.token.start, end: offset + opening.token.start, text: "\\left" },
		);
	}
	return edits.sort((left, right) => right.start - left.start);
}

export function isInMath(context: CursorContext): boolean {
	return context.mode.inlineMath || context.mode.blockMath || context.mode.codeMath;
}

export function isStrictlyInMath(context: CursorContext): boolean {
	return isInMath(context) && !context.mode.textEnv && !context.mode.snippetlessEnv;
}

export function plainReplacement(text: string, tabstopIndex?: number): ResultInsert {
	return {
		insert: text,
		tabstops: tabstopIndex === undefined ? [] : [{ index: [tabstopIndex], from: text.length, to: text.length }],
	};
}

function* tokenizeLatex(source: string): Generator<Token> {
	for (const match of source.matchAll(/%[^\r\n]*|\\(?:[A-Za-z]+\*?|.)|[\s\S]/g)) {
		yield { text: match[0], start: match.index, end: match.index + match[0].length };
	}
}

function isWithinDelimitedRegion(source: string, cursor: number, bounds: MathBounds, region: { open: string; close: string }): boolean {
	let opening = source.lastIndexOf(region.open, cursor - 1);
	while (opening >= bounds.inner_start) {
		const bracketOffset = opening + region.open.length - 1;
		let closing: number;
		if ("{[(".includes(region.open.at(-1) ?? "") && region.close.length === 1) {
			closing = findForwardMatch(source, bracketOffset, region.open.at(-1)!, region.close);
		} else {
			closing = source.indexOf(region.close, opening + region.open.length);
		}
		if (closing < 0 || closing >= cursor) {
			return true;
		}
		opening = source.lastIndexOf(region.open, opening - 1);
	}
	return false;
}

function findForwardMatch(source: string, opening: number, open: string, close: string): number {
	let depth = 0;
	for (let index = opening; index < source.length; index += 1) {
		if (source[index] === open) {
			depth += 1;
		} else if (source[index] === close) {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function hasRedundantOuterParentheses(value: string): boolean {
	if (!value.startsWith("(") || !value.endsWith(")")) {
		return false;
	}
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "(") {
			depth += 1;
		} else if (value[index] === ")") {
			depth -= 1;
			if (depth === 0 && index !== value.length - 1) {
				return false;
			}
		}
	}
	return depth === 0;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
