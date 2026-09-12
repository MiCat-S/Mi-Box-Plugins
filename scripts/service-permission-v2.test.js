'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'service', packageRoot: path.resolve(__dirname, '../service'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('service declares outgoing-only dispatch and invokes only fixed read-only systemctl status arguments', async () => {
  const definition = create();
  assert.equal(definition.commands.service.direction, 'outgoing');
  assert.match(definition.renderHelp('.'), /当前账号发出的命令/);
  const runs = [], edits = [];
  await definition.commands.service.handle({command: 'service', prefix: '.', args: ['ssh.service'],
    message: {id: 1, chatId: '1', outgoing: true, text: '.service ssh.service'}}, {
    signal: new AbortController().signal,
    telegram: {async edit(_message, text) { edits.push(text); }},
    processes: {async run(file, args, options) {
      runs.push({file, args, options});
      return {stdout: Buffer.from('Active: active (running)\nMain PID: 42'), stderr: Buffer.alloc(0)};
    }},
  });
  assert.deepEqual(runs, [{file: '/usr/bin/systemctl', args: ['--no-pager', 'status', '--', 'ssh.service'],
    options: {timeoutMs: 8000, maxOutputBytes: 65536}}]);
  assert.match(edits.at(-1), /活跃/);
});

test('service rejects systemctl option-shaped units before process admission', async () => {
  const definition = create();
  for (const value of ['-Hattacker.example', '--user']) {
    let runs = 0;
    await definition.commands.service.handle({command: 'service', prefix: '.', args: [value],
      message: {id: 1, chatId: '1', outgoing: true, text: `.service ${value}`}}, {
      signal: new AbortController().signal, telegram: {async edit() {}}, processes: {async run() { runs += 1; }},
    });
    assert.equal(runs, 0);
  }
});

test('service rejects undeclared extra operands before process admission', async () => {
  const definition = create();
  let runs = 0;
  const edits = [];
  await definition.commands.service.handle({command: 'service', prefix: '.', args: ['ssh', 'restart'],
    message: {id: 1, chatId: '1', outgoing: true, text: '.service ssh restart'}}, {
    signal: new AbortController().signal, telegram: {async edit(_message, text) { edits.push(text); }},
    processes: {async run() { runs += 1; }},
  });
  assert.equal(runs, 0);
  assert.match(edits.at(-1), /用法/);
});
