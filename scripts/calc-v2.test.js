'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'calc', packageRoot: path.resolve(__dirname, '../calc'), entry: 'v2.ts'});
const createCalc = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-calc-v2-')));
  const edits = [], logs = [];
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes ?? ['.'], logger: {
    info(event, fields) { logs.push({level: 'info', event, fields}); },
    error(event, fields) { logs.push({level: 'error', event, fields}); },
  }, telegram: {
    async edit(message, text, editOptions) {
      edits.push({message, text, options: editOptions});
      await options.onEdit?.(text);
    },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createCalc());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {host, edits, logs, run: text => host.dispatchPrimary({id: 1, chatId: '123', senderId: '123', outgoing: true, text})};
}

test('calc evaluates supported expressions without native resources', async t => {
  const f = await fixture(t);
  await f.run('.calc -(2-5)/3');
  assert.match(f.edits.at(-1).text, /1/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
  await f.run('.calc 2+2*5');
  assert.match(f.edits.at(-1).text, /12/);
  assert.equal(f.edits.at(-1).options.linkPreview, false);
});

test('calc preserves decimal precision and scientific notation in legacy results', async t => {
  const f = await fixture(t);
  for (const [expression, expected] of [
    ['1/10000000', '1e-7'],
    ['0.123456789012345', '0.123456789012'],
    ['123456.123456789', '123456.123456789'],
  ]) {
    await f.run(`.calc ${expression}`);
    assert.match(f.edits.at(-1).text, new RegExp(`<br/>= <b>${expected.replaceAll('.', '\\.')}</b>$`));
  }
});

test('calc rejects unsafe syntax, division by zero and oversized input', async t => {
  const f = await fixture(t);
  for (const [expression, expected] of [
    ['.calc 1/0', /除零错误/],
    ['.calc 1+eval(2)', /表达式包含不支持的字符/],
    ['.calc 1..2', /数字格式错误/],
    ['.calc 9007199254740991+1', /计算结果超出安全范围/],
  ]) {
    await f.run(expression);
    assert.match(f.edits.at(-1).text, /计算失败/);
    assert.match(f.edits.at(-1).text, expected);
  }
  await f.run('.calc 1<2');
  assert.match(f.edits.at(-1).text, /<code>1&lt;2<\/code>/);
  assert.doesNotMatch(f.edits.at(-1).text, /<code>1<2<\/code>/);
});

test('calc retains the detailed overlength receipt', async t => {
  const f = await fixture(t);
  await f.run(`.calc ${'1'.repeat(121)}`);
  assert.match(f.edits.at(-1).text, /表达式过长/);
  assert.match(f.edits.at(-1).text, /最大长度: 120 字符/);
  assert.match(f.edits.at(-1).text, /当前长度: 121/);
});

test('calc help escapes dynamic prefixes', async t => {
  const f = await fixture(t, {prefixes: ['<&']});
  await f.run('<&calc');
  assert.match(f.edits[0].text, /计算器插件/);
  assert.match(f.edits[0].text, /执行安全的四则运算表达式/);
  assert.match(f.edits[0].text, /&lt;&amp;calc -\(2-5\)\/3/);
  assert.equal(f.edits[0].options.parseMode, 'html');
  assert.equal(f.edits[0].options.linkPreview, false);
  await f.run('<&calc help');
  assert.match(f.edits[1].text, /计算器插件/);
  assert.match(f.edits[1].text, /&lt;&amp;calc 2\+2\*5/);
});

test('calc never turns a transport exception into a chat error detail', async t => {
  const secret = '/Users/private/config.json sk-live-token https://private.example/?key=secret';
  const f = await fixture(t, {onEdit: text => {
    if (text.includes('计算结果')) throw new Error(secret);
  }});
  await assert.rejects(f.run('.calc 1+1'));
  assert.equal(f.edits.length, 1);
  assert.equal(JSON.stringify(f.edits).includes(secret), false);
  assert.equal(JSON.stringify(f.logs).includes(secret), false);
});
