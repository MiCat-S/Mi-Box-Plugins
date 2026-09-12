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
const keys = {"jupai": ["jupai"], "keep_online": ["keep_online"], "keyword": ["keyword"], "kkp": ["kkp"], "komari": ["komari"], "leech": ["leech"], "listusernames": ["listusernames"], "lottery": ["lottery"], "lu_bs": ["lu_bs"], "manage_admin": ["manage_admin"], "mode": ["mode"], "moyu": ["moyu"], "music_bot": ["music_bot", "mbs", "mbkw", "mbkg", "mbqq", "mbne", "mbvk", "mbym"], "netease": ["netease"], "news": ["news"], "nezha": ["nezha"], "nodeseek": ["nodeseek"], "openlist": ["openlist", "op"], "oxost": ["0x0"]};
const paths = {"keyword": ["list", "list all", "rm", "alias", "alias rm"], "komari": ["_set_url", "status", "total", "show"], "leech": ["db", "stats", "session"], "lottery": ["create", "create list", "prize", "prize create", "prize add", "prize list", "prize clear", "draw", "status", "list", "delete", "cancel", "winners", "claim", "expire"], "lu_bs": ["sub", "unsub", "reload", "list", "订阅", "退订", "列表", "重载"], "manage_admin": ["add", "set", "rm", "remove", "del", "list", "ls"], "mode": ["global", "whitelist", "blacklist", "off", "global off", "del", "global del", "bold", "global bold", "italic", "global italic", "underline", "global underline", "mask", "global mask", "all", "global all", "whitelist add", "whitelist remove", "whitelist rm", "whitelist list", "blacklist add", "blacklist remove", "blacklist rm", "blacklist list"], "music_bot": ["search", "kugou", "kuwo", "qq", "netease", "vk", "ym"], "nezha": ["set", "service", "service on", "service off", "chart"], "nodeseek": ["set", "status", "now", "auto", "auto on", "auto off"], "openlist": ["status", "install", "update", "uninstall", "login", "setdefault", "save", "admin", "admin setuser", "admin setpass", "admin random", "setport", "backup", "restore"]};
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b6-${id}-`)));
  const edits = [], calls = [], logs = [];
  const client = {
    async getEntity(value) { calls.push('getEntity'); return {className: 'User', id: 42, firstName: 'Fixture', username: 'fixture'}; },
    async sendMessage(...args) { calls.push('sendMessage'); return {id: 10}; },
    async deleteMessages() { calls.push('deleteMessages'); },
    ...options.client,
  };
  const host = new PluginHost({storageRoot: root, prefixes: ['!'], logger: {info() {}, error: event => logs.push(event)},
    http: {fetch: async (...args) => { calls.push('http'); if (options.fetch) return options.fetch(...args); throw new Error('fixture network failure'); }},
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

for (const [id, commands] of Object.entries(keys)) test(`B6 ${id} preserves entry points and serves every expected help path without side effects`, async t => {
  const def = load(id);
  assert.deepEqual(Object.keys(def.commands).sort(), commands.slice().sort());
  assert.equal(def.apiVersion, 2);
  if (!commands.length) return;
  const f = await fixture(t, id);
  const before = await snapshot(f.root);
  for (const name of commands) {
    for (const sub of ['', ...(id === 'music_bot' && name !== 'music_bot' ? [] : paths[id] ?? [])]) {
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

test('B6 help preserves operational instructions and accurate examples', () => {
  const anchors = {
    jupai: ['500', '回复消息', 'api.txqq.pro', '5 MiB'], keep_online: ['第 55 秒', 'assets/keep_online/keep_online.txt', '秒级 Unix'],
    keyword: ['!keyword list all', '!keyword alias rm', '+++', '\\d{11}', '$mention', 'ban300', 'restrict600', 'ignore_forward', '继承'],
    kkp: ['@SeSe3000Bot', 'Start', '剧透'], komari: ['默认 HTTPS', '部署子路径', '只校验格式', '!komari show 香港节点', '各对话间共用'],
    leech: ['!leech db', '!leech stats', '!leech session', '尚未实现'], listusernames: ['用户名', 'ID', '分段', '自己的列表'],
    lottery: ['!lottery prize add myprizes "iPhone 15 Pro" 1', '!lottery create list', '!lottery claim @username', '24 小时', 'notify', '2–1000', '区分大小写', '群组管理员', '库存', '序号', '重复发送无效'],
    lu_bs: ['Asia/Shanghai', 'luxiaoxunbs', '上一条', '管理员', '私聊'], manage_admin: ['16', '仅封禁', '清空', '200', '回复', '添加管理员权限'],
    mode: ['!mode global all', '!mode whitelist rm', '黑名单', '本地为 off 时使用全局模式', '收藏夹'],
    moyu: ['摸鱼日报', '日期', '每日提醒', '8 MiB'], music_bot: ['@music_v1bot', '@vkmusic_bot', '@ttaudiobot', '!mbkg', '!mbkw', '!mbqq', '!mbne', '300', 'Start'],
    netease: ['!netease 晴天', '歌曲链接', '数字 ID', '@Music163bot'], news: ['每日新闻', '历史上的今天', '天天成语', '慧语香风', '诗歌天地', '分段'],
    nezha: ['jwt_secret_key', '收藏夹', '/api/v1/server', 'QuickChart', 'quickchart.io', '!nezha chart 香港节点', '默认开启'],
    nodeseek: ['Request Headers', 'assets/nodeseek/data.json', 'curl_cffi', '本地时区', '8:00–8:59', 'Python 绝对路径', 'xinycai/nodeseek_signin'],
    openlist: ['Linux systemd', '/opt/openlist', '/opt/openlist_backups', '5244', '2 GiB', '密码不回显', '!op', '!openlist admin setpass'],
    oxost: ['100 MiB', '1–8760', '!0x0 expires=72 secret', '回复消息'],
  };
  for (const [id, values] of Object.entries(anchors)) {
    const text = plain(load(id).renderHelp('!'));
    for (const value of values) assert.ok(text.includes(value), `${id} retains ${value}`);
    assert.ok(!text.includes('{prefix}'), id);
  }
});

test('B6 keyword keeps full multi-line tasks and case-sensitive nested operands', async t => {
  const f = await fixture(t, 'keyword');
  const state = () => fs.readFile(path.join(f.root, 'keyword/config.json'), 'utf8').then(JSON.parse);
  await f.send('!keyword \\d{11}\n+++\nphone $mention\n+++\nregexp case\n+++\nreply delete\n+++\n10\n+++\n0');
  const task = (await state()).tasks[0];
  assert.equal(task.key, '\\d{11}'); assert.equal(task.response, 'phone $mention');
  assert.equal(task.regexp, true); assert.equal(task.caseSensitive, true); assert.equal(task.deleteReplyAfter, 10);
  await f.send('!keyword ALIAS -10011'); assert.equal((await state()).aliases['-10010'], '-10011');
  await f.send('!keyword alias RM'); assert.equal((await state()).aliases['-10010'], 'RM');
  await f.send('!keyword alias rm'); assert.equal((await state()).aliases['-10010'], undefined);
  await f.send('!keyword rm 1'); assert.deepEqual((await state()).tasks, []);
});

test('B6 lottery keeps prize isolation, creation operands and incoming participant tracking', async t => {
  const f = await fixture(t, 'lottery', {client: {async pinMessage() { f.calls.push('pinMessage'); }}});
  const state = () => fs.readFile(path.join(f.root, 'lottery/state.json'), 'utf8').then(JSON.parse);
  await f.send('!lottery prize create gifts'); assert.match(f.visible(), /只能在私聊或收藏夹/); assert.deepEqual((await state()).warehouses, {});
  await f.send('!lottery PRIZE CREATE gifts', {saved: true});
  await f.send('!lottery prize add gifts "VIP month" 3', {saved: true});
  assert.deepEqual((await state()).warehouses.gifts, [{text: 'VIP month', stock: 3, order: 0}]);
  await f.send('!lottery CREATE Festival Win 3 1 1 notify');
  const activity = Object.values((await state()).activities)[0];
  assert.equal(activity.title, 'Festival'); assert.equal(activity.keyword, 'Win'); assert.equal(activity.warehouse, 'gifts');
  assert.equal(activity.winnerCount, 1); assert.equal(activity.maxParticipants, 3); assert.ok(f.calls.includes('pinMessage'));
  f.edits.length = 0; await f.send('!lottery create list'); assert.match(f.visible(), /gifts/); assert.doesNotMatch(f.visible(), /已有进行中的/);
  const message = {id: 20, chatId: '-10010', senderId: '42', text: 'Win', outgoing: false};
  f.calls.length = 0;
  await f.host.dispatchListeners({...message, outgoing: true}); await f.host.dispatchListeners({...message, text: 'win'});
  assert.deepEqual(f.calls, []); assert.equal(Object.values((await state()).activities)[0].participants.length, 0);
  await f.host.dispatchListeners(message); await f.host.dispatchListeners(message);
  assert.equal(Object.values((await state()).activities)[0].participants.length, 1);
  await f.send('!lottery CANCEL'); assert.equal(Object.values((await state()).activities)[0].status, 'cancelled');
});

test('B6 mode keeps saved messages and local-off fallback to global formatting', async t => {
  const f = await fixture(t, 'mode');
  await f.send('!mode global bold'); await f.send('!mode off');
  f.edits.length = 0;
  await f.host.dispatchListeners({id: 2, chatId: '-10010', senderId: '1', outgoing: false, saved: true, text: 'saved text'});
  assert.deepEqual(f.edits, ['<b>saved text</b>']);
  f.edits.length = 0; await f.send('!mode global BOLD');
  const data = JSON.parse(await fs.readFile(path.join(f.root, 'mode/config.json'), 'utf8'));
  assert.equal(data.globalMode, 'bold'); assert.match(f.visible(), /范围与优先级/);
});

test('B6 Nezha preserves sensitive setup and case-sensitive service values', async t => {
  const f = await fixture(t, 'nezha', {fetch: async () => Response.json({success: true, data: []})});
  const state = () => fs.readFile(path.join(f.root, 'nezha/config-v2.json'), 'utf8').then(JSON.parse);
  f.calls.length = 0;
  await f.send('!nezha SET https://fixture.test secret words');
  assert.match(f.visible(), /仅限收藏夹/); assert.equal((await state()).secret, ''); assert.deepEqual(f.calls, []);
  await f.send('!nezha SET https://fixture.test secret words', {saved: true});
  assert.equal((await state()).secret, 'secret words');
  await f.send('!nezha SERVICE off'); assert.equal((await state()).serviceMonitor, false);
  f.edits.length = 0; await f.send('!nezha service ON'); assert.equal((await state()).serviceMonitor, false); assert.match(f.visible(), /用法：nezha service on\|off/);
  f.calls.length = 0; await f.send('!nezha unknown'); assert.equal(f.calls.filter(x => x === 'http').length, 1);
});

test('B6 OpenList keeps alias, credential guards and full password/default-path operands', async t => {
  const f = await fixture(t, 'openlist');
  const state = () => fs.readFile(path.join(f.root, 'openlist/credentials-v2.json'), 'utf8').then(JSON.parse);
  const before = await state(); f.calls.length = 0;
  for (const name of ['op', 'openlist']) {
    for (const args of ['LOGIN admin secret', 'ADMIN setpass secret', 'admin random']) await f.send(`!${name} ${args}`);
  }
  assert.deepEqual(await state(), before); assert.deepEqual(f.calls, []);
  await f.send('!op LOGIN admin secret words', {saved: true}); assert.equal((await state()).password, 'secret words');
  await f.send('!openlist setdefault /media/my folder'); assert.equal((await state()).defaultPath, '/media/my folder');
  await f.send('!op setdefault'); assert.equal((await state()).defaultPath, '');
  f.edits.length = 0; await f.send('!op admin SETPASS ignored', {saved: true});
  assert.match(f.visible(), /用法：op admin setuser\|setpass\|random/); assert.equal((await state()).password, 'secret words');
});

test('B6 stateful leaf errors retain their reporting and abort contracts', async () => {
  const cases = {keyword: ['list all', 'alias rm'], lottery: ['prize create x', 'draw', 'claim 1'], komari: ['show x'], nezha: ['service off']};
  for (const [id, paths] of Object.entries(cases)) for (const args of paths) for (const aborted of [false, true]) {
    const controller = new AbortController(); if (aborted) controller.abort();
    const edits = [];
    const ctx = {signal: controller.signal, storage: {json: () => ({read: async () => {throw new Error('storage unavailable');}})},
      telegram: {edit: async (_m, text) => edits.push(plain(text))}};
    await load(id).commands[id].handle({command: id, prefix: '!', args: args.split(' '), message: {id: 1, chatId: '1', senderId: '1', saved: true, text: `!${id} ${args}`}}, ctx);
    assert.equal(edits.length, aborted ? 0 : 1, `${id} ${args}`);
    if (!aborted) assert.match(edits[0], /storage unavailable/);
  }
});
