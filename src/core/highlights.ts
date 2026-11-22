import type { MathBounds, MathMode, OffsetRange, ParsedContext } from "./context";
import { BRACKET_PAIRS, DELIMITERS, LEFT_COMMANDS, RIGHT_COMMANDS } from "./features";

const closers = new Set(BRACKET_PAIRS.values());

export interface MathBracket extends OffsetRange {
	depth: number;
	mate?: OffsetRange;
}

export interface MathDelimiter extends OffsetRange {
	kind: MathMode | "unmatched";
}

interface Equation {
	bounds: MathBounds;
	segments: OffsetRange[];
	brackets?: MathBracket[];
}

interface MathSegment extends OffsetRange {
	equation: Equation;
}

function firstEndingAfter(ranges: readonly OffsetRange[], start: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (ranges[middle].end <= start) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function* overlapping<T extends OffsetRange>(ranges: readonly T[], start: number, end: number): Generator<T> {
	for (let i = firstEndingAfter(ranges, start); i < ranges.length && ranges[i].start < end; i++) {
		yield ranges[i];
	}
}

function scanBrackets(source: string, equation: Equation, context: ParsedContext): MathBracket[] {
	const brackets: MathBracket[] = [];
	const stack: { mark: MathBracket; expected: string }[] = [];
	// Index openers by expected closer to avoid searching the whole stack on mismatches.
	const pending = new Map<string, number[]>();
	const groups: number[] = [];
	// Consume entire control sequences (including escaped backslashes); inspect only
	// commands and bracket characters, skipping ordinary equation text in one pass.
	const token = /\\(?:[A-Za-z@]+|[^\r\n])|[()[\]{}]/g;
	const sizedDelimiter = /\s*(\\(?:[A-Za-z@]+|[^\r\n])|[()[\]{}<>|/.])/y;
	for (const segment of equation.segments) {
		const text = source.slice(segment.start, segment.end);
		token.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = token.exec(text))) {
			const start = segment.start + match.index;
			if (context.isIgnored(start)) {
				continue;
			}
			const spelling = match[0];
			let expected = BRACKET_PAIRS.get(spelling);
			let close = closers.has(spelling) ? spelling : undefined;
			if (LEFT_COMMANDS.has(spelling) || RIGHT_COMMANDS.has(spelling)) {
				sizedDelimiter.lastIndex = token.lastIndex;
				const sized = sizedDelimiter.exec(text);
				if (!sized || !DELIMITERS.has(sized[1])) {
					continue;
				}
				token.lastIndex = sizedDelimiter.lastIndex;
				if (LEFT_COMMANDS.has(spelling)) {
					expected = spelling === "\\left" ? "\\right" : spelling.slice(0, -1) + "r";
				} else {
					close = spelling;
				}
			}
			if (!expected && !close) {
				continue;
			}
			const mark: MathBracket = { start, end: segment.start + token.lastIndex, depth: stack.length };
			brackets.push(mark);
			if (expected) {
				const indices = pending.get(expected) ?? [];
				indices.push(stack.length);
				pending.set(expected, indices);
				if (spelling === "{" || spelling === "\\left") {
					groups.push(stack.length);
				}
				stack.push({ mark, expected });
			} else if (close) {
				const index = pending.get(close)?.at(-1);
				// TeX groups take priority: a ')' inside {...} cannot match an outside '('.
				if (index === undefined || index < (groups.at(-1) ?? 0)) { continue; }
				const opening = stack[index].mark;
				if (groups.at(-1) === index) { groups.pop(); }
				while (stack.length > index) {
					pending.get(stack.pop()!.expected)!.pop();
				}
				opening.mate = mark;
				mark.mate = opening;
				mark.depth = opening.depth;
			}
		}
	}
	return brackets;
}

/** Partition the source at nested equations and text arguments. Visible fragments
 * of an equation share one bracket stack, even on opposite sides of a text macro. */
function mathSegments(equations: Equation[], context: ParsedContext): MathSegment[] {
	type Layer = OffsetRange & { equation?: Equation };
	const layers: Layer[] = equations.map(equation => ({
		start: equation.bounds.outer_start, end: equation.bounds.outer_end, equation,
	}));
	for (const arg of context.textArguments) {
		layers.push({ start: arg.inner_start, end: arg.inner_end });
	}
	layers.sort((a, b) => a.start - b.start || b.end - a.end);
	const stack: Layer[] = [];
	const segments: MathSegment[] = [];
	let offset = 0;
	function advance(to: number) {
		const equation = stack.at(-1)?.equation;
		if (equation) {
			const start = Math.max(offset, equation.bounds.inner_start);
			const end = Math.min(to, equation.bounds.inner_end);
			if (start < end) {
				const segment = { start, end, equation };
				segments.push(segment);
				equation.segments.push(segment);
			}
		}
		offset = to;
	}
	for (const layer of layers) {
		while (stack.length && stack.at(-1)!.end <= layer.start) {
			advance(Math.max(offset, stack.at(-1)!.end));
			stack.pop();
		}
		advance(layer.start);
		stack.push(layer);
	}
	while (stack.length) {
		advance(Math.max(offset, stack.at(-1)!.end));
		stack.pop();
	}
	return segments;
}

export class MathHighlightIndex {
	private readonly delimiters: MathDelimiter[];
	private readonly segments: MathSegment[];

	constructor(private readonly source: string, private readonly context: ParsedContext) {
		const equations: Equation[] = context.mathRegions.map(bounds => ({ bounds, segments: [] }));
		this.segments = mathSegments(equations, context);
		this.delimiters = context.unmatchedMathDelimiters.map(range => ({ ...range, kind: "unmatched" }));
		for (const { bounds } of equations) {
			const fence = bounds.mode === "codeMath";
			this.delimiters.push({
				start: bounds.outer_start,
				end: fence ? bounds.outer_start + bounds.delimiter.length : bounds.inner_start,
				kind: bounds.closed ? bounds.mode : "unmatched",
			});
			if (bounds.closed) {
				// A closing fence may be indented or longer than its opening fence.
				let start = bounds.inner_end;
				if (fence) {
					while (source[start] === " ") { start++; }
				}
				this.delimiters.push({ start, end: bounds.outer_end, kind: bounds.mode });
			}
		}
		this.delimiters.sort((a, b) => a.start - b.start);
	}

	delimitersIn(start: number, end: number): MathDelimiter[] {
		return [...overlapping(this.delimiters, start, end)];
	}

	bracketsIn(start: number, end: number): MathBracket[] {
		const result: MathBracket[] = [];
		for (const segment of overlapping(this.segments, start, end)) {
			const brackets = segment.equation.brackets ??= scanBrackets(this.source, segment.equation, this.context);
			for (const bracket of overlapping(brackets, Math.max(segment.start, start), Math.min(segment.end, end))) {
				result.push(bracket);
			}
		}
		return result;
	}
}

/** At a boundary shared by two pairs, prefer the more deeply nested pair. */
export function matchingBrackets(brackets: readonly MathBracket[], cursor: number): OffsetRange[] {
	let nearest: MathBracket | undefined;
	for (const bracket of overlapping(brackets, cursor - 1, cursor + 1)) {
		if (bracket.mate && (!nearest || bracket.depth > nearest.depth)) {
			nearest = bracket;
		}
	}
	return nearest?.mate ? [nearest, nearest.mate] : [];
}
