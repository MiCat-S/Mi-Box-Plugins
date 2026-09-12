'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'autodelcmd', packageRoot: path.resolve(__dirname, '../autodelcmd'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('autodelcmd detects conflicting concurrent additions inside the atomic update', async () => {
  let state = {schemaVersion: 2, enabled: false, rules: [], pending: {}};
  let updateTail = Promise.resolve();
  let reads = 0, releaseReads;
  const bothReads = new Promise(resolve => {releaseReads = resolve;});
  const edits = [];
  const store = {
    async read(){reads += 1; if (reads === 2) releaseReads(); await bothReads; return structuredClone(state);},
    update(transform){
      const result = updateTail.then(async () => {state = await transform(structuredClone(state)); return structuredClone(state);});
      updateTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const context = {signal: new AbortController().signal, storage: {json(){return store;}},
    telegram: {async edit(_message, text){edits.push(text);}}, log: {info(){}, error(){}}};
  const plugin = create();
  const invoke = (id, delay) => plugin.commands.autodelcmd.handle({command: 'autodelcmd', prefix: '.',
    args: ['add', 'calc', String(delay), '-e'], message: {id, chatId: '9007199254740993001', senderId: '1', outgoing: true, text: `.autodelcmd add calc ${delay} -e`}}, context);

  await Promise.all([invoke(1, 45), invoke(2, 90)]);
  assert.equal(state.rules.length, 1);
  assert.equal(state.rules[0].command, 'calc');
  assert.equal(edits.filter(text => text.includes('规则冲突')).length, 1);
  assert.equal(edits.filter(text => text.includes('已保存')).length, 1);
});
