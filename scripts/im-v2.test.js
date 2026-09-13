'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const packageRoot = process.env.IM_PACKAGE_ROOT || path.resolve(__dirname, '../im');
const {artifactDir} = buildPlugin({id: 'im', packageRoot, entry: 'v2.ts'});
const artifact = require(path.join(artifactDir, 'index.cjs'));
const createIm = artifact.default;
const peer = new Api.PeerChannel({channelId: 55n});
const base = {id: 1, chatId: '-10055', senderId: '9', outgoing: true, text: '.im help', raw: {peerId: peer}};

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-im-v2-')));
  if (options.setupRoot) await options.setupRoot(root);
  const edits = [], replies = [], invokes = [], deletes = [], logs = [];
  let replied = options.reply;
  const client = {async getEntity() {return options.entity ?? new Api.Channel({id: 55n, accessHash: 7n, title: '<群😀>', photo: new Api.ChatPhotoEmpty(), date: 0});},
    async getInputEntity(value) {return String(value).includes('9') ? new Api.InputPeerUser({userId: 9n, accessHash: 3n}) : new Api.InputPeerChannel({channelId: 55n, accessHash: 7n});},
    async *iterDownload() {yield Buffer.from('image');}, async invoke(request) {invokes.push(request); return {};},
    async deleteMessages(target, ids, settings) {deletes.push({target, ids, settings});}, ...options.client};
  const host = new PluginHost({storageRoot: root, logger: {info(event, fields) {logs.push({event, fields});}, error(event, fields) {logs.push({event, fields});}}, telegram: {
    async edit(message, text, settings) {edits.push({message, text, settings});}, async reply(message, text, settings) {replies.push({message, text, settings});},
    async invoke(request) {return client.invoke(request);}, async getReply() {return replied;}, async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(createIm());
  t.after(async () => {const report = await host.shutdown(1000); assert.equal(report.completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {root, host, client, edits, replies, invokes, deletes, logs, setReply(value) {replied = value;},
    run: (text, extra = {}) => host.dispatchPrimary({...base, text, ...extra}),
    listen: extra => host.dispatchListeners({...base, id: 20, outgoing: false, text: '', ...extra})};
}

test('configuration preserves original feedback, current chat identity, and complete escaped lists', async t => {
  const f = await fixture(t);
  await f.run('.im addchat');
  assert.match(f.edits.at(-1).text, /已添加.*&lt;群😀&gt;/);
  await f.run('.im addchat');
  assert.match(f.edits.at(-1).text, /已在监控列表中/);
  const first = 'a'.repeat(32), absent = 'b'.repeat(32);
  await f.run(`.im addmd5 ${first} ban`);
  assert.match(f.edits.at(-1).text, /操作：<code>ban<\/code>/);
  await f.run(`.im delmd5 ${absent}`);
  assert.match(f.edits.at(-1).text, /不在列表中/);
  for (let index = 0; index < 100; index++) await f.run(`.im addmd5 ${index.toString(16).padStart(32, '0')} delete`);
  await f.run('.im list');
  const pages = [f.edits.at(-1), ...f.replies];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(value => value.text.length <= 4096));
  assert.match(pages.map(value => value.text).join('\n'), new RegExp(first));
  assert.match(pages.at(-1).text, new RegExp(`${pages.length}/${pages.length} 页`));
});

test('first Host load imports every legacy field when the new config file is absent', async t => {
  const legacy = {enabled: false, monitoredChats: ['-1007'], bannedMD5s: {['a'.repeat(32)]: 'ban'}, bannedStickerIds: {'77': 'delete'},
    defaultAction: 'ban', legacyOnly: '<kept>'};
  const f = await fixture(t, {setupRoot: async root => {const directory = path.join(root, 'im'); await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'image_monitor_config.json'), JSON.stringify(legacy));}});
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'im', 'config.json'), 'utf8'));
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.monitoredChats, [{id: '-1007', name: '-1007'}]);
  assert.equal(saved.bannedMD5s['a'.repeat(32)], 'ban');
  assert.equal(saved.bannedStickerIds['77'], 'delete');
  assert.equal(saved.defaultAction, 'ban');
  assert.equal(saved.legacyOnly, '<kept>');
  assert.equal(saved.importedLegacy, true);
});

test('explicit V2 fields win, unknown data survives, and completed migration never rereads legacy', async t => {
  const f = await fixture(t, {setupRoot: async root => {const directory = path.join(root, 'im'); await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'image_monitor_config.json'), JSON.stringify({enabled: false, monitoredChats: ['legacy'], oldUnknown: 1}));
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({schemaVersion: 1, importedLegacy: false, enabled: true, monitoredChats: [], v2Unknown: 2}));}});
  let saved = JSON.parse(await fs.readFile(path.join(f.root, 'im', 'config.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.monitoredChats, []);
  assert.equal(saved.oldUnknown, 1);
  assert.equal(saved.v2Unknown, 2);
  await fs.writeFile(path.join(f.root, 'im', 'image_monitor_config.json'), JSON.stringify({enabled: false, monitoredChats: ['changed']}));
  assert.equal((await f.host.unload('im', 1000)).completed, true);
  await f.host.load(createIm());
  saved = JSON.parse(await fs.readFile(path.join(f.root, 'im', 'config.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.monitoredChats, []);
  assert.equal(saved.oldUnknown, 1);
});

test('a corrupt legacy file or pre-cancelled migration cannot write a success marker', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-im-corrupt-')));
  const directory = path.join(root, 'im'); await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'image_monitor_config.json'), '{broken');
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  try {
    await assert.rejects(host.load(createIm()));
    const current = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8').catch(() => '{}'));
    assert.notEqual(current.importedLegacy, true);
  } finally {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});}

  let updates = 0;
  const controller = new AbortController(); controller.abort();
  const context = {signal: controller.signal, files: {dataPath: name => path.join(directory, name)}, storage: {json: () => ({read: async () => ({...base, importedLegacy: false, schemaVersion: 1}), update: async () => {updates++;}})}};
  await assert.rejects(artifact.migrate(context), {name: 'AbortError'});
  assert.equal(updates, 0);
});

test('reply shortcuts preserve sticker IDs and stream media MD5 through the managed client', async t => {
  const sticker = new Api.Document({id: 888n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, mimeType: 'image/webp', size: 10n, dcId: 1,
    attributes: [new Api.DocumentAttributeSticker({alt: 'x', stickerset: new Api.InputStickerSetEmpty()})]});
  const f = await fixture(t, {reply: {...base, id: 2, replyToId: undefined, raw: {media: new Api.MessageMediaDocument({document: sticker})}}});
  await f.run('.im ban', {replyToId: 2});
  assert.match(f.edits.at(-1).text, /贴纸 ID：<code>888<\/code>，操作：<code>ban<\/code>/);
  f.setReply({...base, id: 3, raw: {media: new Api.MessageMediaPhoto({photo: new Api.Photo({id: 4n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1})})}});
  await f.run('.im delete', {replyToId: 3});
  assert.match(f.edits.at(-1).text, /78805a221a988e79ef3f42d7c5bfd418/);
});

test('matched sticker ban resolves and serializes the real RPC before deleting', async t => {
  const sticker = new Api.Document({id: 999n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, mimeType: 'image/webp', size: 1n, dcId: 1,
    attributes: [new Api.DocumentAttributeSticker({alt: 'x', stickerset: new Api.InputStickerSetEmpty()})]});
  const media = new Api.MessageMediaDocument({document: sticker});
  const f = await fixture(t, {reply: {...base, id: 2, raw: {media}}});
  await f.run('.im ban', {replyToId: 2});
  await f.run('.im addchat');
  await f.listen({senderId: '9', raw: {peerId: peer, media}});
  assert.equal(f.invokes.length, 1);
  const request = f.invokes[0];
  assert.ok(request instanceof Api.channels.EditBanned);
  await request.resolve(f.client, utils);
  assert.ok(request.getBytes().length > 0);
  assert.deepEqual(f.deletes[0].ids, [20]);
});

async function configureStickerBan(f, stickerId = 999n) {
  const sticker = new Api.Document({id: stickerId, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, mimeType: 'image/webp', size: 1n, dcId: 1,
    attributes: [new Api.DocumentAttributeSticker({alt: 'x', stickerset: new Api.InputStickerSetEmpty()})]});
  const media = new Api.MessageMediaDocument({document: sticker});
  f.setReply({...base, id: 2, raw: {media}});
  await f.run('.im ban', {replyToId: 2});
  await f.run('.im addchat');
  return media;
}

test('cancellation while resolving the channel prevents ban and delete', async t => {
  const f = await fixture(t);
  const media = await configureStickerBan(f, 1001n);
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => {enteredResolve = resolve;});
  const gate = new Promise(resolve => {releaseResolve = resolve;});
  f.client.getInputEntity = async () => {enteredResolve(); await gate; return new Api.InputPeerChannel({channelId: 55n, accessHash: 7n});};
  const pending = f.listen({senderId: '9', raw: {peerId: peer, media}});
  await entered;
  const unloading = f.host.unload('im', 1000);
  releaseResolve();
  assert.equal((await unloading).completed, true);
  await pending;
  assert.equal(f.invokes.length, 0);
  assert.equal(f.deletes.length, 0);
});

test('cancellation while ban RPC is in flight prevents the following delete', async t => {
  const f = await fixture(t);
  const media = await configureStickerBan(f, 1002n);
  let enteredBan, releaseBan;
  const entered = new Promise(resolve => {enteredBan = resolve;});
  const gate = new Promise(resolve => {releaseBan = resolve;});
  f.client.invoke = async request => {f.invokes.push(request); enteredBan(); await gate; return {};};
  const pending = f.listen({senderId: '9', raw: {peerId: peer, media}});
  await entered;
  const unloading = f.host.unload('im', 1000);
  releaseBan();
  assert.equal((await unloading).completed, true);
  await pending;
  assert.equal(f.invokes.length, 1);
  assert.equal(f.deletes.length, 0);
});

test('command failures and listener logs never expose native diagnostics', async t => {
  const secret = Object.assign(new Error('secret /Users/cat/private'), {code: 'TOKEN_SECRET'});
  const f = await fixture(t, {client: {async getEntity() {throw secret;}}});
  await f.run('.im addchat @bad');
  assert.doesNotMatch(f.edits.at(-1).text, /secret|Users|TOKEN/);
  assert.match(f.edits.at(-1).text, /无法解析群组 ID 或用户名/);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret|Users|TOKEN/);
});

test('unload stops a hanging media iterator, waits for cleanup, and performs no moderation', async t => {
  let nextStartedResolve, nextResolve, returnStartedResolve, releaseReturn;
  const nextStarted = new Promise(resolve => {nextStartedResolve = resolve;});
  const returnStarted = new Promise(resolve => {returnStartedResolve = resolve;});
  const returnGate = new Promise(resolve => {releaseReturn = resolve;});
  let downloadSignal;
  const iterator = {next() {nextStartedResolve(); return new Promise(resolve => {nextResolve = resolve;});}, return() {assert.equal(downloadSignal.aborted, true); returnStartedResolve(); return returnGate.then(() => {nextResolve({done: true}); return {done: true};});}};
  const photo = new Api.MessageMediaPhoto({photo: new Api.Photo({id: 4n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1})});
  const f = await fixture(t, {client: {iterDownload(_media, options) {downloadSignal = options.signal; return {[Symbol.asyncIterator]() {return iterator;}};}}});
  await f.run('.im addchat');
  const pending = f.listen({senderId: '9', raw: {peerId: peer, media: photo}});
  await nextStarted;
  assert.ok(downloadSignal instanceof AbortSignal);
  let finished = false;
  const unloading = f.host.unload('im', 1000).then(report => {finished = true; return report;});
  await returnStarted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseReturn();
  assert.equal((await unloading).completed, true);
  await pending;
  assert.equal(f.invokes.length, 0);
  assert.equal(f.deletes.length, 0);
});
