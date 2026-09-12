'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'bulk_delete', packageRoot: path.resolve(__dirname, '../bulk_delete'), entry: 'v2.ts'});
const {managedDelay} = require(path.join(artifactDir, 'index.cjs'));

function observedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let added = 0, removed = 0;
  signal.addEventListener = (...args) => { if (args[0] === 'abort') added++; return add(...args); };
  signal.removeEventListener = (...args) => { if (args[0] === 'abort') removed++; return remove(...args); };
  return {controller, signal, counts: () => ({added, removed})};
}

test('bulk_delete cleanup delay removes its abort listener after normal completion', async () => {
  const fixture = observedSignal();
  await managedDelay(1, fixture.signal);
  assert.deepEqual(fixture.counts(), {added: 1, removed: 1});
});

test('bulk_delete cleanup delay removes its abort listener after cancellation', async () => {
  const fixture = observedSignal();
  const pending = managedDelay(1000, fixture.signal);
  fixture.controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(fixture.counts(), {added: 1, removed: 1});
});
