'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {createHelp} = require(path.join(core, 'dist/v2/builtins/help.js'));
const {HTMLParser} = require(path.join(core, 'node_modules/teleproto/extensions/html.js'));
const keys = {
  dme: ['dme'], duckduckgo: ['duckduckgo', 'ddg'], eatgif: ['eatgif'], encode: ['encode', 'b64encode', 'b64decode', 'urlencode', 'urldecode'],
  epic: ['epic'], exec: [], fadian: ['fadian'], fbi: ['fbi'], getstickers: ['getstickers'], git_PR: ['git'],
  goodnight: ['goodnight', 'gn'], gt: ['gt'], his: ['his'], hitokoto: ['hitokoto'], httpcat: ['httpcat'], ids: ['ids'],
  im: ['im'], ip: ['ip'], isalive: ['isalive'], javdb: ['javdb', 'av', 'jav', 'jd'],
};
const paths = {
  eatgif: ['list', 'ls', 'clear'], fadian: ['fd', 'tg', 'kfc', 'wyy', 'cp', 'clear'],
  fbi: ['det', 'loc', 'sur', 'obs', 'ssv', 'cache', 'cache limit', 'cache rebuild'],
  git_PR: ['login', 'repos', 'prs', 'merge', 'mergeall'], goodnight: ['on', 'off'],
  im: ['on', 'off', 'addchat', 'delchat', 'addmd5', 'delmd5', 'setaction', 'list', 'delete', 'ban'],
};
function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default();
}
const plain = text => HTMLParser.parse(text)[0];
async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const item of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else { const stat = await fs.stat(file); result[path.relative(root, file)] = {body: await fs.readFile(file, 'base64'), modified: stat.mtimeMs}; }
    }
  }
  await walk(root); return result;
}
async function fixture(t, id, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b5-${id}-`)));
  const edits = [], calls = [], logs = [];
  const client = {
    async getEntity(value) { calls.push('getEntity'); return {className: 'User', id: 42, firstName: 'Fixture', username: 'fixture'}; },
    async sendMessage(...args) { calls.push('sendMessage'); return {id: 10}; },
    async deleteMessages() { calls.push('deleteMessages'); },
    ...options.client,
  };
  const host = new PluginHost({storageRoot: root, prefixes: ['!'], logger: {info() {}, error: event => logs.push(event)},
    http: {fetch: async () => { calls.push('http'); throw new Error('fixture network failure'); }},
    processes: {concurrency: 1, queueCapacity: 4, timeoutMs: 300000, maxOutputBytes: 1024 * 1024, maxInputBytes: 1024 * 1024, killGraceMs: 5000},
    telegram: {
      async edit(message, text) { edits.push(text); }, async reply(message, text) { edits.push(text); },
      async invoke() { calls.push('invoke'); throw new Error('unexpected RPC'); },
      async getReply() { calls.push('getReply'); return options.reply; },
      async withClient(operation, signal) { calls.push('withClient'); return operation(client, signal); },
    }});
  t.after(async () => { assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  await host.load(load(id)); await host.load(createHelp(host));
  const send = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '-10010', chatType: 'supergroup', senderId: '1', outgoing: true, text, ...extra});
  return {host, root, edits, calls, logs, send, visible: () => edits.map(plain).join('\n')};
}

for (const [id, commands] of Object.entries(keys)) test(`B5 ${id} preserves entry points and serves every expected help path without side effects`, async t => {
  const def = load(id);
  assert.deepEqual(Object.keys(def.commands).sort(), commands.slice().sort());
  assert.equal(def.apiVersion, id === 'exec' ? 1 : 2);
  if (!commands.length) return;
  const f = await fixture(t, id);
  const before = await snapshot(f.root);
  for (const name of commands) {
    for (const sub of ['', ...(paths[id] ?? [])]) {
      const route = `${name}${sub ? ` ${sub}` : ''}`;
      for (const command of [`!${route} --help`, `!help ${route}`]) {
        f.edits.length = 0; f.calls.length = 0;
        assert.equal(await f.send(command, {replyToId: 4}), true, command);
        assert.equal(f.calls.length, 0, `${command} performs no network, reply lookup or client work`);
        assert.ok(f.visible().includes(`!${sub ? route : name}`), `${command} renders the requested command`);
      }
    }
  }
  assert.deepEqual(await snapshot(f.root), before, `${id} help never writes state`);
});

test('B5 authored help retains operational details and executable examples', () => {
  const anchors = {
    dme: ['999999', '2000', '回退历史遍历', '当前话题', '第三方副本'],
    duckduckgo: ['默认 8', '1–15', 'Firecrawl', '!ddg'],
    eatgif: ['!eatgif list', '!eatgif clear', '回复目标'],
    encode: ['!b64encode Hello World', '!b64decode SGVsbG8gV29ybGQ=', '!urlencode', '!urldecode', '16384'],
    epic: ['原价', '领取时间'], fadian: ['!fadian cp\n第一个人\n第二个人', '回复消息', '!fadian clear'],
    fbi: ['10–1000', '默认 300', '30 天', '3000', '持久保存', '同时保留一个', '收藏夹', '公开用户名'],
    getstickers: ['brew install ffmpeg', 'sudo apt install ffmpeg', 'lottie[all]', 'pack.txt', '原始文件'],
    git_PR: ['收藏夹', '!git mergeall', 'owner/repo'],
    goodnight: ['默认关闭', 'utc-5', '-12 至 +14', '!gn'],
    gt: ['调用费用', '5000', '!gt en', '回复消息', '!ai config add'],
    his: ['默认 30', '最大 100', '123456789 10', '频道 ID'], hitokoto: ['!hitokoto a c', 'a=动画', '作者', '字母'],
    httpcat: ['100–599', '5 MiB'], ids: ['注册时间估算', '入群时间', '共同群组', '三种跳转链接'],
    im: ['省略时使用当前对话', '默认操作', '30 MiB', '文件媒体', '!im ban', '!im delete'],
    ip: ['IPv4/IPv6', '2001:4860:4860::8888', '回复'], isalive: ['!acron cmd', '!isalive @username', '曾与该用户交互'],
    javdb: ['START-128', '剧透', '60 秒', 'MissAV', '!av', '!jav', '!jd'],
  };
  for (const [id, values] of Object.entries(anchors)) {
    const text = plain(load(id).renderHelp('!'));
    for (const value of values) assert.ok(text.includes(value), `${id} retains ${value}`);
    assert.ok(!text.includes('{prefix}'), id);
  }
  assert.doesNotMatch(plain(load('duckduckgo').renderHelp('!')), /curl_cffi|TLS 伪装|assets\/duckduckgo/);
});

test('IM leaf operations preserve state, validation, reply defaults and error handling', async t => {
  const sticker = {id: 9, raw: {media: {className: 'MessageMediaDocument', document: {className: 'Document', id: 99, attributes: [{className: 'DocumentAttributeSticker'}]}}}};
  const f = await fixture(t, 'im', {reply: sticker});
  const state = () => fs.readFile(path.join(f.root, 'im/config.json'), 'utf8').then(JSON.parse);
  await f.send('!im off'); assert.equal((await state()).enabled, false);
  await f.send('!im ON'); assert.equal((await state()).enabled, true);
  await f.send('!im addchat'); assert.equal((await state()).monitoredChats[0].id, '-10010');
  await f.send('!im setaction ban'); assert.equal((await state()).defaultAction, 'ban');
  await f.send('!im', {replyToId: 9}); assert.equal((await state()).bannedStickerIds['99'], 'ban');
  await f.send('!im DELETE', {replyToId: 9}); assert.equal((await state()).bannedStickerIds['99'], 'delete');
  const before = await state(); f.edits.length = 0;
  await f.send('!im setaction BAN'); assert.match(f.visible(), /操作失败：操作必须为 delete 或 ban/); assert.deepEqual(await state(), before);
  await f.send('!im delchat'); assert.deepEqual((await state()).monitoredChats, []);
});

test('IM leaf failures retain the guarded error and abort contract', async () => {
  for (const input of ['on', 'addchat bad', 'setaction wrong']) {
    for (const aborted of [false, true]) {
      const controller = new AbortController(); if (aborted) controller.abort();
      const edits = [];
      const ctx = {signal: controller.signal, storage: {json: () => ({read: async () => { throw new Error('storage unavailable'); }})},
        telegram: {edit: async (message, text) => edits.push(plain(text))}};
      await load('im').commands.im.handle({command: 'im', prefix: '!', args: input.split(' '), message: {text: `!im ${input}`}}, ctx);
      assert.deepEqual(edits, aborted ? [] : ['操作失败：storage unavailable']);
    }
  }
});

test('eatgif list and clear preserve error logging and cancellation', async () => {
  for (const input of ['list', 'ls', 'clear']) {
    for (const aborted of [false, true]) {
      const controller = new AbortController(); if (aborted) controller.abort();
      const edits = [], logs = [];
      const ctx = {signal: controller.signal, files: {dataPath: () => { throw new Error('fixture storage failure'); }},
        http: {withResponse: async () => { throw new Error('fixture network failure'); }},
        telegram: {edit: async (message, text) => edits.push(plain(text))}, log: {error: event => logs.push(event)}};
      await load('eatgif').commands.eatgif.handle({command: 'eatgif', prefix: '!', args: [input], message: {text: `!eatgif ${input}`}}, ctx);
      assert.deepEqual(logs, aborted ? [] : ['eatgif_failed']);
      assert.equal(edits.length, aborted ? 0 : 1);
      if (!aborted) assert.match(edits[0], /动图生成失败/);
    }
  }
});

test('FBI retains cache default, case sensitivity and unknown-command target resolution', async t => {
  const f = await fixture(t, 'fbi');
  const read = () => fs.readFile(path.join(f.root, 'fbi/db.json'), 'utf8').then(JSON.parse);
  await f.send('!fbi CACHE limit 200'); assert.equal((await read()).cacheLimit, 200);
  await f.send('!fbi cache LIMIT 300'); assert.equal((await read()).cacheLimit, 200); assert.match(f.visible(), /缓存上限：200/);
  f.edits.length = 0; f.calls.length = 0;
  await f.send('!fbi unknown', {replyToId: 4}); assert.match(f.visible(), /无法识别目标/); assert.deepEqual(f.calls, ['getReply']);
  f.edits.length = 0; f.calls.length = 0;
  await f.send('!fbi unknown 42'); assert.match(f.visible(), /公开群组与频道消息查询/); assert.ok(f.calls.includes('getEntity'));
});

test('FBI host filtering rejects unknown and private chats before observing or consuming watches', async t => {
  const group = {className: 'Channel', id: 10, megagroup: true, username: 'fixturegroup', title: 'Group'};
  const f = await fixture(t, 'fbi', {client: {async getEntity(value) { f.calls.push('getEntity'); return String(value) === '42' ? {className: 'User', id: 42, firstName: 'Target'} : group; }}});
  await f.send('!fbi sur 42');
  const state = () => fs.readFile(path.join(f.root, 'fbi/db.json'), 'utf8').then(JSON.parse);
  for (const chatType of ['unknown', 'private', 'saved']) {
    f.calls.length = 0;
    await f.host.dispatchListeners({id: 2, chatId: '-10010', chatType, outgoing: false, senderId: '42', text: 'fixture'});
    assert.deepEqual(f.calls, []); assert.ok((await state()).surveillance['42']);
  }
  await f.host.dispatchListeners({id: 3, chatId: '-10010', chatType: 'supergroup', outgoing: false, senderId: '42', text: 'fixture', raw: {date: Math.floor(Date.now() / 1000)}});
  assert.equal((await state()).surveillance['42'], undefined);
  assert.equal(f.calls.filter(x => x === 'sendMessage').length, 2);
  f.edits.length = 0; f.calls.length = 0;
  await f.send('!fbi obs 42', {chatType: 'unknown'});
  assert.match(f.visible(), /请在群组中使用/); assert.deepEqual(f.calls, []);
});

test('IM host direction filter keeps incoming enforcement and ignores outgoing and unmonitored messages', async t => {
  const sticker = {raw: {media: {className: 'MessageMediaDocument', document: {className: 'Document', id: 99, attributes: [{className: 'DocumentAttributeSticker'}]}}}};
  const f = await fixture(t, 'im', {reply: sticker});
  await f.send('!im addchat'); await f.send('!im delete', {replyToId: 2});
  const message = {id: 4, chatId: '-10010', senderId: '42', text: '', raw: sticker.raw};
  f.calls.length = 0;
  await f.host.dispatchListeners({...message, outgoing: true});
  await f.host.dispatchListeners({...message, outgoing: false, chatId: '-10011'});
  assert.deepEqual(f.calls, []);
  await f.host.dispatchListeners({...message, outgoing: false});
  assert.equal(f.calls.filter(x => x === 'deleteMessages').length, 1);
});

test('Git unknown actions retain storage failure handling', async () => {
  const edits = [], logs = [];
  const ctx = {signal: new AbortController().signal, storage: {json: () => ({read: async () => {throw new Error('read failed');}})},
    log: {error: event => logs.push(event)}, telegram: {edit: async (message, text) => edits.push(plain(text))}};
  await load('git_PR').commands.git.handle({command: 'git', prefix: '!', args: ['unknown'], message: {text: '!git unknown'}}, ctx);
  assert.deepEqual(edits, ['操作失败：read failed']); assert.deepEqual(logs, ['git_pr_failed']);
});
