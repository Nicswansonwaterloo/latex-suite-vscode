/**
 * Dependency-free editor context scanner.
 *
 * The mode and scope semantics are adapted from Obsidian LaTeX Suite's
 * `editor_context` implementation (MIT licensed).  The syntax-tree dependent
 * parts have deliberately been replaced with a deterministic text scanner so
 * this module can be used from VS Code and unit tests without editor imports.
 *
 * This is an editing scanner, not a complete TeX or CommonMark parser.  It
 * understands the constructs which affect snippet expansion, balances ordinary
 * macro arguments and environments, and gives useful bounds for unfinished
 * input.  It does not expand TeX definitions or interpret catcode changes.
 */

export type DocumentLanguage = "markdown" | "latex";

export type ContextKind =
	| "text"
	| "inlineMath"
	| "blockMath"
	| "codeMath"
	| "codeBlock"
	| "inlineCode"
	| "latexComment";

/** Offsets use the half-open outer interval and the delimiter-free inner interval. */
export interface Bounds {
	inner_start: number;
	inner_end: number;
	outer_start: number;
	outer_end: number;
}

export type MathMode = "inlineMath" | "blockMath" | "codeMath";

export interface MathBounds extends Bounds {
	mode: MathMode;
	delimiter: string;
	/** False for an unterminated construct while the user is still typing. */
	closed: boolean;
}

export interface CodeBlockContext extends Bounds {
	language: string;
	fence: "`" | "~";
	fenceLength: number;
	closed: boolean;
}

export interface InlineCodeContext extends Bounds {
	markerLength: number;
	closed: boolean;
}

export interface LatexCommentContext extends Bounds {
	kind: "comment";
}

export interface EnvironmentContext extends Bounds {
	kind: "environment";
	name: string;
	closed: boolean;
}

export type MacroArgumentKind = "required" | "optional";

export interface MacroContext extends Bounds {
	kind: "command";
	/** Command name without the leading backslash, retaining a trailing star. */
	name: string;
	/** Zero-based index among all bracketed arguments of this invocation. */
	argumentIndex: number;
	/** Zero-based index among `{...}` arguments, or null for `[...]`. */
	requiredArgumentIndex: number | null;
	argumentKind: MacroArgumentKind;
	command_start: number;
	command_end: number;
	closed: boolean;
}

export interface MathStackContext extends Bounds {
	kind: "math";
	mode: "inlineMath" | "blockMath";
}

export type LatexScope = EnvironmentContext | MacroContext | MathStackContext;

/** Mirrors upstream snippet-mode fields while keeping the result serializable. */
export interface ContextMode {
	text: boolean;
	inlineMath: boolean;
	blockMath: boolean;
	codeMath: boolean;
	codeBlock: string | false;
	code: boolean;
	comment: boolean;
	textEnv: boolean;
	snippetlessEnv: boolean;
}

export interface MacroArea {
	name: string;
	/** Required-argument indexes. Omit to match every argument. */
	arguments?: readonly number[];
}

export interface ContextScanOptions {
	language?: DocumentLanguage;
	/** Markdown fence info strings which should be parsed as display math. */
	mathFenceLanguages?: Iterable<string>;
	/** Case-sensitive fence-language matching is off by default. */
	caseSensitiveFenceLanguages?: boolean;
	textMacros?: readonly MacroArea[];
	snippetlessMacros?: readonly MacroArea[];
	mathEnvironments?: Iterable<string>;
}

export interface CursorContext {
	offset: number;
	language: DocumentLanguage;
	kind: ContextKind;
	mode: ContextMode;
	mathBounds: MathBounds | null;
	/** The innermost nested equation; otherwise the same object as mathBounds. */
	innerMathBounds: MathBounds | null;
	codeBlock: CodeBlockContext | null;
	codeBlockLanguage: string | null;
	inlineCode: InlineCodeContext | null;
	comment: LatexCommentContext | null;
	/** Enclosing environments, nearest first. */
	environments: EnvironmentContext[];
	/** Enclosing macro arguments, nearest first. */
	macros: MacroContext[];
	/** Macro/environment/nested-math scopes in source nesting order, nearest first. */
	latexStack: LatexScope[];
}

export interface SnippetContextRequirements {
	/** LaTeX Suite mode flags. Non-mode flags (A, r, w, v, U) are ignored here. */
	options?: string;
	language?: string;
	excludedEnvironments?: readonly string[];
	excludedMacros?: readonly (string | MacroArea)[];
	includedMacros?: readonly (string | MacroArea)[];
}

export const DEFAULT_TEXT_MACROS: readonly MacroArea[] = [
	{ name: "text", arguments: [0] },
	{ name: "textrm", arguments: [0] },
	{ name: "textup", arguments: [0] },
	{ name: "textit", arguments: [0] },
	{ name: "textbf", arguments: [0] },
	{ name: "textsf", arguments: [0] },
	{ name: "texttt", arguments: [0] },
	{ name: "textnormal", arguments: [0] },
	{ name: "clap", arguments: [0] },
	{ name: "textllap", arguments: [0] },
	{ name: "textrlap", arguments: [0] },
	{ name: "textclap", arguments: [0] },
	{ name: "hbox", arguments: [0] },
	{ name: "mbox", arguments: [0] },
	{ name: "fbox", arguments: [0] },
	{ name: "framebox", arguments: [0] },
	{ name: "colorbox", arguments: [1] },
	{ name: "fcolorbox", arguments: [2] },
];

export const DEFAULT_SNIPPETLESS_MACROS: readonly MacroArea[] = [
	{ name: "tag", arguments: [0] },
	{ name: "begin", arguments: [0] },
	{ name: "end", arguments: [0] },
	{ name: "mmlToken", arguments: [0, 1] },
	{ name: "unicode", arguments: [0] },
	{ name: "textcolor", arguments: [0] },
	{ name: "color", arguments: [0] },
	{ name: "colorbox", arguments: [0] },
	{ name: "fcolorbox", arguments: [0, 1] },
	{ name: "operatorname", arguments: [0] },
	{ name: "style", arguments: [0] },
];

export const DEFAULT_MATH_ENVIRONMENTS: ReadonlySet<string> = new Set([
	"math",
	"displaymath",
	"equation",
	"equation*",
	"eqnarray",
	"eqnarray*",
	"align",
	"align*",
	"alignat",
	"alignat*",
	"aligned",
	"alignedat",
	"gather",
	"gather*",
	"gathered",
	"multline",
	"multline*",
	"flalign",
	"flalign*",
	"split",
	"cases",
	"dcases",
	"dcases*",
	"matrix",
	"pmatrix",
	"bmatrix",
	"Bmatrix",
	"vmatrix",
	"Vmatrix",
	"smallmatrix",
	"array",
]);

export interface OffsetRange {
	start: number;
	end: number;
}

interface FenceRecord extends CodeBlockContext {
	openLineEnd: number;
	closeLineStart: number;
}

interface CommandToken {
	start: number;
	end: number;
	name: string;
}

interface BracketPair {
	open: number;
	close: number;
	closed: boolean;
}

const BRACKET_CLOSE: Readonly<Record<string, string>> = {
	"(": ")",
	"[": "]",
	"{": "}",
};

function clampOffset(source: string, offset: number): number {
	if (!Number.isFinite(offset)) {
		return 0;
	}
	return Math.max(0, Math.min(source.length, Math.trunc(offset)));
}

/** True when the character at offset is preceded by an odd backslash run. */
export function isEscaped(source: string, offset: number): boolean {
	let backslashes = 0;
	for (let index = offset - 1; index >= 0 && source[index] === "\\"; index--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function containsCursor(bounds: Bounds, offset: number): boolean {
	return offset >= bounds.inner_start && offset <= bounds.inner_end;
}

/**
 * Membership lookup for a union of half-open intervals.
 *
 * Context scanning asks this question once per source character in several
 * passes. Keeping the raw intervals in an array and calling `some` there makes
 * documents with many code spans or comments quadratic. Normalize the union
 * once, then use an upper-bound search for each lookup.
 */
class IntervalLookup {
	private readonly intervals: readonly OffsetRange[];

	constructor(intervals: readonly OffsetRange[]) {
		const ordered = intervals
			.filter((interval) => interval.end > interval.start)
			.map((interval) => ({ ...interval }))
			.sort((left, right) => left.start - right.start || left.end - right.end);
		const merged: OffsetRange[] = [];
		for (const interval of ordered) {
			const previous = merged.at(-1);
			if (previous && interval.start <= previous.end) {
				previous.end = Math.max(previous.end, interval.end);
			} else {
				merged.push(interval);
			}
		}
		this.intervals = merged;
	}

	has(offset: number): boolean {
		let low = 0;
		let high = this.intervals.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (this.intervals[middle].start <= offset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		const candidate = this.intervals[low - 1];
		return candidate !== undefined && offset < candidate.end;
	}
}

/** Convert the scanner's inclusive cursor bounds to half-open intervals. */
function cursorBoundsLookup(bounds: readonly Bounds[]): IntervalLookup {
	return new IntervalLookup(bounds.map((item) => ({
		start: item.inner_start,
		end: item.inner_end + 1,
	})));
}

function normalizeLanguage(language: string, caseSensitive: boolean): string {
	return caseSensitive ? language : language.toLowerCase();
}

function scanFences(source: string): FenceRecord[] {
	const result: FenceRecord[] = [];
	let open: { start: number; lineEnd: number; marker: "`" | "~"; length: number; language: string } | null = null;
	let lineStart = 0;

	while (lineStart <= source.length) {
		const newline = source.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? source.length : newline;
		const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, "");
		const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(rawLine);

		if (match) {
			const marker = match[2][0] as "`" | "~";
			const length = match[2].length;
			if (!open) {
				const info = match[3].trim();
				// The first info-string word is what VS Code language selectors use.
				const language = info.split(/\s+/, 1)[0] ?? "";
				open = { start: lineStart + match[1].length, lineEnd, marker, length, language };
			} else if (marker === open.marker && length >= open.length && match[3].trim() === "") {
				const outerEnd = lineStart + match[1].length + length;
				result.push({
					outer_start: open.start,
					outer_end: outerEnd,
					inner_start: Math.min(source.length, open.lineEnd + (open.lineEnd < source.length ? 1 : 0)),
					inner_end: lineStart,
					openLineEnd: open.lineEnd,
					closeLineStart: lineStart,
					language: open.language,
					fence: open.marker,
					fenceLength: open.length,
					closed: true,
				});
				open = null;
			}
		}

		if (newline === -1) {
			break;
		}
		lineStart = newline + 1;
	}

	if (open) {
		result.push({
			outer_start: open.start,
			outer_end: source.length,
			inner_start: Math.min(source.length, open.lineEnd + (open.lineEnd < source.length ? 1 : 0)),
			inner_end: source.length,
			openLineEnd: open.lineEnd,
			closeLineStart: source.length,
			language: open.language,
			fence: open.marker,
			fenceLength: open.length,
			closed: false,
		});
	}

	return result;
}

function fenceMathBounds(fence: FenceRecord): MathBounds {
	return {
		inner_start: fence.inner_start, inner_end: fence.inner_end,
		outer_start: fence.outer_start, outer_end: fence.outer_end,
		mode: "codeMath", delimiter: fence.fence.repeat(fence.fenceLength), closed: fence.closed,
	};
}

function fenceAt(records: readonly FenceRecord[], offset: number): FenceRecord | null {
	for (const fence of records) {
		// Fence marker lines themselves are Markdown, matching upstream behavior.
		if (
			offset >= fence.inner_start &&
			(offset < fence.inner_end ||
				(!fence.closed && offset === fence.inner_end && fence.openLineEnd < fence.inner_start))
		) {
			return fence;
		}
	}
	return null;
}

function scanInlineCode(source: string, fences: readonly FenceRecord[]): InlineCodeContext[] {
	const result: InlineCodeContext[] = [];
	const fenceIntervals = new IntervalLookup(
		fences.map((fence) => ({ start: fence.outer_start, end: fence.outer_end })),
	);
	let index = 0;

	while (index < source.length) {
		if (source[index] !== "`" || isEscaped(source, index) || fenceIntervals.has(index)) {
			index++;
			continue;
		}
		let markerLength = 1;
		while (source[index + markerLength] === "`") {
			markerLength++;
		}
		const marker = "`".repeat(markerLength);
		let close = source.indexOf(marker, index + markerLength);
		while (close !== -1 && (source[close - 1] === "`" || source[close + markerLength] === "`")) {
			close = source.indexOf(marker, close + markerLength);
		}
		if (close === -1 || fenceIntervals.has(close)) {
			const lineEnd = source.indexOf("\n", index + markerLength);
			const end = lineEnd === -1 ? source.length : lineEnd;
			result.push({
				outer_start: index,
				outer_end: end,
				inner_start: index + markerLength,
				inner_end: end,
				markerLength,
				closed: false,
			});
			index = end;
			continue;
		}
		result.push({
			outer_start: index,
			outer_end: close + markerLength,
			inner_start: index + markerLength,
			inner_end: close,
			markerLength,
			closed: true,
		});
		index = close + markerLength;
	}
	return result;
}

function scanComments(source: string, ignored: IntervalLookup): LatexCommentContext[] {
	const comments: LatexCommentContext[] = [];
	let index = 0;
	while (index < source.length) {
		if (source[index] !== "%" || isEscaped(source, index) || ignored.has(index)) {
			index++;
			continue;
		}
		const newline = source.indexOf("\n", index + 1);
		const end = newline === -1 ? source.length : newline;
		comments.push({
			kind: "comment",
			outer_start: index,
			outer_end: end,
			inner_start: index,
			inner_end: end,
		});
		index = end;
	}
	return comments;
}

function scanCommandTokens(source: string, ignored: IntervalLookup): CommandToken[] {
	const commands: CommandToken[] = [];
	let index = 0;
	while (index < source.length) {
		if (source[index] !== "\\" || isEscaped(source, index) || ignored.has(index)) {
			index++;
			continue;
		}
		const start = index;
		index++;
		if (/[A-Za-z@]/.test(source[index] ?? "")) {
			while (/[A-Za-z@]/.test(source[index] ?? "")) {
				index++;
			}
			if (source[index] === "*") {
				index++;
			}
		} else if (index < source.length) {
			index++;
		}
		const rawName = source.slice(start + 1, index);
		if (/^[A-Za-z@]+\*?$/.test(rawName)) {
			commands.push({ start, end: index, name: rawName });
		}
	}
	return commands;
}

function makeIgnoredIntervals(
	language: DocumentLanguage,
	fences: readonly FenceRecord[],
	inlineCode: readonly InlineCodeContext[],
): OffsetRange[] {
	if (language === "latex") {
		return [];
	}
	return [
		...fences.map((item) => ({ start: item.outer_start, end: item.outer_end })),
		...inlineCode.map((item) => ({ start: item.outer_start, end: item.outer_end })),
	];
}

function lineEndAfter(source: string, offset: number): number {
	const newline = source.indexOf("\n", offset);
	return newline === -1 ? source.length : newline;
}

function collectDollarMath(source: string, ignored: IntervalLookup): MathBounds[] {
	const result: MathBounds[] = [];
	for (const size of [2, 1] as const) {
		const delimiter = "$".repeat(size);
		let open: number | null = null;
		let index = 0;
		while (index < source.length) {
			if (source[index] !== "$" || isEscaped(source, index) || ignored.has(index)) {
				index++;
				continue;
			}
			let runLength = 1;
			while (source[index + runLength] === "$") {
				runLength++;
			}
			if (runLength !== size) {
				index += runLength;
				continue;
			}
			if (open === null) {
				open = index;
			} else {
				result.push({
					outer_start: open,
					outer_end: index + size,
					inner_start: open + size,
					inner_end: index,
					mode: size === 1 ? "inlineMath" : "blockMath",
					delimiter,
					closed: true,
				});
				open = null;
			}
			index += runLength;
		}
		if (open !== null) {
			const end = size === 1 ? lineEndAfter(source, open + size) : source.length;
			result.push({
				outer_start: open,
				outer_end: end,
				inner_start: open + size,
				inner_end: end,
				mode: size === 1 ? "inlineMath" : "blockMath",
				delimiter,
				closed: false,
			});
		}
	}
	return result;
}

function collectCommandDelimitedMath(source: string, ignored: IntervalLookup, unmatched?: OffsetRange[]): MathBounds[] {
	const result: MathBounds[] = [];
	const pairs = [
		{ open: "\\(", close: "\\)", mode: "inlineMath" as const },
		{ open: "\\[", close: "\\]", mode: "blockMath" as const },
	];

	for (const pair of pairs) {
		let open: number | null = null;
		let index = 0;
		while (index < source.length - 1) {
			if (source[index] !== "\\" || isEscaped(source, index) || ignored.has(index)) {
				index++;
				continue;
			}
			const token = source.slice(index, index + 2);
			if (token === pair.open && open === null) {
				open = index;
				index += 2;
				continue;
			}
			if (token === pair.close && open !== null) {
				result.push({
					outer_start: open,
					outer_end: index + 2,
					inner_start: open + 2,
					inner_end: index,
					mode: pair.mode,
					delimiter: `${pair.open}${pair.close}`,
					closed: true,
				});
				open = null;
				index += 2;
				continue;
			}
			if (token === pair.open || token === pair.close) {
				unmatched?.push({ start: index, end: index + 2 });
			}
			index++;
		}
		if (open !== null) {
			result.push({
				outer_start: open,
				outer_end: source.length,
				inner_start: open + 2,
				inner_end: source.length,
				mode: pair.mode,
				delimiter: `${pair.open}${pair.close}`,
				closed: false,
			});
		}
	}
	return result;
}

function buildBracePairs(source: string, ignored: IntervalLookup): Map<number, BracketPair> {
	const pairs = new Map<number, BracketPair>();
	const stacks: Record<string, number[]> = { "{": [], "[": [], "(": [] };
	for (let index = 0; index < source.length; index++) {
		if (ignored.has(index) || isEscaped(source, index)) {
			continue;
		}
		const character = source[index];
		if (character in BRACKET_CLOSE) {
			stacks[character].push(index);
			continue;
		}
		const opening = character === "}" ? "{" : character === "]" ? "[" : character === ")" ? "(" : null;
		if (opening) {
			const open = stacks[opening].pop();
			if (open !== undefined) {
				pairs.set(open, { open, close: index, closed: true });
			}
		}
	}
	for (const stack of Object.values(stacks)) {
		for (const open of stack) {
			pairs.set(open, { open, close: source.length, closed: false });
		}
	}
	return pairs;
}

function findEnvironmentName(
	source: string,
	command: CommandToken,
	pairs: ReadonlyMap<number, BracketPair>,
): { name: string; pair: BracketPair } | null {
	let index = command.end;
	while (/\s/.test(source[index] ?? "")) {
		index++;
	}
	if (source[index] !== "{") {
		return null;
	}
	const pair = pairs.get(index);
	if (!pair || !pair.closed) {
		return null;
	}
	const name = source.slice(index + 1, pair.close).trim();
	return name ? { name, pair } : null;
}

function collectEnvironments(
	source: string,
	commands: readonly CommandToken[],
	pairs: ReadonlyMap<number, BracketPair>,
	onUnmatchedEnd?: (name: string, start: number, end: number) => void,
): EnvironmentContext[] {
	const environments: EnvironmentContext[] = [];
	const stack: { command: CommandToken; name: string; namePair: BracketPair }[] = [];
	for (const command of commands) {
		if (command.name !== "begin" && command.name !== "end") {
			continue;
		}
		const parsed = findEnvironmentName(source, command, pairs);
		if (!parsed) {
			continue;
		}
		if (command.name === "begin") {
			stack.push({ command, name: parsed.name, namePair: parsed.pair });
			continue;
		}
		let matching = stack.length - 1;
		while (matching >= 0 && stack[matching].name !== parsed.name) {
			matching--;
		}
		if (matching < 0) {
			onUnmatchedEnd?.(parsed.name, command.start, parsed.pair.close + 1);
			continue;
		}
		const begin = stack[matching];
		stack.splice(matching, 1);
		environments.push({
			kind: "environment",
			name: begin.name,
			outer_start: begin.command.start,
			outer_end: parsed.pair.close + 1,
			inner_start: begin.namePair.close + 1,
			inner_end: command.start,
			closed: true,
		});
	}
	for (const begin of stack) {
		environments.push({
			kind: "environment",
			name: begin.name,
			outer_start: begin.command.start,
			outer_end: source.length,
			inner_start: begin.namePair.close + 1,
			inner_end: source.length,
			closed: false,
		});
	}
	return environments;
}

function collectMacros(
	source: string,
	commands: readonly CommandToken[],
	pairs: ReadonlyMap<number, BracketPair>,
): MacroContext[] {
	const macros: MacroContext[] = [];
	for (const command of commands) {
		let index = command.end;
		let argumentIndex = 0;
		let requiredArgumentIndex = 0;
		while (index < source.length) {
			while (/\s/.test(source[index] ?? "")) {
				index++;
			}
			const opener = source[index];
			if (opener !== "{" && opener !== "[") {
				break;
			}
			const pair = pairs.get(index);
			if (!pair) {
				break;
			}
			const required = opener === "{";
			macros.push({
				kind: "command",
				name: command.name,
				argumentIndex,
				requiredArgumentIndex: required ? requiredArgumentIndex : null,
				argumentKind: required ? "required" : "optional",
				command_start: command.start,
				command_end: command.end,
				outer_start: index,
				outer_end: pair.closed ? pair.close + 1 : pair.close,
				inner_start: index + 1,
				inner_end: pair.close,
				closed: pair.closed,
			});
			argumentIndex++;
			if (required) {
				requiredArgumentIndex++;
			}
			if (!pair.closed) {
				break;
			}
			index = pair.close + 1;
		}
	}
	return macros;
}

function byInnerFirst<T extends Bounds>(left: T, right: T): number {
	const leftWidth = left.outer_end - left.outer_start;
	const rightWidth = right.outer_end - right.outer_start;
	return leftWidth - rightWidth || right.outer_start - left.outer_start;
}

function macroMatches(macro: MacroContext, areas: readonly MacroArea[]): boolean {
	const area = areas.find((candidate) => candidate.name === macro.name);
	if (!area) {
		return false;
	}
	return area.arguments === undefined ||
		(macro.requiredArgumentIndex !== null && area.arguments.includes(macro.requiredArgumentIndex));
}

function scopesAfterInnerMath(macros: readonly MacroContext[], innerMath: MathBounds | null): MacroContext[] {
	if (!innerMath) {
		return [...macros];
	}
	return macros.filter((macro) => macro.command_start >= innerMath.inner_start);
}

function makeMode(
	kind: ContextKind,
	codeBlock: FenceRecord | null,
	textEnv: boolean,
	snippetlessEnv: boolean,
): ContextMode {
	return {
		text: kind === "text",
		inlineMath: kind === "inlineMath",
		blockMath: kind === "blockMath",
		codeMath: kind === "codeMath",
		codeBlock: kind === "codeBlock" ? (codeBlock?.language ?? "") : false,
		code: kind === "inlineCode",
		comment: kind === "latexComment",
		textEnv,
		snippetlessEnv,
	};
}

/**
 * Classify one cursor offset.  Cursor positions on an opening delimiter's end
 * and immediately before a closing delimiter count as inside the construct.
 */
export interface ParsedContext {
	at(offset: number): CursorContext;
	readonly mathRegions: readonly MathBounds[];
	readonly unmatchedMathDelimiters: readonly OffsetRange[];
	readonly textArguments: readonly Bounds[];
	/** TeX comments and Markdown code/marker spans excluded by the scanner. */
	isIgnored(offset: number): boolean;
}

/** Parse once per source revision; cursor movement only queries the parsed ranges. */
export function parseContext(source: string, options: ContextScanOptions = {}): ParsedContext {
	const language = options.language ?? "markdown";
	const fences = language === "markdown" ? scanFences(source) : [];
	const inlineCodes = language === "markdown" ? scanInlineCode(source, fences) : [];

	const caseSensitive = options.caseSensitiveFenceLanguages ?? false;
	const configuredMathLanguages = options.mathFenceLanguages ?? ["math"];
	const mathFenceLanguages = new Set(
		Array.from(configuredMathLanguages, (item) => normalizeLanguage(item, caseSensitive)),
	);
	const mathFences: FenceRecord[] = [];
	const nonMathFences: FenceRecord[] = [];
	for (const fence of fences) {
		const target = mathFenceLanguages.has(normalizeLanguage(fence.language, caseSensitive))
			? mathFences
			: nonMathFences;
		target.push(fence);
	}
	const baseIgnoredIntervals = makeIgnoredIntervals(language, nonMathFences, inlineCodes);
	// Parse the contents, but never the marker/info lines, of a math fence.
	for (const fence of mathFences) {
		baseIgnoredIntervals.push({ start: fence.outer_start, end: fence.inner_start });
		if (fence.closed) {
			baseIgnoredIntervals.push({ start: fence.inner_end, end: fence.outer_end });
		}
	}
	const baseIgnored = new IntervalLookup(baseIgnoredIntervals);

	// Markdown `%` is ordinary prose outside math. Discover provisional math
	// without comment suppression, then enable TeX comments only in those ranges.
	const rawComments = scanComments(source, baseIgnored);
	const provisionalCommands = scanCommandTokens(source, baseIgnored);
	const provisionalPairs = buildBracePairs(source, baseIgnored);
	const provisionalEnvironments = collectEnvironments(source, provisionalCommands, provisionalPairs);
	const mathEnvironmentNames = new Set(options.mathEnvironments ?? DEFAULT_MATH_ENVIRONMENTS);
	const provisionalMath = [
		...collectDollarMath(source, baseIgnored),
		...collectCommandDelimitedMath(source, baseIgnored),
		...provisionalEnvironments
			.filter((environment) => mathEnvironmentNames.has(environment.name))
			.map((environment): MathBounds => ({
				...environment,
				mode: environment.name === "math" ? "inlineMath" : "blockMath",
				delimiter: `\\begin{${environment.name}}`,
			})),
	];
	const provisionalMathLookup = cursorBoundsLookup([...provisionalMath, ...mathFences]);
	const comments = language === "latex"
		? rawComments
		: rawComments.filter((comment) => provisionalMathLookup.has(comment.outer_start));
	const commentIntervals = comments.map((item) => ({ start: item.outer_start, end: item.outer_end }));
	const latexIgnored = new IntervalLookup([...baseIgnoredIntervals, ...commentIntervals]);
	const commands = scanCommandTokens(source, latexIgnored);
	const bracePairs = buildBracePairs(source, latexIgnored);
	const unmatchedMathDelimiters: OffsetRange[] = [];
	const allEnvironments = collectEnvironments(source, commands, bracePairs, (name, start, end) => {
		if (mathEnvironmentNames.has(name)) {
			unmatchedMathDelimiters.push({ start, end });
		}
	});
	const allMacros = collectMacros(source, commands, bracePairs);

	const environmentMath: MathBounds[] = allEnvironments
		.filter((environment) => mathEnvironmentNames.has(environment.name))
		.map((environment) => ({
			...environment,
			mode: environment.name === "math" ? "inlineMath" as const : "blockMath" as const,
			delimiter: `\\begin{${environment.name}}`,
		}));
	const delimiterMath = [
		...collectDollarMath(source, latexIgnored),
		...collectCommandDelimitedMath(source, latexIgnored, unmatchedMathDelimiters),
		...environmentMath,
	];
	const textAreas = options.textMacros ?? DEFAULT_TEXT_MACROS;
	const snippetlessAreas = options.snippetlessMacros ?? DEFAULT_SNIPPETLESS_MACROS;
	const at = (offset: number): CursorContext => {
		const position = clampOffset(source, offset);
		const currentFence = fenceAt(fences, position);
		const currentInlineCode = currentFence ? null : inlineCodes.find((item) => containsCursor(item, position)) ?? null;
		const fenceIsMath = currentFence !== null && mathFenceLanguages.has(
			normalizeLanguage(currentFence.language, caseSensitive),
		);
		const mathFence = fenceIsMath ? fenceMathBounds(currentFence) : null;
		const containingMath = delimiterMath.filter((item) => containsCursor(item, position)).sort(byInnerFirst);
		// Upstream determines the outer editor math mode, then uses the innermost
		// equation only to reset text-macro scope.
		const mathBounds = containingMath.length > 0
			? [...containingMath].sort((left, right) => byInnerFirst(right, left))[0]
			: null;
		const innerMathBounds = containingMath[0] ?? mathBounds;

		const rawComment = comments.find((item) => containsCursor(item, position)) ?? null;
		const comment = rawComment && (language === "latex" || fenceIsMath || mathBounds !== null)
			? rawComment
			: null;

		const environments = allEnvironments.filter((item) => containsCursor(item, position)).sort(byInnerFirst);
		const macros = allMacros.filter((item) => containsCursor(item, position)).sort(byInnerFirst);
		const effectiveMacros = scopesAfterInnerMath(macros, fenceIsMath ? null : innerMathBounds);
		const generallyInMath = fenceIsMath || mathBounds !== null;
		const textEnv = generallyInMath && effectiveMacros.some((macro) => macroMatches(macro, textAreas));
		const snippetlessEnv = generallyInMath && effectiveMacros.some((macro) => macroMatches(macro, snippetlessAreas));

		let kind: ContextKind;
		if (comment) {
			kind = "latexComment";
		} else if (currentFence) {
			kind = fenceIsMath ? "codeMath" : "codeBlock";
		} else if (currentInlineCode) {
			kind = "inlineCode";
		} else if (mathBounds) {
			kind = mathBounds.mode;
		} else {
			kind = "text";
		}

		const nestedMathScopes: MathStackContext[] = (fenceIsMath ? [] : containingMath)
			.filter((item) => item !== mathBounds)
			.map((item) => ({ ...item, kind: "math", mode: item.mode as "inlineMath" | "blockMath" }));
		const latexStack: LatexScope[] = [...macros, ...environments, ...nestedMathScopes].sort(byInnerFirst);

		return {
			offset: position,
			language,
			kind,
			mode: makeMode(kind, currentFence, textEnv, snippetlessEnv),
			mathBounds: mathFence ?? mathBounds,
			innerMathBounds: mathFence ?? innerMathBounds,
			codeBlock: currentFence,
			codeBlockLanguage: currentFence?.language ?? null,
			inlineCode: currentInlineCode,
			comment,
			environments,
			macros,
			latexStack,
		};
	};
	return {
		at,
		get mathRegions() { return [...delimiterMath, ...mathFences.map(fenceMathBounds)]; },
		unmatchedMathDelimiters,
		get textArguments() { return allMacros.filter((macro) => macroMatches(macro, textAreas)); },
		isIgnored: (offset) => latexIgnored.has(offset),
	};
}

/** Convenience entry point for one-off scans and prospective edits. */
export function scanContext(source: string, offset: number, options: ContextScanOptions = {}): CursorContext {
	return parseContext(source, options).at(offset);
}

/** Alias chosen for call sites which read naturally as a query. */
export const getContextAt = scanContext;

/** Alias chosen for integrations which describe this operation as classification. */
export const classifyContext = scanContext;

export function getMathBoundsAt(
	source: string,
	offset: number,
	options: ContextScanOptions = {},
): MathBounds | null {
	return scanContext(source, offset, options).mathBounds;
}

export function getInnerMathBoundsAt(
	source: string,
	offset: number,
	options: ContextScanOptions = {},
): MathBounds | null {
	return scanContext(source, offset, options).innerMathBounds;
}

export function isWithinEnvironment(
	context: CursorContext,
	names: string | readonly string[],
): EnvironmentContext | null {
	const accepted = new Set(typeof names === "string" ? [names] : names);
	return context.environments.find((environment) => accepted.has(environment.name)) ?? null;
}

export function isWithinMacro(
	context: CursorContext,
	areas: string | MacroArea | readonly (string | MacroArea)[],
): MacroContext | null {
	const values = (Array.isArray(areas) ? areas : [areas]) as readonly (string | MacroArea)[];
	const normalized = values.map((area) => typeof area === "string" ? { name: area } : area);
	return context.macros.find((macro) => macroMatches(macro, normalized)) ?? null;
}

function modeMatches(mode: ContextMode, source: string, language?: string): boolean {
	let specifiesMode = language !== undefined;
	let matches = language !== undefined && mode.codeBlock !== false && mode.codeBlock === language;
	for (const flag of source) {
		switch (flag) {
			case "t":
				specifiesMode = true;
				matches ||= mode.text;
				break;
			case "m":
				specifiesMode = true;
				matches ||= (mode.inlineMath || mode.blockMath || mode.codeMath) && !mode.textEnv;
				break;
			case "n":
				specifiesMode = true;
				matches ||= mode.inlineMath && !mode.textEnv;
				break;
			case "M":
				specifiesMode = true;
				matches ||= (mode.blockMath || mode.codeMath) && !mode.textEnv;
				break;
			case "T":
				specifiesMode = true;
				matches ||= (mode.inlineMath || mode.blockMath || mode.codeMath) && mode.textEnv;
				break;
			case "c":
				specifiesMode = true;
				matches ||= mode.codeBlock !== false && (language === undefined || mode.codeBlock === language);
				break;
			case "C":
				specifiesMode = true;
				matches ||= mode.code;
				break;
		}
	}
	return specifiesMode ? matches : !mode.comment;
}

/**
 * Apply upstream mode and scope rules to an already-scanned context.  Included
 * macros can explicitly re-enable a snippet in a snippetless macro; only the
 * nearest non-environment macro/math scope is considered for inclusion.
 */
export function matchesSnippetContext(
	context: CursorContext,
	requirements: SnippetContextRequirements | string,
): boolean {
	const config: SnippetContextRequirements = typeof requirements === "string"
		? { options: requirements }
		: requirements;
	const normalizeAreas = (areas: readonly (string | MacroArea)[] | undefined): MacroArea[] =>
		(areas ?? []).map((area) => typeof area === "string" ? { name: area, arguments: [0] } : { ...area });
	const included = normalizeAreas(config.includedMacros);
	const excluded = normalizeAreas(config.excludedMacros);

	let includedOverride = false;
	if (included.length > 0) {
		const firstScope = context.latexStack.find((scope) => scope.kind !== "environment");
		if (!firstScope || firstScope.kind === "math" || !macroMatches(firstScope, included)) {
			return false;
		}
		includedOverride = true;
	}
	if (context.mode.snippetlessEnv && !includedOverride) {
		return false;
	}
	if (!modeMatches(context.mode, config.options ?? "", config.language)) {
		return false;
	}
	const excludedEnvironments = new Set(config.excludedEnvironments ?? []);
	// A nested equation ends an outer macro's exclusion scope, as upstream does.
	for (const scope of context.latexStack) {
		if (scope.kind === "math") {
			break;
		}
		if (scope.kind === "environment" && excludedEnvironments.has(scope.name)) {
			return false;
		}
		if (scope.kind === "command" && macroMatches(scope, excluded)) {
			return false;
		}
	}
	return true;
}

/**
 * Find a balanced bracket starting at `openingOffset`. Escaped brackets and
 * brackets in TeX comments are ignored. Returns null for invalid/unclosed input.
 */
export function findMatchingBracket(
	source: string,
	openingOffset: number,
	open = source[openingOffset],
	close = BRACKET_CLOSE[open],
): number | null {
	if (!open || !close || !source.startsWith(open, openingOffset)) {
		return null;
	}
	let depth = 0;
	let inComment = false;
	for (let index = openingOffset; index < source.length; index++) {
		const character = source[index];
		if (inComment) {
			if (character === "\n") {
				inComment = false;
			}
			continue;
		}
		if (character === "%" && !isEscaped(source, index)) {
			inComment = true;
			continue;
		}
		if (isEscaped(source, index)) {
			continue;
		}
		if (source.startsWith(open, index)) {
			depth++;
			index += open.length - 1;
			continue;
		}
		if (source.startsWith(close, index)) {
			depth--;
			if (depth === 0) {
				return index;
			}
			index += close.length - 1;
		}
	}
	return null;
}

/** Search backward for the opener matching a closing bracket at `closingOffset`. */
export function findOpeningBracket(source: string, closingOffset: number): number | null {
	const close = source[closingOffset];
	const open = close === ")" ? "(" : close === "]" ? "[" : close === "}" ? "{" : null;
	if (!open) {
		return null;
	}
	const stack: number[] = [];
	for (let index = 0; index <= closingOffset; index++) {
		if (isEscaped(source, index)) {
			continue;
		}
		if (source[index] === open) {
			stack.push(index);
		} else if (source[index] === close) {
			const found = stack.pop();
			if (index === closingOffset) {
				return found ?? null;
			}
		}
	}
	return null;
}
