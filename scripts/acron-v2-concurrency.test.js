'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function definition() {
  const {artifactDir} = buildPlugin({id: 'acron', packageRoot: path.resolve(__dirname, '../acron'), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default();
}

test('acron allocates task IDs atomically and never rewinds the sequence after registration failure', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-acron-v2-')));
  let entered = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info(){}, error(){}}, telegram: {
    async edit(_message, text){edits.push(text);}, async reply(){assert.fail('unexpected reply');},
    async invoke(){assert.fail('unexpected invoke');}, async getReply(){return undefined;},
    async withClient(operation, signal){return operation({async getEntity(){
      entered += 1;
      if (entered === 2) release();
      if (entered <= 2) await gate;
      return {id: 9007199254740993123n};
    }}, signal);},
  }});
  await host.load(definition());
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const dispatch = (id, cron, body) => host.dispatchPrimary({id, chatId: '9007199254740993001', senderId: '1', outgoing: true,
    text: `.acron cmd ${cron} me\n${body}`});

  await Promise.all([
    dispatch(1, '0 0 2 * * *', '.ping'),
    dispatch(2, '0 1 2 * * *', '.status'),
  ]);
  let state = JSON.parse(await fs.readFile(path.join(root, 'acron', 'acron_config.json'), 'utf8'));
  assert.equal(state.seq, '2');
  assert.deepEqual(state.tasks.map(task => task.id).sort(), ['1', '2']);
  assert.deepEqual([...new Set(state.tasks.map(task => task.chatId))], ['9007199254740993123']);

  await dispatch(3, 'x x x x x x', '.invalid');
  assert.match(edits.at(-1), /无效的 Cron 表达式/);
  state = JSON.parse(await fs.readFile(path.join(root, 'acron', 'acron_config.json'), 'utf8'));
  assert.equal(state.seq, '3');
  assert.deepEqual(state.tasks.map(task => task.id).sort(), ['1', '2']);

  await dispatch(4, '0 2 2 * * *', '.next');
  state = JSON.parse(await fs.readFile(path.join(root, 'acron', 'acron_config.json'), 'utf8'));
  assert.equal(state.seq, '4');
  assert.deepEqual(state.tasks.map(task => task.id).sort(), ['1', '2', '4']);

  await host.dispatchPrimary({id: 5, chatId: '9007199254740993001', senderId: '1', outgoing: true,
    text: '.acron cmd 0 3 2 * * * me'});
  assert.match(edits.at(-1), /发送的命令文本/);
  assert.doesNotMatch(edits.at(-1), /执行的命令/);
});
