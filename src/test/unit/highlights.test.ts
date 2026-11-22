import * as assert from "node:assert/strict";
import { parseContext, type OffsetRange } from "../../core/context";
import { MathHighlightIndex, matchingBrackets } from "../../core/highlights";

suite("math highlights", () => {
	const raw = String.raw;
	const spellings = (source: string, ranges: OffsetRange[]) => ranges.map(({ start, end }) => source.slice(start, end));

	test("pairs whole sized and named delimiters, including different left and right glyphs", () => {
		const source = raw`prose () $\left.\bigl(\langle\{x\}\rangle\bigr)\right|+\left (y\right)$`;
		const index = new MathHighlightIndex(source, parseContext(source));
		const brackets = index.bracketsIn(0, source.length);
		assert.deepEqual(spellings(source, brackets), [
			raw`\left.`, raw`\bigl(`, raw`\langle`, raw`\{`, raw`\}`, raw`\rangle`, raw`\bigr)`, raw`\right|`,
			raw`\left (`, raw`\right)`,
		]);
		assert.deepEqual(brackets.map(mark => mark.depth), [0, 1, 2, 3, 3, 2, 1, 0, 0, 0]);
		for (const [open, close] of [[0, 7], [1, 6], [2, 5], [3, 4], [8, 9]]) {
			assert.equal(brackets[open].mate, brackets[close]);
			assert.equal(brackets[close].mate, brackets[open]);
		}
	});

	test("recovers at a matching closer while keeping crossed and stray brackets unpaired", () => {
		const source = raw`$([)] \lvert x$ $y\rvert$`;
		const index = new MathHighlightIndex(source, parseContext(source));
		const marks = index.bracketsIn(0, source.length);
		assert.deepEqual(spellings(source, marks.filter(mark => !mark.mate)), ["[", "]", raw`\lvert`, raw`\rvert`]);
		assert.deepEqual(spellings(source, marks.filter(mark => mark.mate)), ["(", ")"]);
	});

	test("ordinary brackets cannot match through a TeX group boundary", () => {
		const source = raw`$({)}\left[)\right.)$`;
		const index = new MathHighlightIndex(source, parseContext(source));
		const marks = index.bracketsIn(0, source.length);
		assert.deepEqual(spellings(source, marks.filter(mark => !mark.mate)), [")", ")"]);
		assert.equal(marks[0].mate, marks.at(-1));
		assert.equal(marks[1].mate, marks[3]);
		assert.equal(marks[4].mate, marks[6]);
	});

	test("skips prose, code, text arguments and comments, and re-enters nested math", () => {
		const source = [
			"Prose () and `$ignored()$`.",
			"```ts", "$ignore[]$", "```",
			raw`$$ ( \text{words [ignore] \( [x] \)} % close ) and unused {`,
			") $$",
			raw`$\\langle[x]\\rangle$`,
		].join("\n");
		const index = new MathHighlightIndex(source, parseContext(source));
		const marks = index.bracketsIn(0, source.length);
		assert.deepEqual(spellings(source, marks), ["(", "{", "[", "]", "}", ")", "[", "]"]);
		assert.equal(marks[0].mate, marks[5]);
		assert.equal(marks[1].mate, marks[4]);
		assert.equal(marks[2].mate, marks[3]);
		assert.deepEqual(spellings(source, index.delimitersIn(0, source.length)), ["$$", raw`\(`, raw`\)`, "$$", "$", "$"]);
	});

	test("marks paired and unpaired equation delimiters independently of bracket coloring", () => {
		const source = [
			raw`$x$ $$y$$ \[z\] \(t\) \) \] \end{equation} \$ % ordinary prose`,
			raw`\begin{align*}x\end{align*}`, "$incomplete",
			"  ~~~calc", "(x)", "  ~~~~~", "```calc", "[y]",
		].join("\n");
		const index = new MathHighlightIndex(source, parseContext(source, { mathFenceLanguages: ["calc"] }));
		const delimiters = index.delimitersIn(0, source.length);
		assert.deepEqual(delimiters.map(mark => [source.slice(mark.start, mark.end), mark.kind]), [
			["$", "inlineMath"], ["$", "inlineMath"], ["$$", "blockMath"], ["$$", "blockMath"],
			[raw`\[`, "blockMath"], [raw`\]`, "blockMath"], [raw`\(`, "inlineMath"], [raw`\)`, "inlineMath"],
			[raw`\)`, "unmatched"], [raw`\]`, "unmatched"], [raw`\end{equation}`, "unmatched"],
			[raw`\begin{align*}`, "blockMath"], [raw`\end{align*}`, "blockMath"], ["$", "unmatched"],
			["~~~", "codeMath"], ["~~~~~", "codeMath"], ["```", "unmatched"],
		]);
		assert.deepEqual(spellings(source, index.bracketsIn(0, source.length)), ["(", ")", "[", "]"]);
	});

	test("highlights both mates at a token edge or inside a command, even when only one is visible", () => {
		const source = raw`$\left( [abc] \right)$`;
		const index = new MathHighlightIndex(source, parseContext(source));
		function pairAt(offset: number) {
			return spellings(source, matchingBrackets(index.bracketsIn(offset - 1, offset + 1), offset));
		}
		for (const offset of [source.indexOf("\\"), source.indexOf("eft"), source.indexOf("(") + 1]) {
			assert.deepEqual(pairAt(offset), [raw`\left(`, raw`\right)`]);
		}
		assert.deepEqual(pairAt(source.indexOf("]") + 1), ["]", "["]);
		assert.deepEqual(pairAt(source.indexOf("b")), []);
		assert.deepEqual(pairAt(0), []);
	});

	test("a viewport scans each intersecting equation once and leaves distant equations unscanned", () => {
		const source = "$[x]$\n".repeat(2_000);
		const context = parseContext(source);
		let visits = 0;
		const index = new MathHighlightIndex(source, {
			...context,
			isIgnored: offset => { visits++; return context.isIgnored(offset); },
		});
		const start = source.lastIndexOf("[");
		assert.deepEqual(spellings(source, index.bracketsIn(start, start + 1)), ["["]);
		assert.equal(visits, 2);
		assert.deepEqual(spellings(source, index.bracketsIn(start + 2, start + 3)), ["]"]);
		assert.equal(visits, 2);
	});
});
