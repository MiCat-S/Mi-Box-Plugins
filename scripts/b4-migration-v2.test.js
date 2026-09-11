'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {HTMLParser} = require(path.join(core, 'node_modules/teleproto/extensions/html.js'));
const {createHelp} = require(path.join(core, 'dist/v2/builtins/help.js'));

const B4 = ['bs', 'bulk_delete', 'calc', 'checkapi', 'checkin', 'clean', 'clean_member', 'clear_sticker',
  'codex_image', 'convert', 'copy_sticker_set', 'cosplay', 'crazy4', 'cy', 'da', 'dbdj', 'dc', 'deepwiki', 'dig', 'diss'];

function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  const factory = require(path.join(artifactDir, 'index.cjs')).default;
  return typeof factory === 'function' ? factory() : factory;
}

function client(calls, overrides = {}) {
  const record = name => (...args) => { calls.push(name); return overrides[name]?.(...args); };
  const base = {
    async getMe() { calls.push('getMe'); return {id: 1n, firstName: 'Fixture', lastName: null, username: 'fixture', bot: false}; },
    async getEntity() { calls.push('getEntity'); return {className: 'Channel', id: 1, title: 'Fixture', username: null, broadcast: false, megagroup: true}; },
    async getInputEntity() { calls.push('getInputEntity'); return {className: 'InputPeerChannel', channelId: 1n, accessHash: 1n}; },
    async getMessages() { calls.push('getMessages'); return []; },
    async sendMessage(...a) { calls.push('sendMessage'); return {id: 2, ...(overrides.sendMessageResult ?? {})}; },
    async deleteMessages() { calls.push('deleteMessages'); return 1; },
    async deleteDialog() { calls.push('deleteDialog'); },
    async invoke() { calls.push('invoke'); return {}; },
    iterMessages() { calls.push('iterMessages'); return (async function* () {})(); },
    iterDialogs() { calls.push('iterDialogs'); return (async function* () {})(); },
    iterParticipants() { calls.push('iterParticipants'); return (async function* () {})(); },
    iterDownload() { calls.push('iterDownload'); return (async function* () {})(); },
  };
  return {...base, ...overrides};
}

async function fixture(t, id, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b4-${id}-`)));
  const edits = [];
  const calls = [];
  const errors = [];
  const stub = client(calls, options.client);
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes ?? ['.'], processes: {concurrency: 1, queueCapacity: 4, timeoutMs: 300000, maxOutputBytes: 1024 * 1024, maxInputBytes: 1024 * 1024, killGraceMs: 5000}, logger: {info() {}, error: (event, fields) => errors.push({event, fields})}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply(_message, text) {edits.push(text);},
    async invoke() {throw new Error('unexpected RPC');}, async getReply() {return undefined;},
    withClient: options.withClient ?? (async (operation, signal) => operation(stub, signal)),
  }});
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  if (options.seed) await options.seed(root);
  await host.load(load(id));
  if (options.helpBuiltin) await host.load(createHelp(host));
  const visible = () => edits.map(page => HTMLParser.parse(page)[0]).join('\n');
  const send = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '-100123', senderId: '1', outgoing: true, text,
    raw: {peerId: {className: 'PeerChannel', channelId: 1n}, delete: async () => {calls.push('delete');}}, ...extra});
  return {host, root, edits, calls, errors, visible, send};
}

const HELP_ANCHORS = {
  bs: ['首次使用请先', 'toggle mode', '话题ID'],
  bulk_delete: ['1–99', '删除他人消息开关默认开启', '管理员删除消息权限'],
  calc: ['3+7', '8/2+5', '括号、小数'],
  checkapi: ['统一配置', 'ai 配置标签', '100 tokens'],
  checkin: ['时间范围', 'Asia/Shanghai', '跨天'],
  clean: ['跳过机器人', '权限要求', '封禁用户权限'],
  clean_member: ['24 小时缓存', 'chat:-100', 'limit:', 'search'],
  clear_sticker: ['默认 2000', '群组删除消息权限', 'cs'],
  codex_image: ['20 MiB', '32 MiB', '600000', 'ai config', 'codex'],
  convert: ['元数据嵌入', '视频原名', 'AI 配置', 'convert u'],
  copy_sticker_set: ['最多允许 120 张', 'limit=数量', 'css'],
  cosplay: ['同一套图', '原套图链接', '最大 10'],
  crazy4: ['疯狂星期四'],
  cy: ['target', 'time 09:00', 'send'],
  da: ['管理员删除全部消息', '普通成员仅删除自己的消息', 'da true'],
  dbdj: ['点兵点将', '消息数 人数'],
  dc: ['不代表用户所在地', '@用户名', '每次最多指定一个目标'],
  deepwiki: ['48000', '最近 50 轮', 'ctx del all', '标签'],
  dig: ['+short', 'IP 归属地与 ASN', 'SRV'],
  diss: ['花体时区', '本地模板', 'dissai', 'dissclear'],
};

test('B4 plugins expose the full authored guide without network or state writes', async t => {
  for (const id of B4) {
    const definition = load(id);
    assert.equal(typeof definition.renderHelp, 'function', `${id} supplies help`);
    const text = HTMLParser.parse(definition.renderHelp('.')).join('\n');
    assert.ok(text.length > 0, `${id} help has content`);
    for (const anchor of HELP_ANCHORS[id]) assert.ok(text.includes(anchor), `${id} help preserves "${anchor}"`);
  }
});

test('B4 plugins declare the original command keys', async t => {
  const keys = {
    bs: ['bs'], bulk_delete: ['bd'], calc: ['calc'], checkapi: ['checkapi'], checkin: ['checkin'],
    clean: ['clean'], clean_member: ['clean_member'], clear_sticker: ['clear_sticker', 'cs'],
    codex_image: ['cximg'], convert: ['convert'], copy_sticker_set: ['copy_sticker_set', 'css'],
    cosplay: ['cos', 'cosplay'], crazy4: ['crazy4'], cy: ['cy'], da: ['da'], dbdj: ['dbdj'],
    dc: ['dc'], deepwiki: ['deepwiki'], dig: ['dig'], diss: ['diss', 'undiss', 'dislist', 'dissclear', 'dishelp', 'dissai'],
  };
  for (const id of B4) assert.deepEqual(Object.keys(load(id).commands).sort(), keys[id].slice().sort(), id);
});

test('B4 plugins declare the standard subcommand trees', async t => {
  const trees = {
    bs: ['add', 'list', 'del', 'enable', 'disable', 'toggle'],
    checkapi: ['save', 'list', 'del', 'check', 'models', 'ask'],
    checkin: ['add', 'list', 'del', 'toggle', 'test', 'settings', 'reset', 'set'],
    clean: ['deleted', 'blocked'],
    convert: ['u', 'apikey', 'clear'],
    cy: ['target', 'time', 'on', 'off', 'status', 'send'],
    da: ['true', 'stop', 'status'],
    deepwiki: ['add', 'lst', 'use', 'del', 'ctx'],
    dissai: ['model', 'provider', 'reasoning'],
  };
  for (const [id, expected] of Object.entries(trees)) {
    const definition = load(id === 'dissai' ? 'diss' : id);
    const root = id === 'dissai' ? definition.commands.dissai : Object.values(definition.commands)[0];
    assert.deepEqual(Object.keys(root.subcommands ?? {}).sort(), expected.slice().sort(), id);
  }
});

test('B4 deep declared paths serve focused help with zero business work', async t => {
  const trees = {
    bs: 'bs', checkapi: 'checkapi', checkin: 'checkin', clean: 'clean', convert: 'convert',
    cy: 'cy', da: 'da', deepwiki: 'deepwiki', diss: 'dissai',
  };
  for (const [id, command] of Object.entries(trees)) {
    const definition = load(id);
    const root = definition.commands[command];
    const paths = [];
    const walk = (node, path) => {
      for (const [name, sub] of Object.entries(node.subcommands ?? {})) {
        const next = [...path, name];
        if (sub.subcommands) walk(sub, next); else paths.push(next);
      }
    };
    walk(root, []);
    assert.ok(paths.length >= 2, `${id} declares nested leaves`);
    const f = await fixture(t, id, {withClient: async () => {throw new Error('help must not use the client');}});
    for (const leaf of paths) {
      f.edits.length = 0;
      const sent = await f.send(`.${command} ${leaf.join(' ')} --help`);
      assert.equal(sent, true, `${command} ${leaf.join(' ')}`);
      assert.ok(f.visible().length > 0, `${command} ${leaf.join(' ')} renders help`);
      assert.ok(f.visible().includes(`.${command} ${leaf.join(' ')}`), `${command} ${leaf.join(' ')} focuses the leaf`);
    }
  }
});

test('B4 listeners declare the confirmed fixed filters', async t => {
  const checkin = load('checkin');
  assert.equal(checkin.listeners.length, 1);
  assert.equal(checkin.listeners[0].direction, 'outgoing');
  const diss = load('diss');
  assert.equal(diss.listeners.length, 1);
  assert.equal(diss.listeners[0].direction, 'incoming');
});

test('calc preserves arithmetic, division and default help behaviour', async t => {
  const f = await fixture(t, 'calc');
  f.edits.length = 0;
  await f.send('.calc 3+7');
  assert.match(f.visible(), /3\+7 = 10/);
  f.edits.length = 0;
  await f.send('.calc 10/4');
  assert.match(f.visible(), /2\.5/);
  f.edits.length = 0;
  await f.send('.calc 1/0');
  assert.match(f.visible(), /除零错误/);
  f.edits.length = 0;
  await f.send('.calc');
  assert.match(f.visible(), /计算器插件/);
});

test('crazy4 sends a random item and help stays local', async t => {
  const f = await fixture(t, 'crazy4');
  f.edits.length = 0; f.calls.length = 0;
  await f.send('.crazy4 help');
  assert.match(f.visible(), /疯狂星期四/);
  assert.equal(f.calls.filter(name => name === 'sendMessage').length, 0, 'help does not send');
  f.edits.length = 0; f.calls.length = 0;
  await f.send('.crazy4');
  assert.equal(f.calls.filter(name => name === 'sendMessage').length, 1, 'crazy4 sends one item');
});

test('bulk_delete toggles the account flag and rejects numbers without range messaging', async t => {
  const f = await fixture(t, 'bulk_delete');
  f.edits.length = 0; f.calls.length = 0;
  await f.send('.bd on');
  assert.ok(f.calls.includes('sendMessage'), 'on sends a confirmation');
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'bulk_delete', 'bulk_delete_config.json'), 'utf8'));
  assert.equal(state.userDeleteMode['1'], true);
  f.calls.length = 0;
  await f.send('.bd off');
  assert.ok(f.calls.includes('sendMessage'), 'off sends a confirmation');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'bulk_delete', 'bulk_delete_config.json'), 'utf8')).userDeleteMode['1'], false);
  f.edits.length = 0; f.calls.length = 0;
  await f.send('.bd 5');
  assert.ok(f.calls.includes('deleteMessages'), 'number mode deletes without reply context');
});

test('clear_sticker validates the count and reports empty history', async t => {
  const f = await fixture(t, 'clear_sticker');
  f.edits.length = 0;
  await f.send('.clear_sticker abc');
  assert.match(f.visible(), /请输入有效数量/);
  f.edits.length = 0;
  await f.send('.clear_sticker 5');
  assert.match(f.visible(), /未找到贴纸消息/);
});

test('copy_sticker_set rejects malformed input with the authored help', async t => {
  const f = await fixture(t, 'copy_sticker_set');
  for (const text of ['.css https://evil.test/addstickers/a', '.css bad-name', '.css valid limit=121']) {
    f.edits.length = 0;
    await f.send(text);
    assert.match(f.visible(), /复制贴纸包/, text);
  }
});

test('cosplay clamps the requested count', async t => {
  const f = await fixture(t, 'cosplay');
  for (const text of ['.cos 0', '.cosplay 11']) {
    f.edits.length = 0;
    await f.send(text);
    assert.match(f.visible(), /数量必须是 1 到 10 的整数/, text);
  }
});

test('dc enforces a single target and keeps chat-specific notices', async t => {
  const f = await fixture(t, 'dc');
  f.edits.length = 0;
  await f.send('.dc a b');
  assert.match(f.visible(), /参数错误，最多只能指定一个用户/);
  f.edits.length = 0;
  await f.send('.dc');
  assert.match(f.visible(), /没有头像/);
});

test('dig rejects malformed domains before running the process', async t => {
  const f = await fixture(t, 'dig');
  f.edits.length = 0;
  await f.send('.dig not_a_domain');
  assert.match(f.visible(), /域名格式无效/);
  f.edits.length = 0;
  await f.send('.dig');
  assert.match(f.visible(), /DNS 查询/);
});

test('dbdj validates both counters and reports an empty scan', async t => {
  const f = await fixture(t, 'dbdj');
  f.edits.length = 0;
  await f.send('.dbdj');
  assert.match(f.visible(), /点兵点将/);
  f.edits.length = 0;
  await f.send('.dbdj 0 2');
  assert.match(f.visible(), /点兵点将/);
  f.edits.length = 0;
  await f.send('.dbdj 50 2');
  assert.match(f.visible(), /没有可抽取的有效用户/);
});

test('clean_member keeps mode validation and the authored guide', async t => {
  const f = await fixture(t, 'clean_member');
  f.edits.length = 0;
  await f.send('.clean_member');
  assert.match(f.visible(), /群成员清理工具 Pro/);
  f.edits.length = 0;
  await f.send('.clean_member 9');
  assert.match(f.visible(), /未知模式/);
  f.edits.length = 0;
  await f.send('.clean_member 1 0');
  assert.match(f.visible(), /必须为正整数/);
});

test('clean keeps the nested error wording', async t => {
  const f = await fixture(t, 'clean');
  f.edits.length = 0;
  await f.send('.clean');
  assert.match(f.visible(), /清理工具 Pro/);
  f.edits.length = 0;
  await f.send('.clean foo bar');
  assert.match(f.visible(), /未知类型: bar/);
  f.edits.length = 0;
  await f.send('.clean deleted foo');
  assert.match(f.visible(), /未知类型: foo/);
  f.edits.length = 0;
  await f.send('.clean deleted');
  assert.match(f.visible(), /请指定清理类型: pm 或 member/);
});

test('bs manages targets and keeps numeric fallback', async t => {
  const f = await fixture(t, 'bs');
  f.edits.length = 0;
  await f.send('.bs list');
  assert.match(f.visible(), /暂无目标/);
  f.edits.length = 0;
  await f.send('.bs add @channel');
  assert.match(f.visible(), /目标 1 已添加/);
  f.edits.length = 0;
  await f.send('.bs ls');
  assert.match(f.visible(), /Fixture/);
  f.edits.length = 0;
  await f.send('.bs disable 1');
  assert.match(f.visible(), /目标状态已更新/);
  f.edits.length = 0;
  await f.send('.bs del 99');
  assert.match(f.visible(), /目标不存在/);
  f.edits.length = 0;
  await f.send('.bs');
  assert.match(f.visible(), /请回复需要保送的消息/);
});

test('checkapi directs connection management to ai when the central service is unavailable', async t => {
  const f = await fixture(t, 'checkapi');
  f.edits.length = 0;
  await f.send('.checkapi');
  assert.match(f.visible(), /API 检测工具/);
  f.edits.length = 0;
  await f.send('.checkapi bogus');
  assert.match(f.visible(), /API 检测失败/);
  f.edits.length = 0;
  await f.send('.checkapi save demo https://api.example.com/v1 sk-x');
  assert.match(f.visible(), /ai 插件统一管理/);
  f.edits.length = 0;
  await f.send('.checkapi list');
  assert.match(f.visible(), /API 检测失败/);
});

test('checkin handles settings, reset and empty target list', async t => {
  const f = await fixture(t, 'checkin');
  f.edits.length = 0;
  await f.send('.checkin');
  assert.match(f.visible(), /没有启用的签到目标/);
  f.edits.length = 0;
  await f.send('.checkin settings');
  assert.match(f.visible(), /10:00/);
  f.edits.length = 0;
  await f.send('.checkin set time 08:30');
  assert.match(f.visible(), /开始时间已更新/);
  f.edits.length = 0;
  await f.send('.checkin reset');
  assert.match(f.visible(), /已重置每日运行状态/);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'checkin', 'state.json'), 'utf8'));
  assert.equal(state.runTime, '08:30');
});

test('codex_image directs credentials and models to ai', async t => {
  const f = await fixture(t, 'codex_image');
  f.edits.length = 0;
  await f.send('.cximg hello');
  assert.match(f.visible(), /ai 插件的图片模型/);
  f.edits.length = 0;
  await f.send('.cximg token abc');
  assert.match(f.visible(), /ai 插件统一管理/);
  f.edits.length = 0;
  await f.send('.cximg token abc', {saved: true, outgoing: false});
  assert.match(f.visible(), /ai 插件统一管理/);
});

test('convert keeps reply requirement, key location and clear output', async t => {
  const f = await fixture(t, 'convert');
  f.edits.length = 0;
  await f.send('.convert');
  assert.match(f.visible(), /视频转音频|MP3/);
  f.edits.length = 0;
  await f.send('.convert apikey');
  assert.match(f.visible(), /ai 插件统一管理/);
  f.edits.length = 0;
  await f.send('.convert clear');
  assert.match(f.visible(), /临时文件/);
});

test('cy keeps status, precondition and insufficient-word failure', async t => {
  const f = await fixture(t, 'cy');
  f.edits.length = 0;
  await f.send('.cy status');
  assert.match(f.visible(), /词云定时/);
  f.edits.length = 0;
  await f.send('.cy on');
  assert.match(f.visible(), /请先设置目标和时间/);
  f.edits.length = 0;
  await f.send('.cy');
  assert.match(f.visible(), /没有统计到足够的热词/);
});

test('da is group-only, helps on empty and rejects unknown actions', async t => {
  const f = await fixture(t, 'da');
  f.edits.length = 0;
  await f.send('.da');
  assert.match(f.visible(), /批量删除/);
  f.edits.length = 0;
  await f.send('.da bogus');
  assert.match(f.visible(), /未知命令/);
  f.edits.length = 0;
  await f.send('.da true', {chatId: '1'});
  assert.match(f.visible(), /仅群组可用/);
});

test('deepwiki keeps project listing and failure wording without network', async t => {
  const f = await fixture(t, 'deepwiki');
  f.edits.length = 0;
  await f.send('.deepwiki');
  assert.match(f.visible(), /DeepWiki 项目问答/);
  f.edits.length = 0;
  await f.send('.deepwiki lst');
  assert.match(f.visible(), /暂无项目/);
  f.edits.length = 0;
  await f.send('.deepwiki add node');
  assert.match(f.visible(), /操作失败/);
});

test('diss keeps lock usage, clearing, help and AI configuration', async t => {
  const f = await fixture(t, 'diss');
  f.edits.length = 0;
  await f.send('.diss');
  assert.match(f.visible(), /回复对方的消息发/);
  f.edits.length = 0;
  await f.send('.dissclear');
  assert.match(f.visible(), /本会话锁定已全部清除/);
  f.edits.length = 0;
  await f.send('.dishelp');
  assert.match(f.visible(), /嘴臭对线机/);
  f.edits.length = 0;
  await f.send('.dissai model');
  assert.match(f.visible(), /Diss AI 设置/);
  f.edits.length = 0;
  await f.send('.dissai model gpt-4o');
  assert.match(f.visible(), /已设置 Diss 模型/);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'diss', 'config.json'), 'utf8'));
  assert.equal(config.model, 'gpt-4o');
});

async function snapshot(root) {
  const out = {};
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  };
  await walk(root);
  return out;
}

test('B4 nested fixed actions are declared as real handler leaves', async t => {
  const matrix = {
    bs: {command: 'bs', leaves: [['add'], ['list'], ['del'], ['enable'], ['disable'], ['toggle', 'mode']]},
    checkin: {command: 'checkin', leaves: [['add'], ['list'], ['del'], ['toggle'], ['test'], ['settings'], ['reset'], ['set', 'time'], ['set', 'range'], ['set', 'delay'], ['set', 'bot'], ['set', 'log']]},
    clean: {command: 'clean', leaves: [['deleted', 'pm', 'rm'], ['deleted', 'member', 'rm'], ['blocked', 'pm', 'all'], ['blocked', 'member', 'all']]},
    deepwiki: {command: 'deepwiki', leaves: [['add'], ['lst'], ['use'], ['del'], ['ctx', 'on'], ['ctx', 'off'], ['ctx', 'del']]},
    diss: {command: 'dissai', leaves: [['model'], ['provider'], ['reasoning']]},
  };
  for (const [id, {command, leaves}] of Object.entries(matrix)) {
    const root = load(id).commands[command];
    const actual = [];
    const walk = (node, prefix) => {
      for (const [name, sub] of Object.entries(node.subcommands ?? {})) {
        const next = [...prefix, name];
        if (sub.subcommands) walk(sub, next);
        else { actual.push(next); assert.equal(typeof sub.handle, 'function', `${id} ${next.join(' ')} has a handler`); }
      }
    };
    walk(root, []);
    const key = list => list.join(' ');
    assert.deepEqual(actual.map(key).sort(), leaves.map(key).sort(), `${id} leaf coverage`);
    // parents along every expected leaf keep a fallback handler
    for (const leaf of leaves) {
      let node = root;
      for (const name of leaf.slice(0, -1)) {
        node = node.subcommands[name];
        assert.equal(typeof node.handle, 'function', `${id} ${leaf.join(' ')} parent ${name} has a fallback`);
      }
    }
  }
});

test('B4 deep help is injected before business for both host help routes', async t => {
  const matrix = [
    ['bs', 'bs', [['add'], ['list'], ['del'], ['enable'], ['disable'], ['toggle', 'mode']]],
    ['checkin', 'checkin', [['add'], ['list'], ['del'], ['toggle'], ['test'], ['settings'], ['reset'], ['set'], ['set', 'time'], ['set', 'range'], ['set', 'delay'], ['set', 'bot'], ['set', 'log']]],
    ['clean', 'clean', [['deleted'], ['deleted', 'pm'], ['deleted', 'pm', 'rm'], ['deleted', 'member'], ['deleted', 'member', 'rm'], ['blocked'], ['blocked', 'pm'], ['blocked', 'pm', 'all'], ['blocked', 'member'], ['blocked', 'member', 'all']]],
    ['deepwiki', 'deepwiki', [['add'], ['lst'], ['use'], ['del'], ['ctx'], ['ctx', 'on'], ['ctx', 'off'], ['ctx', 'del']]],
    ['diss', 'dissai', [['model'], ['provider'], ['reasoning']]],
    ['convert', 'convert', [['u'], ['apikey'], ['clear']]],
    ['codex_image', 'cximg', [['token']]],
  ];
  for (const [id, command, leaves] of matrix) {
    const f = await fixture(t, id, {helpBuiltin: true});
    const before = await snapshot(f.root);
    for (const leaf of leaves) {
      f.edits.length = 0; f.calls.length = 0;
      assert.equal(await f.send(`.${command}${leaf.length ? ` ${leaf.join(' ')}` : ''} --help`), true, `${id} --help ${leaf.join(' ')}`);
      assert.ok(f.visible().includes(`.${command}${leaf.length ? ` ${leaf.join(' ')}` : ''}`), `${id} focused help ${leaf.join(' ')}`);
      assert.equal(f.calls.length, 0, `${id} --help ${leaf.join(' ')} must not touch the client`);
      f.edits.length = 0; f.calls.length = 0;
      assert.equal(await f.send(`.help ${command}${leaf.length ? ` ${leaf.join(' ')}` : ''}`), true, `${id} .help ${leaf.join(' ')}`);
      assert.ok(f.visible().length > 0, `${id} .help ${leaf.join(' ')} renders`);
      assert.equal(f.calls.length, 0, `${id} .help ${leaf.join(' ')} must not touch the client`);
    }
    assert.deepEqual(await snapshot(f.root), before, `${id} deep help must not write state`);
  }
});

test('B4 fixed actions are not executed by --help', async t => {
  const bs = await fixture(t, 'bs', {seed: async root => {
    await fs.mkdir(path.join(root, 'bs'));
    await fs.writeFile(path.join(root, 'bs', 'config.json'), JSON.stringify({schemaVersion: 1, seq: '0', mode: 'sequence', targets: []}));
  }, withClient: async () => {throw new Error('help must not use the client');}});
  await bs.send('.bs toggle mode --help');
  assert.equal(JSON.parse(await fs.readFile(path.join(bs.root, 'bs', 'config.json'), 'utf8')).mode, 'sequence', 'toggle mode --help must not flip the mode');

  const checkin = await fixture(t, 'checkin', {seed: async root => {
    await fs.mkdir(path.join(root, 'checkin'));
    await fs.writeFile(path.join(root, 'checkin', 'state.json'), JSON.stringify({schemaVersion: 1, runTime: '10:00', runTimeEnd: '11:30', randomDelay: 0, logChat: '', botToken: '', pushChatId: '', targets: [], lastRunDate: '', pending: {}, legacyImported: true}));
  }, withClient: async () => {throw new Error('help must not use the client');}});
  await checkin.send('.checkin set log --help');
  assert.equal(JSON.parse(await fs.readFile(path.join(checkin.root, 'checkin', 'state.json'), 'utf8')).logChat, '', 'set log --help must not store the flag');

  const clean = await fixture(t, 'clean', {withClient: async () => {throw new Error('help must not use the client');}});
  clean.calls.length = 0;
  await clean.send('.clean deleted member rm --help');
  assert.equal(clean.calls.length, 0, 'clean rm --help must not call the client');
});

test('clean execution branches share the outer error, FLOOD_WAIT and abort handling', async t => {
  for (const text of ['.clean deleted pm', '.clean deleted member rm', '.clean blocked pm', '.clean blocked member all']) {
    const f = await fixture(t, 'clean', {withClient: async () => {throw new Error('FLOOD_WAIT_30');}});
    f.edits.length = 0;
    assert.equal(await f.send(text), true, text);
    if (text === '.clean deleted pm' || text === '.clean blocked pm') assert.match(f.visible(), /正在扫描|开始清理/, `${text} shows progress first`);
    assert.match(f.visible(), /请求过于频繁，请稍后重试/, `${text} maps FLOOD_WAIT`);
  }
  const generic = await fixture(t, 'clean', {withClient: async () => {throw new Error('boom');}});
  generic.edits.length = 0;
  await generic.send('.clean blocked pm');
  assert.match(generic.visible(), /操作失败.*boom/s);
  // Abort suppresses the error edit (direct handler contract).
  const definition = load('clean');
  const controller = new AbortController(); controller.abort();
  const edits = [];
  const context = {signal: controller.signal, telegram: {edit: async (_m, text) => {edits.push(text);}, withClient: async () => {throw new Error('FLOOD_WAIT_30');}}, log: {info() {}, error() {}}};
  await definition.commands.clean.subcommands.deleted.subcommands.pm.handle({message: {id: 1, chatId: '1', raw: {}}, command: 'clean', prefix: '.', args: []}, context);
  assert.ok(!edits.some(text => /操作失败|请求过于频繁/.test(text)), 'aborted signal suppresses the error edit');
});

test('clean and convert restore first-token help fallbacks with zero business', async t => {
  const clean = await fixture(t, 'clean', {withClient: async () => {throw new Error('help must not use the client');}});
  for (const text of ['.clean', '.clean help', '.clean h', '.clean help extra', '.clean h foo']) {
    clean.edits.length = 0; clean.calls.length = 0;
    assert.equal(await clean.send(text), true, text);
    assert.match(clean.visible(), /清理工具 Pro/, text);
    assert.equal(clean.calls.length, 0, `${text} must not call the client`);
  }
  const convert = await fixture(t, 'convert', {withClient: async () => {throw new Error('help must not use the client');}});
  for (const text of ['.convert', '.convert help', '.convert h', '.convert help extra', '.convert h foo']) {
    convert.edits.length = 0; convert.calls.length = 0;
    assert.equal(await convert.send(text), true, text);
    assert.match(convert.visible(), /视频转音频|MP3/, text);
    assert.equal(convert.calls.length, 0, `${text} must not call the client`);
  }
  // A reply without args still converts.
  const withReply = await fixture(t, 'convert', {withClient: async () => {throw new Error('conversion path reached');}});
  await withReply.send('.convert', {replyToId: 5});
  assert.ok(withReply.errors.some(entry => entry.event === 'convert_failed') || /转换失败/.test(withReply.visible()), 'reply keeps the conversion path');
});

test('bs missing IDs and checkapi unknown-action fallback match the baseline', async t => {
  const bs = await fixture(t, 'bs', {withClient: async () => {throw new Error('no client needed');}});
  const bsState = path.join(bs.root, 'bs', 'config.json');
  const bsBefore = await fs.readFile(bsState, 'utf8');
  for (const text of ['.bs del', '.bs rm', '.bs enable', '.bs on', '.bs disable', '.bs off']) {
    bs.edits.length = 0;
    assert.equal(await bs.send(text), true, text);
    assert.match(bs.visible(), /保送插件/, text);
    assert.equal(await fs.readFile(bsState, 'utf8'), bsBefore, `${text} must not write state`);
  }
  bs.edits.length = 0;
  await bs.send('.bs del 99');
  assert.match(bs.visible(), /目标不存在/);

  const checkapi = await fixture(t, 'checkapi', {seed: async root => {
    await fs.mkdir(path.join(root, 'checkapi'));
    await fs.writeFile(path.join(root, 'checkapi', 'keys-v2.json'), JSON.stringify({schemaVersion: 1, legacyImported: true, entries: [{name: 'demo', key: 'sk-demo', baseUrl: 'https://api.example.com/v1', addedAt: 1}]}));
  }, withClient: async () => {throw new Error('no client needed');}});
  checkapi.edits.length = 0;
  await checkapi.send('.checkapi bogus https://api.example.com/v1 key');
  assert.match(checkapi.visible(), /API 检测失败/);
  checkapi.edits.length = 0;
  await checkapi.send('.checkapi bogus demo');
  assert.match(checkapi.visible(), /API 检测失败/);
  checkapi.edits.length = 0;
  await checkapi.send('.checkapi bogus');
  assert.match(checkapi.visible(), /API 检测失败/);
});

test('checkin and diss listeners honor the fixed filters at the real host boundary', async t => {
  const checkin = await fixture(t, 'checkin', {seed: async root => {
    await fs.mkdir(path.join(root, 'checkin'));
    await fs.writeFile(path.join(root, 'checkin', 'state.json'), JSON.stringify({schemaVersion: 1, runTime: '10:00', runTimeEnd: '11:30', randomDelay: 0, logChat: '', botToken: '', pushChatId: '', targets: [], lastRunDate: '', pending: {'100': {promptId: 7, id: 't1', name: 'T', target: '@bot'}}, legacyImported: true}));
  }, withClient: async () => {throw new Error('listener must not use the client');}});
  const checkinBase = {chatId: '100', senderId: '1'};
  await checkin.host.dispatchListeners({...checkinBase, id: 1, outgoing: false, replyToId: 7, text: '/sign 1'});
  assert.equal(JSON.parse(await fs.readFile(path.join(checkin.root, 'checkin', 'state.json'), 'utf8')).targets.length, 0, 'incoming reply is rejected');
  await checkin.host.dispatchListeners({...checkinBase, id: 2, outgoing: true, replyToId: 7, text: '/sign 2'});
  const saved = JSON.parse(await fs.readFile(path.join(checkin.root, 'checkin', 'state.json'), 'utf8')).targets;
  assert.equal(saved.length, 1, 'outgoing reply to the prompt is accepted');
  assert.equal(saved[0].command, '/sign 2');
  await checkin.host.dispatchListeners({...checkinBase, id: 3, outgoing: true, replyToId: 99, text: '/sign 3'});
  assert.equal(JSON.parse(await fs.readFile(path.join(checkin.root, 'checkin', 'state.json'), 'utf8')).targets.length, 1, 'unrelated replies are ignored');

  const diss = await fixture(t, 'diss', {seed: async root => {
    await fs.mkdir(path.join(root, 'diss'));
    await fs.writeFile(path.join(root, 'diss', 'state.json'), JSON.stringify({'100': {'2': {name: 'Bob', lockedAt: 1, hits: 0}}}));
  }});
  const repliesBefore = diss.edits.length;
  await diss.host.dispatchListeners({chatId: '100', senderId: '2', id: 1, outgoing: true, text: 'hello'});
  await diss.host.dispatchListeners({chatId: '100', senderId: '2', id: 2, outgoing: false, saved: true, text: 'hello'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(diss.edits.length, repliesBefore, 'outgoing and saved messages never auto-reply');
  await diss.host.dispatchListeners({chatId: '100', senderId: '2', id: 3, outgoing: false, text: 'hello'});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(diss.edits.length > repliesBefore, 'incoming locked target gets a reply');
});

test('diss dishelp keeps the shared guard contract on the real handler', async t => {
  const definition = load('diss');
  const run = async (opts = {}) => {
    const edits = []; const logs = []; let count = 0;
    const controller = new AbortController();
    if (opts.abort) controller.abort();
    const ctx = {signal: controller.signal, log: {info() {}, error: (event, fields) => {logs.push({event, fields});}},
      telegram: {edit: async (_m, text) => {edits.push(text); count++; if (count === 1) throw new Error('temporary transport failure'); if (opts.secondFails) throw new Error('still failing');},
        reply: async () => {}}};
    let error;
    try { await definition.commands.dishelp.handle({message: {id: 1, chatId: '1', raw: {}}, command: 'dishelp', prefix: '.', args: []}, ctx); }
    catch (caught) { error = caught; }
    return {edits, logs, error};
  };
  const first = await run();
  assert.equal(first.edits.length, 2, 'first edit plus the guarded error edit');
  assert.equal(first.edits[1], '❌ 操作失败，请稍后重试');
  assert.ok(first.edits[0].includes('.diss'), 'the real module guide is still rendered');
  assert.ok(first.logs.some(entry => entry.event === 'diss.command_failed'), 'failure is logged');
  assert.equal(first.error, undefined, 'guard swallows the transport failure');
  const aborted = await run({abort: true});
  assert.equal(aborted.edits.length, 1, 'aborted signal suppresses the error edit');
  assert.equal(aborted.error, undefined);
  assert.ok(aborted.logs.some(entry => entry.event === 'diss.command_failed'));
  const secondFails = await run({secondFails: true});
  assert.equal(secondFails.edits.length, 2, 'a failing error edit is attempted once');
  assert.equal(secondFails.error, undefined, 'a failing error edit never throws');
  assert.ok(secondFails.logs.some(entry => entry.event === 'diss.command_failed'));
});
