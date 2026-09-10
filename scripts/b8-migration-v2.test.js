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
const keys = {"sum": ["sum"], "sure": ["sure"], "t": ["t", "ts", "tk"], "teletype": ["teletype"], "tmp_admin": ["tmp_admin"], "trace": ["trace"], "tts": ["tts"], "uai": ["uai"], "weather": ["weather"], "whois": ["whois"], "xmsl": ["xmsl", "xm"], "yinglish": ["yinglish"], "yvlu": ["yvlu"], "zhijiao": ["zhijiao"], "zpr": ["zpr"]};
const paths = {"sum": ["add", "list", "run", "del", "disable", "enable", "config", "config list", "config add", "config del", "config set", "config set default", "config set preview", "config set preview on", "config set preview off", "config set spoiler", "config set spoiler on", "config set spoiler off", "config set reasoning", "config set service", "config set prompt", "config set prompt show", "config set prompt reset"], "sure": ["user", "user add", "user del", "chat", "chat add", "chat del", "msg", "msg add", "ls", "list"], "t": ["fm"], "teletype": ["on", "off", "status"], "tmp_admin": ["add", "set", "rm", "remove", "del", "ls", "list"], "trace": ["kw", "kw add", "kw del", "status", "clean", "reset", "log", "big"], "tts": ["config", "voice", "voices", "style", "rate", "list"], "uai": ["zj", "fx", "add", "set", "del", "model", "list", "collapse", "collapse on", "collapse off", "prompt", "prompt add", "prompt del", "prompt list"], "whois": ["history", "clear", "batch"], "xmsl": ["show", "set", "set mode", "set key", "set url", "set model"], "yvlu": ["r", "f", "fr", "u", "ur", "webp", "image", "png", "stories", "s", "config", "config sticker", "config stickerset", "config set"], "zpr": ["proxy"]};
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b8-${id}-`)));
  const edits = [], calls = [], logs = [];
  const client = {
    async getEntity(value) { calls.push('getEntity'); return {className: 'User', id: 42, firstName: 'Fixture', username: 'fixture'}; },
    async sendMessage(...args) { calls.push('sendMessage'); return {id: 10}; },
    async deleteMessages() { calls.push('deleteMessages'); },
    ...options.client,
  };
  const host = new PluginHost({storageRoot: root, prefixes: ['!'], logger: {info() {}, error: event => logs.push(event)},
    http: {fetch: async (...args) => { calls.push('http'); if (options.fetch) return options.fetch(...args); throw new Error('fixture network failure'); }},
    processes: {concurrency: 1, queueCapacity: 4, timeoutMs: 300000, maxOutputBytes: 2 * 1024 * 1024, maxInputBytes: 1024 * 1024, killGraceMs: 5000},
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

for (const [id, commands] of Object.entries(keys)) test(`B8 ${id} preserves entry points and serves every expected help path without side effects`, async t => {
  const def = load(id);
  assert.deepEqual(Object.keys(def.commands).sort(), commands.slice().sort());
  assert.equal(def.apiVersion, 2);
  if (!commands.length) return;
  const f = await fixture(t, id);
  const before = await snapshot(f.root);
  for (const name of commands) {
    for (const sub of ['', ...(id === "t" && name !== "t" ? [] : paths[id] ?? [])]) {
      const route = `${name}${sub ? ` ${sub}` : ''}`;
      for (const command of [`!${route} --help`, `!help ${route}`]) {
        f.edits.length = 0; f.calls.length = 0;
        assert.equal(await f.send(command, {replyToId: 4}), true, command);
        assert.equal(f.calls.length, 0, `${command} performs no network, reply lookup or client work`);
        assert.ok(f.visible().includes(`!${sub ? (id === "pangu" ? route.replace(/ g /, " global ").replace(/ wl /, " whitelist ").replace(/ bl /, " blacklist ") : route) : name}`), `${command} renders the requested command`);
      }
    }
  }
  assert.deepEqual(await snapshot(f.root), before, `${id} help never writes state`);
});



test('B8 help preserves complete workflows, examples, prerequisites and limits', () => {
  const anchors = {
    sum: ['!sum 100 --provider myai', '!sum config add myai', '!sum config set myai key', '!sum config set prompt show', '!sum config set spoiler on', '10–500', '整除 60', 'Responses', '收藏夹'],
    sure: ['!sure user add', '!sure chat del', '!sure msg add hello', '第一个词', '整条消息', '仅接受纯数字'],
    t: ['Fish Audio', 'FFmpeg', '5000', '!ts 角色名 角色ID', '!tk APIKey', '角色发现页', '四个及以上'],
    teletype: ['!teletype Hello World!', '!teletype on', '!teletype off', '4096', '80', '2–100'],
    tmp_admin: ['!tmp_admin add @username 60', '!tmp_admin rm', '525600', '默认 30', '1 分钟后重试一次', '已有到期任务继续执行', '权限或头衔变化'],
    trace: ['!trace kw add 开心 👍🥰', '!trace kw del 开心', '10 秒', 'Premium', '标准表情', '默认 true'],
    tts: ['!tts config YOUR_KEY eastus', '!tts voices all', '!tts style clear', 'cheerful', '0.5–2.0', '3000', '64 MiB', 'XiaoxiaoNeural'],
    uai: ['!uai zj 50', '!uai fx 2h', '!uai prompt add brief', '当天', '7 天', '500 条', '100000', '3000', '收藏夹'],
    weather: ['Open-Meteo', 'New York', '北京', 'beijing', '东京', '日出日落', '80 字符'],
    whois: ['namebeta.com', '24 小时', '10 个', '临近到期', '!whois batch google.com github.com'],
    xmsl: ['!xmsl set key', '!xm', 'rlottie-python', 'FFmpeg', '20 MiB', '50000', '/v1beta'],
    yinglish: ['!yinglish 你好世界', '4000', '随机', '回复'],
    yvlu: ['!yvlu r image 3', '!yvlu fr', '!yvlu ur', '部分引用', '格式实体', '5 条', '720×1280', 'stickerset'],
    zhijiao: ['三次', '系统加密随机数', '廿七句'], zpr: ['Lolicon', '1–10', '25 MiB', 'r18 2', 'i.pixiv.nl', '默认 i.pximg.net'],
  };
  for (const [id, values] of Object.entries(anchors)) {
    const text = plain(load(id).renderHelp('!'));
    for (const value of values) assert.ok(text.includes(value), `${id} retains ${value}`);
    assert.ok(!text.includes('{prefix}'), id);
    if (id === 't') assert.ok(load(id).renderHelp('!').includes('href="https://fish.audio/zh-CN/app/discovery/"'));
  }
});
const state = (f, file) => fs.readFile(path.join(f.root, file), 'utf8').then(JSON.parse);

test('B8 sum task and provider lifecycle persists through the real JSON contract', async t => {
  const f = await fixture(t, 'sum');
  const data = () => state(f, 'sum/database.json');
  await f.send('!sum ADD here 2h 100');
  assert.equal((await data()).tasks[0].chatId, '-10010'); assert.equal((await data()).tasks[0].cron, '0 */2 * * *');
  await f.send('!sum DISABLE 1'); assert.equal((await data()).tasks[0].disabled, true);
  await f.send('!sum ENABLE 1'); assert.equal((await data()).tasks[0].disabled, false);
  await f.send('!sum config add myai https://api.example.test secret gpt-4o'); assert.deepEqual((await data()).aiConfig.providers, {});
  await f.send('!sum config add myai https://api.example.test secret gpt-4o', {saved: true});
  assert.equal((await data()).aiConfig.default_provider, 'myai');
  await f.send('!sum config set myai model sample model'); assert.equal((await data()).aiConfig.providers.myai.model, 'sample model');
  await f.send('!sum config set prompt one two\nthree'); assert.equal((await data()).aiConfig.default_prompt, 'one two three');
  await f.send('!sum config set spoiler on'); assert.equal((await data()).aiConfig.default_spoiler, true);
  await f.send('!sum config set reasoning high'); assert.equal((await data()).aiConfig.default_reasoning_effort, 'high');
  await f.send('!sum config set service priority'); assert.equal((await data()).aiConfig.default_service_tier, 'priority');
  const before = await data();
  for (const args of ['config SET spoiler off', 'config set spoiler OFF', 'config set myai key changed', 'config set prompt key']) await f.send(`!sum ${args}`);
  assert.deepEqual(await data(), before);
  await f.send('!sum config set prompt reset'); assert.notEqual((await data()).aiConfig.default_prompt, 'one two three');
  await f.send('!sum config del myai'); assert.deepEqual((await data()).aiConfig.providers, {}); assert.equal((await data()).aiConfig.default_provider, undefined);
  await f.send('!sum DEL 1'); assert.deepEqual((await data()).tasks, []);
});

test('B8 sure authorizes each leaf once and enforces incoming admission', async t => {
  let ownerReads = 0, sent = 0;
  const f = await fixture(t, 'sure', {client: {async getMe() {ownerReads++; return {id: 1};}, async sendMessage() {sent++;}}});
  const data = () => state(f, 'sure/config.json');
  await f.send('!sure user add 42'); assert.equal(ownerReads, 1);
  await f.send('!sure msg add hello world'); assert.deepEqual((await data()).messages, {hello: 'hello'});
  const before = await data();
  await f.send('!sure user add 43', {senderId: '2'}); await f.send('!sure USER add 43'); await f.send('!sure user add -10010');
  assert.deepEqual(await data(), before);
  const message = {id: 2, chatId: '-10010', senderId: '42', text: 'hello', raw: {peerId: 'fixture-peer'}};
  await f.host.dispatchListeners({...message, outgoing: true}); assert.equal(sent, 0);
  await f.host.dispatchListeners({...message, outgoing: false}); assert.equal(sent, 1);
  await f.host.dispatchListeners({...message, outgoing: false, text: 'hello world'}); assert.equal(sent, 1);
});

test('B8 teletype host filters edits and incoming traffic while preserving per-user switches', async t => {
  const f = await fixture(t, 'teletype');
  await f.send('!teletype ON');
  const before = await state(f, 'teletype/config.json'); assert.deepEqual(before.enabledUsers, ['1']);
  f.edits.length = 0;
  const message = {id: 2, chatId: '-10010', senderId: '1', text: 'AB', outgoing: false};
  await f.host.dispatchListeners(message); await f.host.dispatchListeners({...message, outgoing: true, edited: true});
  await f.host.dispatchListeners({...message, outgoing: true, text: '!test AB'}); assert.deepEqual(f.edits, []);
  await f.host.dispatchListeners({...message, outgoing: true}); assert.equal(f.edits.at(-1), 'AB');
  await f.send('!teletype on', {senderId: '2'}); await f.send('!teletype off');
  assert.deepEqual((await state(f, 'teletype/config.json')).enabledUsers, ['2']);
});

test('B8 trace preserves keyword operands, reset semantics and incoming reactions', async t => {
  const requests = [];
  const f = await fixture(t, 'trace', {client: {async getInputEntity(v) {return v;}, async invoke(request) {requests.push(request);}}});
  const data = () => state(f, 'trace/db.json');
  await f.send('!trace kw add hello 👍'); assert.deepEqual((await data()).keywords.hello, [{emoticon: '👍'}]);
  await f.send('!trace big false');
  const msg = {id: 2, chatId: '-10010', senderId: '42', text: 'hello world', outgoing: false};
  await f.host.dispatchListeners({...msg, outgoing: true}); await f.host.dispatchListeners({...msg, saved: true}); assert.equal(requests.length, 0);
  await f.host.dispatchListeners(msg); assert.equal(requests.length, 1); assert.equal(requests[0].big, false);
  await f.send('!trace clean'); assert.deepEqual((await data()).keywords, {}); assert.equal((await data()).config.big, false);
  await f.send('!trace reset'); assert.equal((await data()).config.big, true);
});

test('B8 Azure, Fish and XMSL leaves preserve credential boundaries and complete operands', async t => {
  const azure = await fixture(t, 'tts');
  await azure.send('!tts CONFIG secret eastus'); assert.ok(azure.visible().includes('收藏夹'));
  await azure.send('!tts CONFIG secret EASTASIA', {saved: true});
  await azure.send('!tts STYLE cheerful'); await azure.send('!tts RATE 1.5');
  let data = await state(azure, 'tts/config.json'); assert.equal(data.region, 'eastasia'); assert.equal(data.style, 'cheerful'); assert.equal(data.rate, '1.5');
  await azure.send('!tts style CLEAR'); assert.equal((await state(azure, 'tts/config.json')).style, '');
  const fish = await fixture(t, 't');
  await fish.send('!tk secret'); assert.ok(fish.visible().includes('收藏夹'));
  await fish.send('!tk secret', {saved: true}); await fish.send('!ts Fixture role-id'); await fish.send('!t FM https://example.test/cover.jpg');
  data = await state(fish, 't/tts_data.json'); assert.equal(data.users['1'].apiKey, 'secret'); assert.equal(data.users['1'].defaultRole, 'Fixture'); assert.equal(data.covers.Fixture, 'https://example.test/cover.jpg');
  const xm = await fixture(t, 'xmsl');
  await xm.send('!xm SET KEY hidden'); assert.equal((await state(xm, 'xmsl/config.json')).apiKey, '');
  await xm.send('!xm SET KEY secret words', {saved: true}); await xm.send('!xm set model model with spaces'); await xm.send('!xm set mode GEMINI');
  data = await state(xm, 'xmsl/config.json'); assert.equal(data.apiKey, 'secret words'); assert.equal(data.model, 'model with spaces'); assert.equal(data.apiMode, 'gemini');
  assert.deepEqual([...azure.calls, ...fish.calls, ...xm.calls], []);
});

test('B8 UAI nested configuration and analysis retain prompts, limits and source data', async t => {
  const requests = [];
  const f = await fixture(t, 'uai', {reply: {id: 2, text: 'hello', raw: {senderId: 42n, sender: {firstName: 'Fixture'}}},
    client: {async *iterMessages() {yield {date: Math.floor(Date.now()/1000), message: 'fixture message', senderId: 42n};}},
    fetch: async (url, init) => {requests.push(JSON.parse(init.body)); return Response.json({choices: [{message: {content: 'done'}}]});}});
  const data = () => state(f, 'uai/v2-config.json');
  await f.send('!uai add ai https://api.example.test secret openai', {saved: true});
  await f.send('!uai prompt add brief Use three words'); assert.equal((await data()).prompts.brief, 'Use three words');
  await f.send('!uai collapse off'); assert.equal((await data()).collapse, false);
  await f.send('!uai fx 1', {replyToId: 2, raw: {peerId: 'fixture-peer'}});
  assert.match(requests[0].messages[0].content, /观点、态度/); assert.match(requests[0].messages[0].content, /fixture message/);
  await f.send('!uai brief 1', {replyToId: 2, raw: {peerId: 'fixture-peer'}}); assert.match(requests[1].messages[0].content, /Use three words/);
  await f.send('!uai prompt del brief'); assert.deepEqual((await data()).prompts, {});
});

test('B8 yvlu, ZPR and temporary-admin configuration leaves keep their boundaries', async t => {
  const quote = await fixture(t, 'yvlu');
  await quote.send('!yvlu config SET My Quotes'); assert.equal((await state(quote, 'yvlu/config.json')).stickerSetShortName, 'My_Quotes');
  await quote.send('!yvlu CONFIG sticker Bad'); assert.equal((await state(quote, 'yvlu/config.json')).stickerSetShortName, 'My_Quotes');
  const picture = await fixture(t, 'zpr'); await picture.send('!zpr PROXY i.pixiv.cat'); assert.equal((await state(picture, 'zpr/v2-config.json')).proxyHost, 'i.pixiv.cat');
  await picture.send('!zpr proxy invalid.test'); assert.equal((await state(picture, 'zpr/v2-config.json')).proxyHost, 'i.pixiv.cat');
  const admin = await fixture(t, 'tmp_admin');
  await admin.host.patchSettings('tmp_admin', {enabled: false}); admin.calls.length = 0;
  for (const args of ['add @user 60', 'set @user 60', 'rm @user', 'list']) await admin.send(`!tmp_admin ${args}`);
  assert.deepEqual(admin.calls, []); assert.ok(admin.visible().includes('当前已关闭'));
});
