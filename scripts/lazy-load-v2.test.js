'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));

for (const id of ['bgp', 'javdb']) {
  test(`${id} loading and help keep optional processing libraries out of the idle host`, async () => {
    const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
    const {stdout} = await promisify(execFile)(process.execPath, ['--expose-gc',
      path.join(core, 'scripts/memory-profile-v2.cjs'), '--case', 'plugin', '--artifact', artifactDir],
      {timeout: 15000});
    const result = JSON.parse(stdout);
    assert.deepEqual(result.loadedLibraries, []);
  });
}
