'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {buildPlugin} = require('../../TeleBox-Core/scripts/build-v2-plugin.cjs');
const {artifactDir} = buildPlugin({id: 'zhijiao', packageRoot: path.resolve(__dirname, '../zhijiao'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
test('zhijiao retains all 27 original phrases verbatim', () => {
  const legacy = fs.readFileSync(path.resolve(__dirname, '../zhijiao/zhijiao.ts'), 'utf8');
  const current = fs.readFileSync(path.resolve(__dirname, '../zhijiao/v2.ts'), 'utf8');
  const entries = [...legacy.matchAll(/([胜阳阴]{3}): "([^"]+)"/g)];
  assert.equal(entries.length, 27);
  for (const [, key, value] of entries) assert.ok(current.includes(`${key}: "${value}"`), key);
});
test('zhijiao cancellation during animation prevents subsequent edits', async () => {
  const controller = new AbortController();
  const edits = [];
  const running = create().commands.zhijiao.handle({
    message: {id: 1, chatId: '1', text: '.zhijiao', outgoing: true},
    args: [], prefix: '.', command: 'zhijiao',
  }, {signal: controller.signal, telegram: {edit: async (_, text) => edits.push(text)}});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, {name: 'AbortError'});
  assert.equal(edits.length, 1);
});

test('zhijiao performs three local tosses and renders result', async () => {
  const edits = [];
  const signal = new AbortController().signal;
  await create().commands.zhijiao.handle({
    message: {id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.zhijiao'},
    args: [], prefix: '.', command: 'zhijiao',
  }, {signal, telegram: {edit: async (_, text) => edits.push(text)}});
  assert.ok(edits.length >= 4);
  assert.match(edits.at(-1), /第1投/);
  assert.match(edits.at(-1), /第2投/);
  assert.match(edits.at(-1), /第3投/);
  assert.match(edits.at(-1), /卦象/);
});
