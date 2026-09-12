'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'keyword', packageRoot: path.resolve(__dirname, '../keyword'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('keyword allocates unique task IDs atomically across concurrent chats', async () => {
  let value = {schemaVersion: 1, nextId: 1, tasks: [], aliases: {}, importedLegacy: true};
  let updates = Promise.resolve();
  let reads = 0;
  const bothRead = deferred();
  const json = {
    async read() {
      reads += 1;
      if (reads === 2) bothRead.resolve();
      await bothRead.promise;
      return structuredClone(value);
    },
    update(operation) {
      const next = updates.then(async () => {
        value = await operation(structuredClone(value));
        return structuredClone(value);
      });
      updates = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const edits = [];
  const signal = new AbortController().signal;
  const context = {
    signal,
    storage: {json: () => json},
    telegram: {edit: async (_message, text) => edits.push(text)},
  };
  const command = create().commands.keyword;
  const invoke = (chatId, key) => command.handle({
    command: 'keyword', prefix: '.', args: [key],
    message: {id: 1, chatId, senderId: '9007199254740995', outgoing: true,
      text: `.keyword ${key}\n+++\nreply-${key}`},
  }, context);

  await Promise.all([invoke('-1009007199254740993', 'first'), invoke('-1009007199254740997', 'second')]);
  assert.deepEqual(value.tasks.map(task => task.id), [1, 2]);
  assert.equal(new Set(value.tasks.map(task => task.id)).size, 2);
  assert.equal(value.nextId, 3);
  assert.deepEqual(edits.map(text => Number(text.match(/<code>(\d+)<\/code>/)[1])).sort(), [1, 2]);
});

test('keyword delegates regexp matching to the bounded helper and logs timeouts without replying', async () => {
  const task = {id: 1, chatId: '-1001', key: '(a+)+$', response: 'matched', include: true, regexp: true,
    exact: false, caseSensitive: false, ignoreForward: false, reply: true, deleteSource: false, banSeconds: 0,
    restrictSeconds: 0, deleteReplyAfter: 0, deleteSourceAfter: 0};
  const state = {schemaVersion: 1, nextId: 2, tasks: [task], aliases: {}, importedLegacy: true};
  const calls = [], errors = [], replies = [];
  const signal = new AbortController().signal;
  const context = {signal, storage: {json: () => ({read: async () => state})},
    regexp: {async test(pattern, input, options, caller) {calls.push({pattern, input, options, caller}); return {matched: false, timedOut: true};}},
    telegram: {withClient: async () => assert.fail('timed out regexp must not reply')}, log: {error: (...args) => errors.push(args)}};
  await create().listeners[0].handle({id: 1, chatId: '-1001', senderId: '7', incoming: true, outgoing: false,
    text: `${'a'.repeat(200)}!`}, context);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {flags: 'i'});
  assert.equal(calls[0].caller, signal);
  assert.deepEqual(errors, [['keyword_regexp_timeout', {taskId: 1}]]);
  assert.deepEqual(replies, []);
});
