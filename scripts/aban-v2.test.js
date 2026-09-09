'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildSync} = require(path.join(core, 'node_modules/esbuild'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
let root, factory, createRuntime, oracle;
const user = (id = 2) => new Api.User({id: integer(id), accessHash: integer(30), firstName: '<Target&>'});
const input = (id = 2) => new Api.InputPeerUser({userId: integer(id), accessHash: integer(30)});
const channel = (id = 100, rights = {banUsers: true}) => new Api.Channel({id: integer(id), accessHash: integer(20), title: 'Group ' + id,
  megagroup: true, adminRights: new Api.ChatAdminRights(rights), photo: new Api.ChatPhotoEmpty(), date: 0});
const normalize = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const message = (args = ['2'], basic = false) => ({id: 9, message: '.ban ' + args.join(' '), isGroup: true, isChannel: !basic,
  peerId: basic ? new Api.PeerChat({chatId: integer(100)}) : new Api.PeerChannel({channelId: integer(100)})});
test.before(async () => {
  root = await fs.mkdtemp(path.join(core, 'temp/aban-reference-'));
  const built = buildPlugin({id: 'aban', packageRoot: path.resolve(__dirname, '../aban'), entry: 'v2.ts', rootDir: core});
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
  buildSync({entryPoints: [path.resolve(__dirname, '../aban/v2/runtime.ts')], outfile: path.join(root, 'runtime.cjs'), bundle: true, platform: 'node', packages: 'external'});
  createRuntime = require(path.join(root, 'runtime.cjs')).createAbanRuntime;
  // Extract the original business classes directly, injecting only I/O resources.
  const source = await fs.readFile(path.resolve(__dirname, '../aban/aban.ts'), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const code = `import {Api} from 'teleproto';
import {returnBigInt as bigInt} from 'teleproto/Helpers.js';
export async function oracle(env) {
const ensurePLimit = async () => (await import('p-limit')).default;
const safeGetMe = client => client.getMe();
const safeGetReplyMessage = async () => env.reply;
const htmlEscape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const console = {log(){},error(){},warn(){}};
const sleep = async () => {};
const CONFIG = {MESSAGE_AUTO_DELETE:10};
const CacheManager = {getInstance: () => env.cache};
const MessageManager = {smartEdit: async (message, text) => {env.edits.push(text); return message;}};
${section('// 解析 FLOOD_WAIT', 'const sleep =')}
${section('function parseTimeString', '// ==================== 缓存管理器')}
${section('type ResolvedTarget', '// ==================== 消息管理器')}
${section('type ManagedGroup', '// ==================== 插件主类')}
return {UserResolver, GroupManager, BanManager, PermissionManager, CommandHandlers, parseTimeString};
}`.replaceAll(/const lc[12] = getCurrentGenerationContext\(\);[\s\S]*?\n        }/g, 'await MessageManager.smartEdit(status, result, 30);')
.replaceAll('backgroundProcess().catch(() => {});', 'await backgroundProcess();');
  buildSync({stdin: {contents: code, loader: 'ts', resolveDir: core}, outfile: path.join(root, 'oracle.cjs'), bundle: true, platform: 'node', packages: 'external'});
  oracle = require(path.join(root, 'oracle.cjs')).oracle;
});
test.after(async () => {await fs.rm(root, {recursive: true, force: true});});
function environment(options = {}) {
  const calls = [], edits = [], saved = {}, controller = new AbortController();
  const cache = {get: async key => saved[key] || null, set: async (key, value) => {saved[key] = value;}, clear: async () => {for (const key in saved) delete saved[key];}};
  const reply = options.reply ? {...options.reply, getSender: async () => options.reply.sender} : undefined;
  const base = {
    getMe: async () => user(1),
    getEntity: async value => {if (options.missing) throw new Error('CACHE_MISS'); return user(Number(value) || 2);},
    getInputEntity: async value => {if (options.missing && !(value instanceof Api.User)) throw new Error('CACHE_MISS'); return input(Number(value.id ?? value));},
    getDialogs: async () => (options.groups ?? [channel()]).map(entity => ({id: '-100' + entity.id, entity, title: entity.title,
      isGroup: true, isChannel: entity instanceof Api.Channel})),
    invoke: async request => {
      if (options.invoke) {const value = await options.invoke(request); if (value !== undefined) return value;}
      if (request instanceof Api.channels.GetParticipant) {
        if (options.lookupFails) throw new Error('PARTICIPANT_ID_INVALID');
        const self = request.participant?.toString() === '1';
        return {participant: self || options.admin ? new Api.ChannelParticipantCreator({userId: integer(self ? 1 : 2)})
          : new Api.ChannelParticipant({userId: integer(2)}), users: [user()]};
      }
      if (request instanceof Api.channels.GetParticipants) return {participants: [], users: []};
      if (request instanceof Api.messages.GetFullChat) return {fullChat: {participants: {participants: [
        new Api.ChatParticipantCreator({userId: integer(1)}), new Api.ChatParticipant({userId: integer(2)})]}}, users: [user()]};
      return {offset: 0};
    },
  };
  const client = new Proxy(base, {get(target, key) {return async (...args) => {
    controller.signal.throwIfAborted(); calls.push({method: key, args: normalize(args)});
    const result = await target[key](...args); controller.signal.throwIfAborted(); return result;
  };}});
  const ctx = {signal: controller.signal, log: {info(){},error(){}}, tasks: {run: async () => {}},
    storage: {json: () => ({read: async () => ({cache: saved}), update: async fn => {const next = fn({cache: saved});
      const copy = {...next.cache}; await cache.clear(); Object.assign(saved, copy);}})},
    telegram: {edit: async (_message, text) => {edits.push(text);}, getReply: async () => reply && ({senderId: String(reply.senderId), raw: reply})}};
  return {calls, edits, cache, client, ctx, reply, controller};
}
async function compare(options, run) {
  const reference = environment(options), migrated = environment(options);
  const original = await oracle(reference), current = await createRuntime(migrated.ctx, {message: {}, args: [], command: 'ban'});
  const expected = await run(original, reference), actual = await run(current, migrated);
  assert.deepEqual(normalize(actual), normalize(expected));
  assert.deepEqual(migrated.calls, reference.calls);
  const scrub = texts => texts.map(text => text.replace(/⏱️[\d.]+s/g, '⏱️time'));
  assert.deepEqual(scrub(migrated.edits), scrub(reference.edits));
  return migrated;
}
for (const action of ['ban', 'kick', 'unban', 'mute', 'unmute']) {
  test(action + ': RPC sequence, restriction flags and result match original', async () => {
    await compare({}, (r, e) => r.CommandHandlers.handleBasicCommand(e.client, message(['2', '5m']), action));
  });
}
test('single ban deletes history before restriction, matching original', async () => {
  const e = await compare({}, (r, e) => r.CommandHandlers.handleBasicCommand(e.client, message(), 'ban'));
  const requests = e.calls.filter(c => c.method === 'invoke').map(c => c.args[0].className);
  assert.ok(requests.indexOf('channels.DeleteParticipantHistory') < requests.indexOf('channels.EditBanned'));
});
test('reply resolves a reusable user input entity', async () => {
  const e = await compare({reply: {senderId: integer(2), sender: user()}}, (r, e) => r.UserResolver.resolveTarget(e.client, message([]), []));
  assert.equal(e.calls[0].method, 'getInputEntity');
  assert.equal(e.calls[0].args[0].className, 'User');
});
test('numeric current-channel member lookup and paging match original', async () => {
  await compare({missing: true, invoke: async req => {
    if (req instanceof Api.channels.GetParticipant && req.participant instanceof Api.InputPeerUser) return {users: []};
    if (req instanceof Api.channels.GetParticipants) return {participants: [{userId: integer(2)}], users: [user()]};
  }}, (r, e) => r.UserResolver.resolveTarget(e.client, message(), ['2']));
});
test('numeric unresolved channel target uses original pre-ban participant', async () => {
  const e = await compare({missing: true, lookupFails: true}, (r, e) => r.UserResolver.resolveTarget(e.client, message(), ['2']));
  assert.ok(e.calls.some(c => c.method === 'getDialogs'));
});
test('archived dialogs, deleteMessages rights, persistent cache and refresh match original', async () => {
  await compare({groups: [channel(), channel(200, {deleteMessages: true}), channel(300, {})]}, async (r, e) => {
    const first = await r.GroupManager.getManagedGroups(e.client);
    assert.equal(first.length, 2);
    assert.deepEqual(await r.GroupManager.getManagedGroups(e.client), first);
    assert.equal(e.calls.filter(c => c.method === 'getDialogs').length, 2);
    await r.GroupManager.clearCache();
    return r.GroupManager.getManagedGroups(e.client);
  });
});
test('target admin lookup error retains original batch behavior', async () => {
  const e = await compare({lookupFails: true}, (r, e) => r.CommandHandlers.handleSuperBan(e.client, message()));
  assert.ok(e.calls.some(c => c.args[0]?.className === 'channels.EditBanned'));
});
test('administrator confirmation precedes mutation', async () => {
  const e = await compare({admin: true}, (r, e) => r.CommandHandlers.handleSuperBan(e.client, message()));
  assert.ok(e.edits.at(-1).includes('true'));
  assert.ok(!e.calls.some(c => c.args[0]?.className === 'channels.EditBanned'));
  await compare({admin: true}, (r, e) => r.CommandHandlers.handleSuperBan(e.client, message(['2', 'true'])));
});
test('batch partial failures and history cleanup match original', async () => {
  await compare({groups: [channel(), channel(200)], invoke: async req => {
    if (req instanceof Api.channels.EditBanned && String(req.channel.channelId) === '200') throw new Error('PARTICIPANT_ID_INVALID');
  }}, (r, e) => r.CommandHandlers.handleSuperBan(e.client, message()));
});
test('basic group actions follow original RPC branching', async () => {
  for (const action of ['ban', 'kick', 'mute', 'unban']) {
    await compare({}, (r, e) => r.CommandHandlers.handleBasicCommand(e.client, message(['2'], true), action));
  }
});
test('unsb result and unsupported basic groups match original', async () => {
  await compare({groups: [channel(), new Api.Chat({id: integer(300), title: 'Basic', creator: true})]},
    (r, e) => r.CommandHandlers.handleSuperUnban(e.client, message()));
});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function hostFixture(t, options = {}) {
  const e = environment(options), dir = await fs.mkdtemp(path.join(root, 'host-'));
  const host = new PluginHost({storageRoot: dir, logger: {info(){},error(){}}, telegram: {
    edit: async (_msg, text, _opts, signal) => {signal.throwIfAborted(); e.edits.push(text); await options.onEdit?.(_msg, text);},
    reply: async () => assert.fail('unexpected reply'), getReply: async () => undefined,
    invoke: async () => assert.fail('unexpected direct RPC'), withClient: async (fn, signal) => fn(e.client, signal),
  }});
  await host.load(factory());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true);});
  const send = (text, id = 9, extra = {}) => host.dispatchPrimary({id, chatId: '-100100', senderId: '1', text, outgoing: true, ...extra});
  return {...e, host, send};
}
test('factory commands, help and edited-message protection', async t => {
  assert.deepEqual(Object.keys(factory().commands).sort(), ['aban','ban','kick','mute','refresh','sb','unban','unmute','unsb']);
  const e = await hostFixture(t);
  await e.send('.aban');
  assert.equal(e.calls.length, 0);
  await e.send('.ban 2', 9, {edited: true});
  assert.equal(e.calls.length, 0);
});
test('unload drains in-flight batch and stops queued native calls', async t => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve({}));
  const e = await hostFixture(t, {groups: Array.from({length: 9}, (_, i) => channel(100 + i)), invoke: async req => {
    if (req instanceof Api.channels.EditBanned) {entered.resolve(); return finish.promise;}
  }});
  await e.send('.sb 2'); await entered.promise;
  assert.equal((await e.host.unload('aban', 5)).completed, false);
  const before = e.calls.filter(c => c.args[0]?.className === 'channels.EditBanned').length;
  assert.equal(before, 4);
  finish.resolve({});
  assert.equal((await e.host.unload('aban', 1000)).completed, true);
  assert.equal(e.calls.filter(c => c.args[0]?.className === 'channels.EditBanned').length, before);
});
test('a pending result acknowledgement permits a second batch', async t => {
  const entered = deferred(), finish = deferred(), second = deferred();
  t.after(() => finish.resolve());
  const e = await hostFixture(t, {onEdit: async (msg, text) => {
    if (text.startsWith('✅ 在') && msg.id === 9) {entered.resolve(); await finish.promise;}
    if (text.startsWith('✅ 在') && msg.id === 10) second.resolve();
  }});
  await e.send('.sb 2'); await entered.promise;
  await e.send('.sb 3', 10); await second.promise;
  finish.resolve();
});
