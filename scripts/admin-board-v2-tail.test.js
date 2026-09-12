'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'admin_board', packageRoot: path.resolve(__dirname, '../admin_board'), entry: 'v2.ts'});
const {tailCandidates} = require(path.join(artifactDir, 'index.cjs'));

const entry = (id, avg, locked = false, creator = false) => ({id, avg, locked, creator});

test('admin_board tail candidates exclude unknown statistics and locked seats', () => {
  const result = tailCandidates([
    entry('active', 10), entry('known-low', 0), entry('unknown', -1), entry('locked-low', 0, true),
  ], 3);
  assert.deepEqual(result.map(item => item.id), ['known-low', 'active']);
});

test('admin_board removal candidates do not let the creator consume a removal slot', () => {
  const result = tailCandidates([
    entry('active', 10), entry('next-low', 2), entry('creator-low', 0, false, true),
  ], 1, true);
  assert.deepEqual(result.map(item => item.id), ['next-low']);
});
