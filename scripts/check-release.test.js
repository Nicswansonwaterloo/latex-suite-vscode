const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkRelease } = require('./check-release');

const manifest = { name: 'latex-suite-vscode', publisher: 'qmvis', version: '1.1.1' };
const lock = { name: manifest.name, version: manifest.version, packages: { '': { name: manifest.name, version: manifest.version } } };

test('accepts an exact stable release tag and matching lockfile', () => {
	checkRelease(manifest, lock, 'v1.1.1');
});
for (const tag of [undefined, 'main', '1.1.1', 'v1.1.0', 'v1.1.1-beta', 'v1.1.1\n']) {
	test(`rejects mismatched tag ${JSON.stringify(tag)}`, () => {
		assert.throws(() => checkRelease(manifest, lock, tag));
	});
}
for (const patch of [{ publisher: 'other' }, { name: 'other' }, { version: '1.1.1-beta' }, { version: '01.1.1' }]) {
	test(`rejects invalid manifest ${JSON.stringify(patch)}`, () => {
		assert.throws(() => checkRelease({ ...manifest, ...patch }, lock, 'v1.1.1'));
	});
}
for (const badLock of [{ ...lock, version: '1.0.0' }, { ...lock, name: 'other' },
	{ ...lock, packages: { '': { ...lock.packages[''], version: '1.0.0' } } },
	{ ...lock, packages: { '': { ...lock.packages[''], name: 'other' } } }]) {
	test(`rejects stale lockfile ${JSON.stringify(badLock)}`, () => {
		assert.throws(() => checkRelease(manifest, badLock, 'v1.1.1'));
	});
}
