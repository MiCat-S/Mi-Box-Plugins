'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const timers = require('node:timers/promises');
const {spawnSync} = require('node:child_process');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {ResourceScope} = require(path.join(core, 'dist/v2/lifecycle.js'));
const artifacts = {};
const factories = Object.fromEntries(['autodel', 'autodelcmd', 'autorepeat'].map(id => {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  artifacts[id] = path.join(artifactDir, 'index.cjs');
  return [id, require(artifacts[id]).default];
}));

function fixture(t, id, initial, client = {}) {
  let state = structuredClone(initial), tail = Promise.resolve();
  const edits = [], tasks = [], sent = [], deleted = [], scope = new ResourceScope();
  const json = {
    read() { return tail.then(() => structuredClone(state)); },
    update(mutator) {
      const result = tail.then(async () => { state = await mutator(structuredClone(state)); return structuredClone(state); });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const native = {
    async sendMessage(chat, options) { sent.push({chat: String(chat), text: options.message}); },
    async deleteMessages(chat, ids, options) { deleted.push({chat: String(chat), ids, options}); },
    ...client,
  };
  const context = {
    signal: scope.signal,
    tasks: {run(label, fn) { tasks.push({label, fn}); return Promise.resolve(); }},
    storage: {json() { return json; }},
    commands: {parse(text) { return {command: text.slice(1), args: []}; }},
    telegram: {
      async edit(_message, text) { edits.push(text); },
      async withClient(operation) { return operation(native, scope.signal); },
    },
    log: {info() {}, error() {}},
  };
  const plugin = factories[id]();
  t.after(async () => { scope.abort(); await plugin.cleanup?.(context); await scope.drain(1000); });
  const message = {id: 10, chatId: '-1007', senderId: '1', outgoing: true, text: '.ping'};
  return {
    plugin, context, scope, edits, tasks, sent, deleted,
    state: () => structuredClone(state),
    run: args => plugin.commands[id].handle({command: id, prefix: '.', args, message}, context),
    listen: (patch = {}) => plugin.listeners[0].handle({...message, ...patch}, context),
  };
}

const deletionState = () => ({schemaVersion: 2, enabled: true, rules: [{id: '1', command: 'ping', delay: 60}], pending: {}});
const repeatState = () => ({schemaVersion: 1, enabledGroups: ['-1007'], dailyHistory: {}, lastDay: 0, trigger: {timeWindow: 300, minUsers: 2}});
const incoming = (senderId, text) => ({senderId, text, outgoing: false, raw: {sender: {className: 'User', bot: false}}});

test('autodel preserves a 30-day delay across bounded, abortable timer segments', async t => {
  const waits = [];
  t.mock.method(timers, 'setTimeout', (delay, _value, {signal}) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    waits.push({delay, resolve() { signal.removeEventListener('abort', abort); resolve(); }});
  }));
  const f = fixture(t, 'autodel', {schemaVersion: 1, settings: {}, importedLegacy: true});
  await f.run(['30d']);
  assert.equal(f.state().settings['-1007'], 30 * 86400);
  await f.listen({text: 'temporary'});
  const running = f.scope.run('test:delete', f.tasks[0].fn);
  assert.equal(waits[0].delay, 2_147_483_647);
  assert.equal(f.deleted.length, 0);
  waits[0].resolve();
  await new Promise(setImmediate);
  assert.equal(waits.length, 2);
  assert.equal(waits[1].delay, 30 * 86400_000 - 2_147_483_647);
  assert.equal(f.deleted.length, 0);
  waits[1].resolve();
  await running;
  assert.deepEqual(f.deleted, [{chat: '-1007', ids: [10], options: {revoke: false}}]);
});

test('autodel cancellation during a later timer segment never deletes the message', async t => {
  let segments = 0;
  t.mock.method(timers, 'setTimeout', async (_delay, _value, {signal}) => {
    if (++segments === 1) return;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  const f = fixture(t, 'autodel', {schemaVersion: 1, settings: {'-1007': 30 * 86400}, importedLegacy: true});
  await f.listen({text: 'temporary'});
  const running = f.scope.run('test:delete', f.tasks[0].fn);
  await new Promise(setImmediate);
  assert.equal(segments, 2);
  f.scope.abort();
  await assert.rejects(running);
  assert.equal(f.deleted.length, 0);
  assert.equal((await f.scope.drain(1000)).completed, true);
});

test('autodel rejects durations that cannot be represented exactly in milliseconds', async t => {
  const f = fixture(t, 'autodel', {schemaVersion: 1, settings: {}, importedLegacy: true});
  await f.run(['9007199254740991d']);
  assert.deepEqual(f.state().settings, {});
  assert.match(f.edits.at(-1), /时间格式错误/);
});

test('autodel releases the native message payload while waiting for its deletion deadline', () => {
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const plugin = require(${JSON.stringify(artifacts.autodel)}).default();
    const controller = new AbortController();
    let task, weak;
    const context = {
      signal: controller.signal,
      storage: {json() { return {async read() { return {settings: {'7': 30 * 86400}}; }}; }},
      tasks: {run(_label, fn) { task = fn(controller.signal); task.catch(() => {}); return task; }},
      telegram: {async withClient() { throw Error('unexpected delete'); }},
      log: {error() {}},
    };
    (async () => {
      await (async () => {
        const raw = {payload: Buffer.alloc(1024 * 1024)};
        weak = new WeakRef(raw);
        await plugin.listeners[0].handle({id: 1, chatId: '7', text: 'hello', outgoing: true, raw}, context);
      })();
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(setImmediate);
        global.gc();
        await new Promise(setImmediate);
      }
      const retained = weak.deref() !== undefined;
      controller.abort();
      await task.catch(() => {});
      process.stdout.write(JSON.stringify({retained}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {retained: false});
});

test('autodelcmd schedules the same message independently in separate plugin instances', async t => {
  const first = fixture(t, 'autodelcmd', deletionState());
  const second = fixture(t, 'autodelcmd', deletionState());
  await first.listen();
  await second.listen();
  assert.equal(first.tasks.length, 1);
  assert.equal(second.tasks.length, 1);
  assert.deepEqual(Object.keys(second.state().pending), ['-1007:10']);
});

test('autodelcmd cleanup keeps another instance deduplicating its pending messages', async t => {
  const first = fixture(t, 'autodelcmd', deletionState());
  const second = fixture(t, 'autodelcmd', deletionState());
  await second.listen();
  await first.plugin.cleanup(first.context);
  await second.listen();
  assert.equal(second.tasks.length, 1);
});

test('autorepeat counts distinct senders only within its own plugin instance', async t => {
  const first = fixture(t, 'autorepeat', repeatState());
  const second = fixture(t, 'autorepeat', repeatState());
  await first.listen(incoming('1', 'instance-local text'));
  await second.listen(incoming('2', 'instance-local text'));
  assert.equal(second.sent.length, 0);
  await second.listen(incoming('3', 'instance-local text'));
  assert.deepEqual(second.sent, [{chat: '-1007', text: 'instance-local text'}]);
  assert.deepEqual(first.state().dailyHistory, {});
});

test('autorepeat cleanup preserves another instance recent sender window', async t => {
  const first = fixture(t, 'autorepeat', repeatState());
  const second = fixture(t, 'autorepeat', repeatState());
  await second.listen(incoming('1', 'window survives cleanup'));
  await first.plugin.cleanup(first.context);
  await second.listen(incoming('2', 'window survives cleanup'));
  assert.deepEqual(second.sent, [{chat: '-1007', text: 'window survives cleanup'}]);
});
