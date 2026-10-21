const assert = require('node:assert/strict');

function checkRelease(manifest, lock, tag) {
	assert.equal(manifest.publisher, 'qmvis', 'Unexpected Marketplace publisher');
	assert.equal(manifest.name, 'latex-suite-vscode', 'Unexpected extension name');
	assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release version must be stable x.y.z');
	assert.equal(tag, `v${manifest.version}`, 'Tag must exactly match package.json version');
	assert.equal(lock.version, manifest.version, 'Lockfile version differs');
	assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root version differs');
	assert.equal(lock.name, manifest.name, 'Lockfile name differs');
	assert.equal(lock.packages[''].name, manifest.name, 'Lockfile root name differs');
}

if (require.main === module) {
	checkRelease(require('../package.json'), require('../package-lock.json'), process.env.RELEASE_TAG);
	console.log('Release tag, version, lockfile, and Marketplace identity verified.');
}
module.exports = { checkRelease };
