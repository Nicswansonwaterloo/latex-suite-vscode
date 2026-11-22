import * as assert from "node:assert/strict";
import { scanContext } from "../../core/context";
import { findReverseTabOutTarget } from "../../core/features";

function reverseTarget(marked: string, exitOnlyAtStart = true): number | null {
	const cursor = marked.indexOf("▮");
	assert.notEqual(cursor, -1);
	const source = marked.replace("▮", "");
	const bounds = scanContext(source, cursor).innerMathBounds;
	assert.ok(bounds);
	return findReverseTabOutTarget(source, cursor, bounds, exitOnlyAtStart);
}

suite("reverse tab-out", () => {
	test("steps back through preceding raw, named, escaped and sized openers", () => {
		for (const opener of ["(", "[", "{", "<", "\\langle", "\\{", "\\left(", "\\bigl \\langle", "\\left|", "\\left."]) {
			const prefix = "before $f";
			assert.equal(reverseTarget(prefix + opener + " x▮$"), prefix.length, opener);
		}
		assert.equal(reverseTarget("$E_{filler}=mc^2▮$"), 3);
		assert.equal(reverseTarget("$$1_{[0,1)▮}$$"), 5);
	});

	test("ignores delimiters in comments, right-sized openers and longer command names", () => {
		const prefix = "$$a";
		assert.equal(reverseTarget(prefix + "(x % [\\left(\n \\right( \\langlelong▮$$"), prefix.length);
	});

	test("the equation exit setting applies to the whole prefix, including multiline equations", () => {
		assert.equal(reverseTarget("x \\[\n  ▮a\\]"), 2);
		assert.equal(reverseTarget("x \\[a\n  ▮b\\]"), null);
		assert.equal(reverseTarget("x \\[a\n  ▮b\\]", false), 2);
		assert.equal(reverseTarget("old $(x)$ and $a▮$"), null);
	});
});
