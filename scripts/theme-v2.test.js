'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const sharp = require(path.join(core, 'node_modules/sharp'));
const {artifactDir} = buildPlugin({id: 'theme', packageRoot: path.resolve(__dirname, '../theme'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function emptyZip(count) {
  const locals = [], centrals = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const name = Buffer.from(index === 0 ? 'colors.tdesktop-theme' : `entry-${index}`);
    const data = index === 0 ? Buffer.from('windowBg: #FFFFFF;\n') : Buffer.alloc(0);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); data.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-theme-v2-')));
  const input = options.input ?? Buffer.from('windowBackgroundWhite=#ffffff\nwindowTextBlack=#000000\nactionBarDefault=#112233\n');
  const edits = [], sends = [], invokes = [];
  const client = {
    async getInputEntity(value) { return value; },
    async downloadMedia(_source, downloadOptions) { await fs.writeFile(downloadOptions.outputFile, input); return downloadOptions.outputFile; },
    async downloadFile(_source, downloadOptions) {
      const bytes = options.wallpaper ?? input; await fs.writeFile(downloadOptions.outputFile, bytes); return downloadOptions.outputFile;
    },
    async uploadFile() { return new Api.InputFile({id: 1n, parts: 1, name: 'theme.attheme', md5Checksum: ''}); },
    async invoke(request) {
      invokes.push(request);
      if (options.invoke) return options.invoke(request, client);
      if (request instanceof Api.account.CreateTheme) return {slug: 'telebox_created'};
      return {};
    },
    async sendFile(peer, options) {
      const buffer = await fs.readFile(options.file);
      assert.ok((await fs.stat(options.file)).isFile());
      sends.push({peer, options, buffer});
    },
  };
  const controller = new AbortController();
  const context = {signal: controller.signal, log: {info() {}, error() {}}, telegram: {
    async edit(_message, text, options) { edits.push({text, options}); },
    async getReply() { return {id: 2, text: '', raw: {media: {document: {size: input.length, attributes: [
      {className: 'DocumentAttributeFilename', fileName: 'source.attheme'},
    ]}}}}; },
    async withClient(operation) { return operation(client, controller.signal); },
  }, files: {async withTemp(operation) {
    const directory = await fs.mkdtemp(path.join(root, 'temp-'));
    try { return await operation(directory, controller.signal); }
    finally { await fs.rm(directory, {recursive: true, force: true}); }
  }}};
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const plugin = create();
  const invocation = {command: 'theme', prefix: '.', args: [], message: {id: 1, chatId: '1', outgoing: true,
    replyToId: 2, text: '.theme', raw: {peerId: 'peer'}}};
  return {plugin, invocation, context, client, edits, sends, invokes};
}

test('theme is explicit-command only and renders all four supported client formats with scoped files', async t => {
  const f = await fixture(t);
  assert.equal(f.plugin.apiVersion, 2);
  assert.equal(f.plugin.listeners, undefined);
  assert.deepEqual(Object.keys(f.plugin.commands.theme.subcommands).sort(), ['android', 'clients', 'cloud', 'cloud-settings', 'desktop', 'ios', 'link', 'tgx']);
  for (const target of ['android', 'desktop', 'tgx', 'ios']) {
    await f.plugin.commands.theme.subcommands[target].handle({...f.invocation, args: [], subcommand: target, subcommands: [target]}, f.context);
  }
  assert.equal(f.sends.length, 4);
  assert.match(f.sends[0].buffer.toString('utf8'), /windowBackgroundWhite/);
  assert.match(f.sends[1].buffer.toString('utf8'), /windowBg|windowBackgroundWhite/);
  assert.match(f.sends[2].buffer.toString('utf8'), /^!/);
  assert.match(f.sends[3].buffer.toString('utf8'), /^(?:name|basedOn):/);
  for (const sent of f.sends) await assert.rejects(fs.stat(sent.options.file), {code: 'ENOENT'});
});

test('theme preserves mixed-case slugs and shares only fetch data across concurrent callers', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let themeCalls = 0;
  const f = await fixture(t, {async invoke(request) {
    if (request instanceof Api.account.GetTheme) {
      themeCalls += 1; if (themeCalls === 1) await gate;
      return {settings: {baseTheme: new Api.BaseThemeDay(), accentColor: 0x2481cc, outboxAccentColor: 0x2481cc,
        messageColors: [0x2481cc]}};
    }
    return {};
  }});
  const link = f.plugin.commands.theme.subcommands.link;
  const first = link.handle({...f.invocation, args: ['https://t.me/addtheme/MixedCaseSlug'], subcommand: 'link', subcommands: ['link']}, f.context);
  while (!themeCalls) await new Promise(resolve => setImmediate(resolve));
  const second = link.handle({...f.invocation, args: ['https://t.me/addtheme/MixedCaseSlug'], subcommand: 'link', subcommands: ['link'],
    message: {...f.invocation.message, id: 3}}, f.context);
  release(); await Promise.all([first, second]);
  const requests = f.invokes.filter(value => value instanceof Api.account.GetTheme);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.theme.slug === 'MixedCaseSlug'));
  assert.equal(f.sends.length, 8);
  assert.equal(f.edits.filter(value => /已处理：MixedCaseSlug/.test(value.text)).length, 2);
});

test('theme resolves slug-only wallpaper once and embeds it in Android output', async t => {
  const wallpaper = await sharp({create: {width: 8, height: 8, channels: 3, background: '#123456'}}).png().toBuffer();
  const input = Buffer.from('name: Slug Theme\nbasedOn: day\nlist:\n  plainBg: ffffff\n  primaryText: 000000\nchat:\n  defaultWallpaper: MixedWallpaperSlug blur: 0 motion: true\n');
  const document = {id: 9n, accessHash: 10n, fileReference: Buffer.from('ref'), size: wallpaper.length, dcId: 2};
  const f = await fixture(t, {input, wallpaper, async invoke(request) {
    if (request instanceof Api.account.GetWallPaper) return {slug: 'MixedWallpaperSlug', document};
    return {};
  }});
  const android = f.plugin.commands.theme.subcommands.android;
  await android.handle({...f.invocation, args: [], subcommand: 'android', subcommands: ['android']}, f.context);
  await android.handle({...f.invocation, args: [], subcommand: 'android', subcommands: ['android']}, f.context);
  const requests = f.invokes.filter(value => value instanceof Api.account.GetWallPaper);
  assert.equal(requests.length, 1);
  await requests[0].resolve(f.client, Utils);
  assert.ok(requests[0].getBytes().length > 0);
  assert.ok(f.sends.every(value => value.buffer.includes(wallpaper)));
});

test('theme cloud document bridge produces resolvable UploadMedia and CreateTheme requests', async t => {
  const f = await fixture(t, {async invoke(request) {
    if (request instanceof Api.messages.UploadMedia) return {document: {id: 3n, accessHash: 4n, fileReference: Buffer.from('ref')}};
    if (request instanceof Api.account.CreateTheme) return {slug: 'document_theme'};
    return {};
  }});
  await f.plugin.commands.theme.subcommands.cloud.handle({...f.invocation, args: [], subcommand: 'cloud', subcommands: ['cloud']}, f.context);
  const upload = f.invokes.find(value => value instanceof Api.messages.UploadMedia);
  const createRequest = f.invokes.find(value => value instanceof Api.account.CreateTheme);
  assert.ok(upload); assert.ok(createRequest);
  await upload.resolve(f.client, Utils); await createRequest.resolve(f.client, Utils);
  assert.ok(upload.getBytes().length > 0); assert.ok(createRequest.getBytes().length > 0);
});

test('theme cloud-settings builds a real resolvable and serializable CreateTheme request', async t => {
  const f = await fixture(t);
  await f.plugin.commands.theme.subcommands['cloud-settings'].handle({...f.invocation, args: [], subcommand: 'cloud-settings',
    subcommands: ['cloud-settings']}, f.context);
  const request = f.invokes.find(value => value instanceof Api.account.CreateTheme);
  assert.ok(request);
  await request.resolve(f.client, Utils);
  assert.ok(request.settings[0] instanceof Api.InputThemeSettings);
  assert.ok(request.getBytes().length > 0);
  assert.match(f.edits.at(-1).text, /telebox_created/);
});

test('theme rejects archives above the 64-entry expansion budget', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-theme-converter-'));
  const output = path.join(root, 'converter.cjs');
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  esbuild.buildSync({entryPoints: [path.resolve(__dirname, '../theme/v2/converter.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output});
  const converter = require(output);
  assert.ok(converter.parseThemeBuffer(emptyZip(64), 'tdesktop-theme'));
  assert.equal(converter.parseThemeBuffer(emptyZip(65), 'tdesktop-theme'), null);
});
