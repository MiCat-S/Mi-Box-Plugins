'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'shift', packageRoot: path.resolve(__dirname, '../shift'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(plugin = create()) {
  let data = {schemaVersion: 2, rules: [], backups: {}};
  let legacy = {};
  let beforeUpdate;
  const edits = [], forwards = [], taskLabels = [], pending = [];
  const controller = new AbortController();
  const entities = {
    '@source': {className: 'Channel', id: '90071992547409931234', title: 'Source'},
    '@target': {className: 'Channel', id: '80071992547409931234', title: 'Target'},
    '@sender': {className: 'User', id: '70071992547409931234', firstName: 'Sender'},
    '@third': {className: 'Channel', id: '60071992547409931234', title: 'Third'},
  };
  const client = {
    async getEntity(value) {return entities[String(value)] || {className: 'User', id: String(value), firstName: String(value)};},
    async forwardMessages(target, options) {forwards.push({target, options}); return [];},
    async getMessages() {return [];},
    async sendFile() {},
  };
  const storage = {json(file) {return {
    async read() {return structuredClone(file === 'shift_v2.json' ? legacy : data);},
    async update(change) {
      if (file !== 'shift_v2.json' && beforeUpdate) {const operation = beforeUpdate; beforeUpdate = undefined; operation(data);}
      if (file === 'shift_v2.json') legacy = await change(structuredClone(legacy));
      else data = await change(structuredClone(data));
      return structuredClone(file === 'shift_v2.json' ? legacy : data);
    },
  };}};
  const context = {signal: controller.signal, log: {error() {}}, storage, telegram: {
    async edit(_message, text) {edits.push(text);}, async withClient(operation) {return operation(client, controller.signal);},
  }, files: {async withTemp(operation) {return operation('/tmp', controller.signal);}}, tasks: {run(label, operation) {
    taskLabels.push(label); const result = Promise.resolve().then(() => operation(controller.signal)); pending.push(result); return result;
  }}};
  const message = (chatId, id, text, raw = {}) => ({id, chatId, senderId: '1', outgoing: false, text, raw: {peerId: chatId, ...raw}});
  const run = (args, text = `.shift ${args.join(' ')}`, chatId = '-10050071992547409931234') => plugin.commands.shift.handle({command: 'shift', prefix: '.', args,
    message: {...message(chatId, 1, text), outgoing: true}}, context);
  return {plugin, context, run, message, edits, forwards, taskLabels, pending, state: () => data, setLegacy: value => {legacy = value;},
    beforeNextUpdate: operation => {beforeUpdate = operation;}};
}

test('shift stores exact decimal IDs and forwards topic/send-as without Number coercion', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target|42', 'all', 'silent', 'send-as=@sender']);
  const rule = f.state().rules[0];
  assert.equal(rule.source, '-10090071992547409931234');
  assert.equal(rule.target, '-10080071992547409931234');
  assert.equal(rule.sendAs, '70071992547409931234');
  assert.equal(rule.topicId, 42);
  await f.plugin.listeners[0].handle(f.message(rule.source, 77, 'hello'), f.context);
  assert.equal(f.forwards.length, 1);
  assert.equal(f.forwards[0].target.toString(), rule.target);
  assert.equal(f.forwards[0].options.fromPeer.toString(), rule.source);
  assert.equal(f.forwards[0].options.sendAs.toString(), rule.sendAs);
  assert.equal(f.forwards[0].options.topMsgId, 42);
  assert.equal(f.forwards[0].options.silent, true);
  assert.equal(f.state().rules[0].stats.forwarded, 1);
});

test('shift filtering, safe regex whitelist, pause and loop checks share structured routing', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'text']);
  await f.run(['filter', '1', 'add', 'needle']);
  const source = f.state().rules[0].source;
  await f.plugin.listeners[0].handle(f.message(source, 2, 'miss'), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 3, 'has needle'), f.context);
  assert.equal(f.forwards.length, 1);
  await f.run(['whitelist', '1', 'add', '^has needle$']);
  await f.run(['whitelist', '1', 'enable']);
  await f.plugin.listeners[0].handle(f.message(source, 4, 'has needle plus'), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 5, 'has needle'), f.context);
  assert.equal(f.forwards.length, 2);
  await f.run(['whitelist', '1', 'add', '(a+)+$']);
  assert.match(f.edits.at(-1), /正则无效/);
  await f.run(['pause', '1']);
  await f.plugin.listeners[0].handle(f.message(source, 6, 'has needle'), f.context);
  assert.equal(f.forwards.length, 2);
  await f.run(['set', '@target', '@source', 'all']);
  assert.match(f.edits.at(-1), /循环/);
});

test('shift groups albums in a tracked task and migrates legacy string IDs once', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'photo']);
  await f.run(['filter', '1', 'add', 'album caption']);
  const source = f.state().rules[0].source;
  await f.plugin.listeners[0].handle(f.message(source, 9, 'album caption', {groupedId: '922337203685477000', photo: {}}), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 8, '', {groupedId: '922337203685477000', photo: {}}), f.context);
  assert.ok(f.taskLabels.some(label => label.startsWith('shift-album:')));
  await Promise.all(f.pending);
  assert.deepEqual(f.forwards[0].options.messages, [8, 9]);

  const migrated = fixture();
  migrated.setLegacy({rules: {'-10090071992547409931234': {target_id: '-10080071992547409931234', options: ['all', 'replyTo:73', 'send-as=70071992547409931234'], paused: false, filters: []}}});
  await migrated.plugin.setup(migrated.context);
  assert.equal(migrated.state().rules[0].source, '-10090071992547409931234');
  assert.equal(migrated.state().rules[0].target, '-10080071992547409931234');
  assert.equal(migrated.state().rules[0].topicId, 73);
  assert.equal(migrated.state().rules[0].sendAs, '70071992547409931234');
  assert.equal(migrated.state().legacyImported, true);
});

test('shift export/import preserves valid rules and backup runs inside task scope', async () => {
  const source = fixture();
  await source.run(['set', '@source', '@target', 'all']);
  await source.run(['export']);
  const payload = source.edits.at(-1);
  const target = fixture();
  await target.run(['import'], `.shift import\n${payload}`);
  assert.equal(target.state().rules[0].source, source.state().rules[0].source);
  await target.run(['backup', '@source', '@target']);
  assert.ok(target.taskLabels.some(label => label.startsWith('shift-backup:')));
  await Promise.all(target.pending);
  assert.equal(Object.values(target.state().backups)[0].status, 'completed');
  await target.run(['backup', '@source', '@source']);
  assert.match(target.edits.at(-1), /不能相同/);
  assert.equal(Object.keys(target.state().backups).length, 1);
});

test('shift applies indexed mutations to stable source IDs under concurrent reordering', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'all']);
  await f.run(['set', '@third', '@target', 'all']);
  const selectedSource = f.state().rules[0].source;
  f.beforeNextUpdate(data => data.rules.reverse());
  await f.run(['pause', '1']);
  assert.equal(f.state().rules.find(rule => rule.source === selectedSource).paused, true);
  assert.equal(f.state().rules.find(rule => rule.source !== selectedSource).paused, false);
});

test('shift clean persists normalized rules and removes invalid backup records', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'all']);
  f.state().rules.push({source: 'invalid'});
  f.state().backups['../escape'] = {source: '1', target: '2'};
  await f.run(['clean']);
  assert.equal(f.state().rules.length, 1);
  assert.deepEqual(f.state().backups, {});
  assert.match(f.edits.at(-1), /移除 2 条/);
});
