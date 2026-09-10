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
const keys = {"pangu": ["pangu"], "paolu": ["paolu"], "pic_to_sticker": ["pic_to_sticker", "pts"], "pmcaptcha": ["pmcaptcha", "pmc"], "portball": ["portball"], "premium": ["premium"], "qr": ["qr"], "rate": ["rate"], "re": ["re"], "restore_pin": ["restore_pin"], "rev": ["rev"], "save": ["save"], "search": ["so", "search"], "sendat": ["sendat"], "service": ["service"], "soutu": ["soutu"], "speedtest": ["speedtest", "st"], "sticker": ["sticker"], "sticker_to_pic": ["sticker_to_pic", "stp"], "subinfo": ["subinfo"]};
const paths = {"pangu": ["on", "enable", "true", "off", "disable", "false", "reset", "global", "g", "global on", "g off", "stats", "stat", "whitelist", "whitelist add", "whitelist remove", "whitelist list", "wl", "wl add", "wl remove", "wl list", "blacklist", "blacklist add", "blacklist remove", "blacklist list", "bl", "bl add", "bl remove", "bl list"], "pic_to_sticker": ["batch", "config", "config emoji", "config size", "config quality", "config bg", "config background", "config auto", "config format"], "pmcaptcha": ["on", "off", "status", "captcha", "set", "add", "del", "wl", "whitelist", "wl add", "wl del", "wl del all", "wl pass", "record", "record verified", "record failed", "captcha on", "captcha off", "captcha math", "captcha text", "captcha img_digit", "captcha img_mixed", "set time", "set tries", "set keyword", "set prompt", "set initiative", "set history", "set groups", "set wl-words", "set bl-words", "set premium", "set fail", "set pass"], "premium": ["force"], "save": ["to", "target", "source", "source on", "source off"], "search": ["add", "del", "default", "list", "export", "import", "ad", "ad add", "ad del", "ad list", "kkp"], "sendat": ["list", "list all", "rm", "delete", "pause", "resume"], "speedtest": ["set", "clear", "type", "config", "check", "diagnose", "list", "test", "best", "fix", "update"], "sticker_to_pic": ["check"]};
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b7-${id}-`)));
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

for (const [id, commands] of Object.entries(keys)) test(`B7 ${id} preserves entry points and serves every expected help path without side effects`, async t => {
  const def = load(id);
  assert.deepEqual(Object.keys(def.commands).sort(), commands.slice().sort());
  assert.equal(def.apiVersion, 2);
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
        assert.ok(f.visible().includes(`!${sub ? (id === "pangu" ? route.replace(/ g /, " global ").replace(/ wl /, " whitelist ").replace(/ bl /, " blacklist ") : route) : name}`), `${command} renders the requested command`);
      }
    }
  }
  assert.deepEqual(await snapshot(f.root), before, `${id} help never writes state`);
});


test('B7 help retains operating limits, dependencies and contextual examples', () => {
  const anchors = {
    pangu: ['16000', '收藏夹', '白名单', '!pangu global on', '!pangu whitelist add'],
    paolu: ['删除消息权限', '10 秒', '不可逆'], pic_to_sticker: ['512 KiB', 'sharp', '最多 20 张', '!pts', 'config emoji 🔥'],
    pmcaptcha: ['{question}', '{keyword}', '默认 30', '默认 3', '!pmc set wl-words', '!pmc wl del all', '自动降级', '验证码默认关闭'],
    portball: ['60 秒至 366 天', '管理员', '!portball 广告 5m'], premium: ['10,000', 'force', '机器人', '已注销'],
    qr: ['4000 字节', '20 MiB', 'qrencode', 'zbar-tools', '!qr Hello World'], rate: ['USD', '!rate BTC CNY 0.5', 'Google'],
    re: ['1–20', '1–10', '!re 3 2', '允许转发'], restore_pin: ['100 条', '1 秒', '管理员日志'],
    rev: ['FFmpeg', '50 MiB', 'emoji', '!rev h c'], save: ['500 条', '2 GiB', 'local', '来源说明', '!save source on'],
    search: ['!so add @channel1 \\ @channel2', '20 秒至 3 分钟', '!so ad del', '!search', '转发失败'],
    sendat: ['Asia/Shanghai', '多行', 'HTML', '!sendat 3 times 1 minutes', '!sendat delete', '权限不足'],
    service: ['systemd', 'Linux', '!service ssh'], soutu: ['0x0.st', '20 MiB', 'Google Lens', 'Yandex'],
    speedtest: ['官方 Ookla CLI', '--system', 'photo → sticker → file → txt', '!speedtest test 12345', '实际测速'],
    sticker: ['@Stickers', '120 张', '50 个', 'TGS', '未回复贴纸', '!sticker to TempPack'],
    sticker_to_pic: ['ImageMagick', '20 MiB', 'WebP 静态', '!sticker_to_pic doc png transparent'],
    subinfo: ['Base64', 'VMess', 'WireGuard', '响应头', '其他'],
  };
  for (const [id, values] of Object.entries(anchors)) {
    const text = plain(load(id).renderHelp('!'));
    for (const value of values) assert.ok(text.includes(value), `${id} retains ${value}`);
    assert.ok(!text.includes('{prefix}'), id);
  }
});

test('B7 pangu host admission preserves outgoing, edited, saved and dynamic whitelist behavior', async t => {
  const f = await fixture(t, 'pangu');
  await f.send('!pangu G ON');
  const message = {id: 20, chatId: '-10010', senderId: '1', chatType: 'supergroup', text: '中文ABC', outgoing: false};
  f.edits.length = 0;
  await f.host.dispatchListeners(message); assert.deepEqual(f.edits, []);
  for (const extra of [{outgoing: true}, {outgoing: true, edited: true}, {saved: true}]) await f.host.dispatchListeners({...message, ...extra});
  assert.deepEqual(f.edits, ['中文 ABC', '中文 ABC', '中文 ABC']);
  await f.send('!pangu OFF'); await f.send('!pangu bl add'); await f.send('!pangu whitelist add');
  f.edits.length = 0;
  await f.host.dispatchListeners({...message, outgoing: true});
  await f.host.dispatchListeners({...message, outgoing: true, chatId: '-10011'});
  assert.deepEqual(f.edits, ['中文 ABC']);
  f.edits.length = 0; await f.host.dispatchListeners({...message, outgoing: true, text: '!other 中文ABC'}); assert.deepEqual(f.edits, []);
});

test('B7 PMCaptcha nested setters retain words, action aliases, casing and private initiation', async t => {
  const f = await fixture(t, 'pmcaptcha');
  const state = () => fs.readFile(path.join(f.root, 'pmcaptcha/state.json'), 'utf8').then(JSON.parse);
  await f.send('!pmcaptcha SET WL-WORDS hello world'); assert.deepEqual((await state()).config.wlWords, ['hello', 'world']);
  await f.send('!pmc set bl-words none'); assert.deepEqual((await state()).config.blWords, []);
  await f.send('!pmc set prompt question {question} and {keyword}'); assert.equal((await state()).config.prompt, 'question {question} and {keyword}');
  await f.send('!pmc set fail 屏蔽 report'); assert.deepEqual((await state()).config.failActions, ['block', 'report']);
  await f.send('!pmc captcha IMG_MIXED'); assert.equal((await state()).config.mode, 'img_mixed');
  await f.send('!pmc set initiative ON'); assert.equal((await state()).config.initiative, false);
  await f.send('!pmc set initiative on');
  const msg = {id: 20, chatId: '42', senderId: '1', outgoing: true, text: 'hello'};
  for (const chatType of ['unknown', 'group', 'supergroup', 'broadcast']) await f.host.dispatchListeners({...msg, chatType});
  assert.deepEqual((await state()).config.whitelist, []);
  await f.host.dispatchListeners({...msg, chatType: 'private'}); assert.deepEqual((await state()).config.whitelist, ['42']);
  await f.send('!pmc wl del all'); assert.deepEqual((await state()).config.whitelist, []);
  f.edits.length = 0; await f.send('!pmc record FAILED'); assert.match(f.visible(), /通过：0\n失败：0/);
});

test('B7 picture configuration preserves aliases and exact value validation', async t => {
  const f = await fixture(t, 'pic_to_sticker');
  const state = () => fs.readFile(path.join(f.root, 'pic_to_sticker/config.json'), 'utf8').then(JSON.parse);
  await f.send('!pts CONFIG BACKGROUND black'); await f.send('!pts config size 256'); await f.send('!pts config quality 75');
  await f.send('!pts config auto off'); await f.send('!pts config emoji 🔥'); await f.send('!pts config format png');
  const current = await state();
  assert.equal(current.background, 'black'); assert.equal(current.size, 256); assert.equal(current.quality, 75);
  assert.equal(current.autoDelete, false); assert.equal(current.defaultEmoji, '🔥'); assert.equal(current.format, 'png');
  await f.send('!pts config format PNG'); await f.send('!pts config size 255'); assert.deepEqual(await state(), current);
});

test('B7 save keeps per-user configuration and multi-token targets', async t => {
  const f = await fixture(t, 'save');
  const state = () => fs.readFile(path.join(f.root, 'save/config.json'), 'utf8').then(JSON.parse);
  await f.send('!save TO target words'); await f.send('!save SOURCE ON');
  assert.deepEqual((await state()).users['1'], {target: 'target words', showSource: true});
  await f.send('!save to local', {senderId: '2'}); await f.send('!save source off', {senderId: '2'});
  assert.deepEqual((await state()).users['2'], {target: 'local', showSource: false});
  assert.deepEqual((await state()).users['1'], {target: 'target words', showSource: true});
});

test('B7 sendat preserves multi-line task bodies, ownership and lifecycle aliases', async t => {
  const f = await fixture(t, 'sendat');
  const state = () => fs.readFile(path.join(f.root, 'sendat/tasks.json'), 'utf8').then(JSON.parse);
  await f.send('!sendat every 23:59:59 date | first line\n<b>second</b> | third');
  const task = (await state()).tasks[0]; assert.equal(task.msg, 'first line\n<b>second</b> | third');
  await f.send(`!sendat PAUSE ${task.task_id}`, {chatId: '-10011'}); assert.equal((await state()).tasks[0].pause, false);
  await f.send(`!sendat PAUSE ${task.task_id}`); assert.equal((await state()).tasks[0].pause, true);
  await f.send(`!sendat RESUME ${task.task_id}`); assert.equal((await state()).tasks[0].pause, false);
  await f.send(`!sendat DELETE ${task.task_id}`); assert.deepEqual((await state()).tasks, []);
});

test('B7 search channel insertion, defaults, nested filters and deletion work through the host', async t => {
  const f = await fixture(t, 'search', {client: {async getEntity(value) {return {className: 'Chat', title: value, id: 42};}}});
  const state = () => fs.readFile(path.join(f.root, 'search/channel_search_config.json'), 'utf8').then(JSON.parse);
  await f.send('!search ADD @one \\ @two');
  assert.deepEqual((await state()).channelList, [{title: '@one', handle: '@one'}, {title: '@two', handle: '@two'}]);
  await f.send('!so DEFAULT @two'); assert.equal((await state()).defaultChannel, '@two');
  await f.send('!so AD ADD fixtureword'); assert.ok((await state()).adFilters.includes('fixtureword'));
  await f.send('!so AD DEL fixtureword'); assert.ok(!(await state()).adFilters.includes('fixtureword'));
  await f.send('!so DEL 2'); assert.equal((await state()).defaultChannel, '@one');
  await f.send('!so DEL ALL'); assert.deepEqual((await state()).channelList, []);
});

test('B7 speedtest accepts system flags before leaves and preserves help without execution', async t => {
  const f = await fixture(t, 'speedtest');
  const state = () => fs.readFile(path.join(f.root, 'speedtest/v2-config.json'), 'utf8').then(JSON.parse);
  await f.send('!st -s SET 12345');
  const current = await state(); assert.ok(Object.values(current).includes(12345) || Object.values(current).includes('12345'));
  await f.send('!st --system type text');
  assert.ok(Object.values(await state()).includes('txt'));
  f.calls.length = 0;
  const before = await snapshot(f.root);
  for (const args of ['--system test --help', 'test -s --help', '-s best --help']) await f.send(`!st ${args}`);
  assert.deepEqual(f.calls, []); assert.deepEqual(await snapshot(f.root), before);
  await f.send('!st -s clear'); assert.notDeepEqual(await state(), current);
});

test('B7 sticker handles reserved words according to reply context', async t => {
  const f = await fixture(t, 'sticker', {client: {async invoke() {return {set: {count: 1}};}}});
  const state = () => fs.readFile(path.join(f.root, 'sticker/config.json'), 'utf8').then(JSON.parse);
  await f.send('!sticker TO'); assert.equal((await state()).sticker_default_pack, 'TO');
  await f.send('!sticker cancel'); assert.equal((await state()).sticker_default_pack, '');
  await f.send('!sticker MyPack'); assert.equal((await state()).sticker_default_pack, 'MyPack');
});
