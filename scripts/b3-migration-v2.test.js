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

function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  const factory = require(path.join(artifactDir, 'index.cjs')).default;
  return typeof factory === 'function' ? factory() : factory;
}

async function fixture(t, id, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibox-b3-${id}-`)));
  const edits = [];
  const errors = [];
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes ?? ['.'], logger: {info() {}, error: (event, fields) => errors.push({event, fields})}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply(_message, text) {edits.push(text);},
    async invoke() {throw new Error('unexpected RPC');}, async getReply() {return undefined;},
    withClient: options.withClient ?? (async (operation, signal) => {
      return operation({async getMe() {return {id: 1n, firstName: 'Fixture', lastName: null, username: null, bot: false};},
        async getEntity() {return {className: 'Channel', id: 1, title: 'Fixture', username: null, broadcast: false, megagroup: true};}}, signal);
    }),
  }});
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  if (options.seed) await options.seed(root);
  await host.load(load(id));
  const visible = () => edits.map(page => HTMLParser.parse(page)[0]).join('\n');
  const send = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...extra});
  return {host, root, edits, errors, visible, send};
}

test('acron routes standard and management subcommands while preserving cron and multiline syntax', async t => {
  const f = await fixture(t, 'acron');
  for (const input of ['.acron', '.acron help']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true);
    assert.match(f.visible(), /定时发送|Cron/, input);
  }
  f.edits.length = 0;
  assert.equal(await f.send('.acron list'), true);
  assert.match(f.visible(), /暂无定时任务/);
  f.edits.length = 0;
  assert.equal(await f.send('.acron LIST'), true, 'list is case-insensitive');
  assert.match(f.visible(), /暂无定时任务/);
  f.edits.length = 0;
  assert.equal(await f.send('.acron bogus'), true);
  assert.match(f.visible(), /Cron|定时/, 'unknown action falls back to help');
  f.edits.length = 0;
  assert.equal(await f.send('.acron send 0 0 2 * * * me'), true);
  assert.match(f.visible(), /请回复要定时发送的文本消息/);
  f.edits.length = 0;
  assert.equal(await f.send('.acron send 1 2 3 me'), true);
  assert.match(f.visible(), /Cron 表达式必须为 6 段/);
  f.edits.length = 0;
  assert.equal(await f.send('.acron cmd 0 0 2 * * * me 备注\n.ping'), true);
  assert.match(f.visible(), /已添加定时任务/);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'acron', 'acron_config.json'), 'utf8'));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].type, 'cmd');
  assert.equal(state.tasks[0].message, '.ping', 'multiline command body is preserved');
});

test('admin_board keeps unknown-action failure and help isolation', async t => {
  const f = await fixture(t, 'admin_board');
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board'), true);
  assert.match(f.visible(), /管理员席位管理/);
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board bogus'), true);
  assert.match(f.visible(), /执行失败/);
  assert.match(f.visible(), /不支持的动作: bogus/);
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board rm'), true);
  assert.match(f.visible(), /rm 的人数参数是必填正整数/);
});

test('ai keeps free-text questions away from help routing and serves declared help', async t => {
  const f = await fixture(t, 'ai');
  for (const input of ['.ai help', '.ai ?', '.ai help extra']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /AI 助手/, input);
  }
  f.edits.length = 0;
  assert.equal(await f.send('.ai 你好，请解释一下 DNS'), true);
  assert.match(f.visible(), /AI 操作失败|AI 思考中|AI 助手/, 'free text stays with the chat path');
});

test('autochangename exposes the declared tree and keeps unknown/case behaviour', async t => {
  const f = await fixture(t, 'autochangename');
  f.edits.length = 0;
  assert.equal(await f.send('.acn'), true);
  assert.match(f.visible(), /自动昵称/);
  f.edits.length = 0;
  assert.equal(await f.send('.acn save'), true);
  assert.match(f.visible(), /原始昵称已保存/);
  f.edits.length = 0;
  assert.equal(await f.send('.acn bogus'), true);
  assert.match(f.visible(), /未知命令/);
  f.edits.length = 0;
  assert.equal(await f.send('.acn tz format GMT'), true);
  assert.match(f.visible(), /时区格式已更新/);
  f.edits.length = 0;
  assert.equal(await f.send('.acn tz NotA/Zone'), true);
  assert.match(f.visible(), /无效的时区标识符/);
  f.edits.length = 0;
  assert.equal(await f.send('.acn text add 摸鱼中'), true);
  assert.match(f.visible(), /成功添加 1 条/);
  f.edits.length = 0;
  f.edits.length = 0;
  assert.equal(await f.send('.autochangename tz format GMT'), true, 'autochangename shares the same declaration as acn');
  assert.match(f.visible(), /时区格式已更新/);
  const acnState = JSON.parse(await fs.readFile(path.join(f.root, 'autochangename', 'autochangename.json'), 'utf8'));
  assert.equal(acnState.users['1'].timezone_format, 'GMT');
});

test('aitc redirects provider configuration to ai while keeping prompt controls local', async t => {
  const f = await fixture(t, 'aitc');
  for (const input of ['.aitc url not-a-url', '.aitc model', '.aitc key', '.aitc model gpt-4o-mini']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true);
    assert.match(f.visible(), /ai 插件统一管理/);
  }
  assert.equal(f.errors.some(entry => entry.event === 'aitc_failed'), false);
  f.edits.length = 0;
  assert.equal(await f.send('.aitc prompt'), true);
  assert.equal(f.visible(), '请提供 Prompt 文本');
  f.edits.length = 0;
  assert.equal(await f.send('.aitc prompt 翻译为英文'), true);
  assert.equal(f.visible(), '默认 Prompt 已更新');
});

test('autorepeat subcommands keep the outer failure and abort handling', async t => {
  const f = await fixture(t, 'autorepeat', {withClient: async () => {throw new Error('peer unavailable');}});
  f.edits.length = 0;
  assert.equal(await f.send('.autorepeat on @badgroup'), true);
  assert.match(f.visible(), /操作失败/);
  assert.match(f.visible(), /peer unavailable/);
  f.edits.length = 0;
  assert.equal(await f.send('.autorepeat allon'), true);
  assert.match(f.visible(), /操作失败/);
});

test('aban and botmzt default entries render the full module guide without touching the client', async t => {
  const aban = await fixture(t, 'aban', {withClient: async () => {throw new Error('client must not run for help');}});
  for (const input of ['.aban', '.kick help', '.ban h']) {
    aban.edits.length = 0;
    assert.equal(await aban.send(input), true, input);
    const output = aban.visible();
    for (const key of ['kick', 'ban', 'unban', 'mute', 'unmute', 'sb', 'unsb', 'refresh']) assert.ok(output.includes(`.${key}`), `${input}: ${key}`);
    assert.ok(output.includes('基本群仅支持踢出'), `${input}: group limit note`);
    assert.ok(output.includes('封禁并清理消息'), `${input}: ban semantics`);
    assert.ok(output.includes('在所有有管理权的群/频道封禁'), `${input}: super ban semantics`);
  }
  const botmzt = await fixture(t, 'botmzt', {withClient: async () => {throw new Error('client must not run for help');}});
  botmzt.edits.length = 0;
  assert.equal(await botmzt.send('.botmzt'), true);
  const output = botmzt.visible();
  for (const label of ['随机图片', '妹子图片', '腿部图片', '臀部图片', '胸部图片', 'Cosplay图片', 'NSFW图片', '奶子图片', '签到命令']) assert.ok(output.includes(label), label);
});

test('autodel help tokens with extra arguments and direct calls keep the declared guide', async t => {
  const f = await fixture(t, 'autodel');
  for (const input of ['.autodel', '.autodel help', '.autodel h', '.autodel help extra', '.autodel h foo']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /定时自动删除消息/, input);
  }
  f.edits.length = 0;
  assert.equal(await f.send('.autodel 30s'), true);
  assert.match(f.visible(), /设置自动删除任务成功/);
  f.edits.length = 0;
  assert.equal(await f.send('.autodel cancel'), true);
  assert.match(f.visible(), /取消自动删除任务成功/);
  // Direct handler contract: empty input still shows the same guide.
  const definition = load('autodel');
  const sent = [];
  const context = {signal: new AbortController().signal, telegram: {edit: async (_m, text) => {sent.push(text);}}};
  await definition.commands.autodel.handle({command: 'autodel', prefix: '.', args: [], message: {id: 1, chatId: '1', text: '.autodel', outgoing: true}}, context);
  assert.ok(sent.join('\n').includes('定时自动删除消息'));
});

test('migrated extension help keeps the original detailed anchors', async t => {
  const anchors = {
    'audio_to_voice': ['OGG/Opus'],
    'biko': ['收藏夹（Saved Messages）'],
    'bin': ['Bincheck'],
    'bizhi': ['wallhaven'],
    'bgp': ['BGP'],
    'annualreport': ['年度报告'],
    'atadmins': ['管理员召唤'],
    'atall': ['@所有人'],
    'aban': ['基本群仅支持踢出'],
    'botmzt': ['剧透'],
    'aff': ['最多保存 32 条'],
    'aitc': ['统一管理'],
    'autodelcmd': ['规则冲突'],
    'autorepeat': ['每日限制'],
    'banana': ['256KB 至 25MB'],
    'autodel': ['最小删除时间为5秒'],
  };
  for (const [id, expected] of Object.entries(anchors)) {
    const definition = load(id);
    assert.equal(typeof definition.renderHelp, 'function', `${id} supplies help`);
    const output = HTMLParser.parse(definition.renderHelp('.')).join('\n');
    for (const anchor of expected) assert.ok(output.includes(anchor), `${id}: ${anchor}`);
  }
});

test('deep declared paths serve help with zero writes and zero external work', async t => {
  const ai = await fixture(t, 'ai', {withClient: async () => {throw new Error('help must not use the client');}});
  const aiConfig = path.join(ai.root, 'ai', 'config.json');
  for (const [input, expected] of [['.ai prompt set --help', /设置提示词/], ['.ai config add --help', /添加 API 配置/], ['.ai image preview --help', /图片预览/], ['.ai video duration --help', /视频输出时长/], ['.ai telegraph del --help', /删除全部记录/], ['.ai help extra', /AI 助手/]]) {
    ai.edits.length = 0;
    assert.equal(await ai.send(input), true, input);
    assert.match(ai.visible(), expected, input);
  }
  await assert.rejects(fs.readFile(aiConfig, 'utf8'), 'ai help must not write config');

  const acn = await fixture(t, 'autochangename', {seed: async root => {
    await fs.mkdir(path.join(root, 'autochangename'));
    await fs.writeFile(path.join(root, 'autochangename', 'autochangename.json'), JSON.stringify({schemaVersion: 1,
      users: {'1': {user_id: '1', timezone: 'Asia/Shanghai', original_first_name: 'Fixture', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0}},
      random_texts: ['keep me']}));
  }, withClient: async () => {throw new Error('help must not use the client');}});
  for (const [input, expected] of [['.acn tz format --help', /设置时区的显示格式/], ['.acn text add --help', /添加文案/], ['.acn weather set --help', /设置天气地点/], ['.acn text clear --help', /清空所有文案/]]) {
    acn.edits.length = 0;
    assert.equal(await acn.send(input), true, input);
    assert.match(acn.visible(), expected, input);
  }
  const state = JSON.parse(await fs.readFile(path.join(acn.root, 'autochangename', 'autochangename.json'), 'utf8'));
  assert.equal(state.users['1'].weather_location, undefined, 'weather set --help must not set a location');
  assert.deepEqual(state.random_texts, ['keep me'], 'text clear --help must not clear');
});

test('ai keeps mixed-case recognition per branch and never turns uppercase prompts into config', async t => {
  const f = await fixture(t, 'ai');
  const config = path.join(f.root, 'ai', 'config.json');
  const read = async () => { try { return JSON.parse(await fs.readFile(config, 'utf8')); } catch { return undefined; } };
  for (const input of ['.ai TIMEOUT 60', '.ai COLLAPSE on', '.ai PROMPT set hello', '.ai TELEGRAPH on']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.ok(f.visible().includes('AI 操作失败') || f.visible().includes('AI 思考中'), `${input} must go to the free-text path`);
    assert.equal(await read(), undefined, `${input} must not write config`);
  }
  for (const input of ['.ai timeout 60', '.ai collapse on']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /AI 输出设置已更新/, input);
  }
  const written = await read();
  assert.equal(written.timeout, 60);
  assert.equal(written.collapse, true);
  f.edits.length = 0;
  assert.equal(await f.send('.ai CONFIG list'), true, 'CONFIG stays case-insensitive');
  assert.match(f.visible(), /AI 配置/);
});

test('acron list/la resolve the filter token at the right position', async t => {
  const f = await fixture(t, 'acron', {seed: async root => {
    await fs.mkdir(path.join(root, 'acron'));
    const task = (id, type, chatId) => ({id, type, cron: '0 0 2 * * *', chat: chatId, chatId, createdAt: '1', delivery: 'pending'});
    await fs.writeFile(path.join(root, 'acron', 'acron_config.json'), JSON.stringify({schemaVersion: 1, seq: '3', tasks: [task('1', 'del', '1'), task('2', 'send', '2'), task('3', 'copy', '1')]}));
  }});
  const run = async input => { f.edits.length = 0; assert.equal(await f.send(input), true, input); return f.visible(); };
  assert.match(await run('.acron la del'), /1 个[\s\S]*1 · del/);
  assert.doesNotMatch(await run('.acron la del'), /send|copy/);
  assert.match(await run('.acron ls all del'), /1 个[\s\S]*1 · del/);
  assert.match(await run('.acron list'), /当前会话定时任务 · 2 个/);
  assert.match(await run('.acron list all'), /所有定时任务 · 3 个/);
  assert.match(await run('.acron list del'), /当前会话定时任务 · 1 个/);
  assert.match(await run('.acron la'), /所有定时任务 · 3 个/);
  assert.match(await run('.acron list ALL'), /当前会话定时任务 · 2 个/, 'ALL is not the literal all token');
});

test('autochangename keeps identity, save precondition, fallback wording and concurrent mode updates', async t => {
  const f = await fixture(t, 'autochangename');
  // Unsaved: unknown falls back to the save precondition.
  f.edits.length = 0;
  assert.equal(await f.send('.acn bogus'), true);
  assert.match(f.visible(), /请先 .*acn save/);
  // help with extra tokens falls back to the declared guide.
  f.edits.length = 0;
  assert.equal(await f.send('.acn help extra'), true);
  assert.match(f.visible(), /自动昵称/);
  // Identity is required for status.
  f.edits.length = 0;
  assert.equal(await f.send('.acn status', {senderId: undefined}), true);
  assert.match(f.visible(), /无法识别您的身份/);
  // Save then unknown text action keeps the original wording.
  await f.send('.acn save');
  f.edits.length = 0;
  assert.equal(await f.send('.acn text bogus'), true);
  assert.match(f.visible(), /未知命令: text/);
  // Two concurrent mode toggles must both be applied to current state (time → text → both).
  await Promise.all([f.send('.acn mode', {chatId: '1'}), f.send('.acn mode', {chatId: '2'})]);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'autochangename', 'autochangename.json'), 'utf8'));
  assert.equal(state.users['1'].mode, 'both');
});

test('admin_board resolves the target before reporting unsupported actions or missing counts', async t => {
  const inaccessible = await fixture(t, 'admin_board', {withClient: async operation => {
    return operation({async getEntity() {throw Object.assign(new Error('CHANNEL_PRIVATE'), {message: 'CHANNEL_PRIVATE'});}}, new AbortController().signal);
  }});
  for (const input of ['.admin_board bogus', '.admin_board rm', '.admin_board ls']) {
    inaccessible.edits.length = 0;
    assert.equal(await inaccessible.send(input), true, input);
    assert.match(inaccessible.visible(), /无法访问该私有频道\/群组/, input);
  }
});

test('every declared AI and ACN leaf path renders focused help without side effects', async t => {
  for (const id of ['ai', 'autochangename']) {
    const definition = load(id);
    const root = definition.commands[id] ?? definition.commands.acn;
    const paths = [];
    const walk = (node, path) => {
      for (const [name, sub] of Object.entries(node.subcommands ?? {})) {
        const next = [...path, name];
        if (sub.subcommands) walk(sub, next); else paths.push(next);
      }
    };
    walk(root, []);
    assert.ok(paths.length >= 5, `${id} declares nested leaf paths`);
    const seed = id === 'autochangename' ? async root => {
      await fs.mkdir(path.join(root, 'autochangename'));
      await fs.writeFile(path.join(root, 'autochangename', 'autochangename.json'), JSON.stringify({schemaVersion: 1,
        users: {'1': {user_id: '1', timezone: 'Asia/Shanghai', original_first_name: 'Fixture', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0}}, random_texts: []}));
    } : undefined;
    const f = await fixture(t, id, {seed, withClient: async () => {throw new Error('help must not use the client');}});
    const stateFile = id === 'ai' ? path.join(f.root, 'ai', 'config.json') : path.join(f.root, 'autochangename', 'autochangename.json');
    const before = await fs.readFile(stateFile, 'utf8').catch(() => undefined);
    for (const path of paths) {
      f.edits.length = 0;
      assert.equal(await f.send(`.${id === 'ai' ? 'ai' : 'acn'} ${path.join(' ')} --help`), true, path.join(' '));
      assert.ok(f.edits.length, path.join(' '));
    }
    assert.equal(await fs.readFile(stateFile, 'utf8').catch(() => undefined), before, `${id} help must not write`);
  }
});

test('admin_board resolves a valid target before unsupported-action or missing-count errors', async t => {
  const f = await fixture(t, 'admin_board');
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board bogus'), true);
  assert.match(f.visible(), /不支持的动作: bogus/);
  assert.doesNotMatch(f.visible(), /无法访问/);
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board rm'), true);
  assert.match(f.visible(), /rm 的人数参数是必填正整数/);
  f.edits.length = 0;
  assert.equal(await f.send('.admin_board tail 0'), true);
  assert.match(f.visible(), /tail 的人数参数必须是正整数/);
});

test('ai config defaults to list while config actions stay case-sensitive', async t => {
  const f = await fixture(t, 'ai');
  for (const input of ['.ai config', '.ai CONFIG', '.ai config list']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /AI 配置/, input);
  }
  for (const input of ['.ai config LIST', '.ai config bogus']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /未知 config 子命令/, input);
  }
});

test('ACN save-gated subtrees reject fresh users without writes and work after save', async t => {
  const f = await fixture(t, 'autochangename', {seed: async root => {
    await fs.mkdir(path.join(root, 'autochangename'));
    await fs.writeFile(path.join(root, 'autochangename', 'autochangename.json'), JSON.stringify({schemaVersion: 1,
      users: {'2': {user_id: '2', timezone: 'Asia/Shanghai', original_first_name: 'Other', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0}},
      random_texts: ['keep me']}));
  }});
  const stateFile = path.join(f.root, 'autochangename', 'autochangename.json');
  const before = await fs.readFile(stateFile, 'utf8');
  for (const input of ['.acn text clear', '.acn text list', '.acn tz list', '.acn weather', '.acn tz format GMT', '.acn text add memo']) {
    f.edits.length = 0;
    assert.equal(await f.send(input), true, input);
    assert.match(f.visible(), /请先 .*acn save/, input);
  }
  assert.equal(await fs.readFile(stateFile, 'utf8'), before, 'fresh user must not write');
  assert.ok(JSON.parse(before).users['2'], 'another user configuration is preserved');
  await f.send('.acn save');
  f.edits.length = 0;
  assert.equal(await f.send('.acn text clear'), true);
  assert.match(f.visible(), /所有文本已清空/);
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')).random_texts, []);
  assert.ok(JSON.parse(await fs.readFile(stateFile, 'utf8')).users['2'], 'other user survives save');
});

test('focused help attributes behaviour to the correct node and keeps custom prefixes', async t => {
  const f = await fixture(t, 'autochangename', {seed: async root => {
    await fs.mkdir(path.join(root, 'autochangename'));
    await fs.writeFile(path.join(root, 'autochangename', 'autochangename.json'), JSON.stringify({schemaVersion: 1,
      users: {'1': {user_id: '1', timezone: 'Asia/Shanghai', original_first_name: 'Fixture', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0}}, random_texts: []}));
  }});
  const help = async input => { f.edits.length = 0; assert.equal(await f.send(input), true, input); return f.visible(); };
  const mode = await help('.acn mode --help');
  assert.match(mode, /循环切换显示模式/);
  assert.doesNotMatch(mode, /立即手动更新/);
  assert.doesNotMatch(mode, /恢复原始昵称/);
  assert.match(await help('.acn update --help'), /立即手动更新一次昵称/);
  assert.match(await help('.acn reset --help'), /恢复原始昵称并停止自动更新/);
  const emoji = await help('.acn emoji --help');
  assert.match(emoji, /时钟 emoji/);
  assert.doesNotMatch(emoji, /时间显示/);
  assert.match(await help('.acn time --help'), /开启或关闭昵称中的时间显示/);
  const format = await help('.acn tz format --help');
  assert.match(format, /GMT（默认）/);
  assert.match(format, /UTC/);
  assert.match(format, /HKT \/ CST \/ EDT/);
  assert.match(format, /\+08:00/);
  assert.match(format, /custom:北京时间/);
  const ai = await fixture(t, 'ai');
  ai.edits.length = 0;
  await ai.send('.ai help');
  assert.match(ai.visible(), /缺少输入/);
  assert.doesNotMatch(ai.visible(), /不携带参数可进行查询/);
  const prefixed = await fixture(t, 'autochangename', {prefixes: ['<&🙂'], seed: async root => {
    await fs.mkdir(path.join(root, 'autochangename'));
    await fs.writeFile(path.join(root, 'autochangename', 'autochangename.json'), JSON.stringify({schemaVersion: 1,
      users: {'1': {user_id: '1', timezone: 'Asia/Shanghai', original_first_name: 'Fixture', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0}}, random_texts: []}));
  }});
  prefixed.edits.length = 0;
  await prefixed.send('<&🙂acn mode --help');
  assert.match(prefixed.visible(), /<&🙂acn mode/);
});
