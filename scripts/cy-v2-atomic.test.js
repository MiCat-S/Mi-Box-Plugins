'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'cy', packageRoot: path.resolve(__dirname, '../cy'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('cy time update does not overwrite a concurrent target update', async () => {
  let state = {schemaVersion: 1, enabled: false, target: '', times: [], limit: 500, lastRunKeys: [], importedLegacy: true};
  let releaseRead;
  const readObserved = new Promise(resolve => {releaseRead = resolve;});
  let firstUpdate = true;
  const store = {
    async read() {return structuredClone(state);},
    async update(operation) {
      if (firstUpdate) {
        firstUpdate = false;
        const snapshot = structuredClone(state);
        releaseRead();
        await new Promise(resolve => setImmediate(resolve));
        state = await operation(structuredClone(state));
        assert.notDeepEqual(snapshot, state);
        return structuredClone(state);
      }
      state = await operation(structuredClone(state));
      return structuredClone(state);
    },
  };
  const edits = [];
  const context = {
    signal: new AbortController().signal,
    storage: {json: () => store},
    telegram: {async edit(message, text) {edits.push(text);}},
  };
  const plugin = create();
  const invocation = (args, text) => ({command: 'cy', prefix: '.', args, message: {id: 1, chatId: '1', outgoing: true, text}});
  const setTime = plugin.commands.cy.subcommands.time.handle(invocation(['09:00'], '.cy time 09:00'), context);
  await readObserved;
  await plugin.commands.cy.subcommands.target.handle(invocation(['777'], '.cy target 777'), context);
  await setTime;
  assert.equal(state.target, '777');
  assert.deepEqual(state.times, ['09:00']);
  assert.match(edits.at(-1), /09:00/);
});
