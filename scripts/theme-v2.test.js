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
  const edits = [], sends = [], invokes = [], logs = [];
  const client = {
    async getInputEntity(value) { return value; },
    async downloadMedia(_source, downloadOptions) { await fs.writeFile(downloadOptions.outputFile, input); return downloadOptions.outputFile; },
    async downloadFile(_source, downloadOptions) {
      const bytes = options.wallpaper ?? input; await fs.writeFile(downloadOptions.outputFile, bytes); return downloadOptions.outputFile;
    },
    async uploadFile(value) { if(options.uploadFile)return options.uploadFile(value,controller);return new Api.InputFile({id: 1n, parts: 1, name: 'theme.attheme', md5Checksum: ''}); },
    async invoke(request) {
      invokes.push(request);
      if (options.invoke) return options.invoke(request, client);
      if (request instanceof Api.account.CreateTheme) return {slug: 'telebox_created'};
      return {};
    },
    async sendFile(peer, sendOptions) {
      if(options.sendError?.(sends.length))throw new Error('PRIVATE_SEND');
      const buffer = await fs.readFile(sendOptions.file);
      assert.ok((await fs.stat(sendOptions.file)).isFile());
      sends.push({peer, options:sendOptions, buffer});
      options.onSent?.();
    },
  };
  const controller = new AbortController();
  const context = {signal: controller.signal, log: {info() {}, error(event,fields) {logs.push({event,fields});}}, telegram: {
    async edit(_message, text, settings) { await options.editWait?.(text);if(options.editError?.(text))throw new Error('PRIVATE_EDIT');edits.push({text, options:settings}); },
    async getReply() { return {id: 2, text: '', raw: {media: {document: {size: input.length, attributes: [
      {className: 'DocumentAttributeFilename', fileName: 'source.attheme'},
    ]}}}}; },
    async withClient(operation) { return operation(client, controller.signal); },
  }, files: {async withTemp(operation) {
    const directory = await fs.mkdtemp(path.join(root, 'temp-'));
    try { return await operation(directory, controller.signal); }
    finally { await fs.rm(directory, {recursive: true, force: true});if(options.cleanupError&&sends.length)throw new Error('PRIVATE_CLEANUP'); }
  }}};
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const plugin = create();
  const invocation = {command: 'theme', prefix: '.', args: [], message: {id: 1, chatId: '1', outgoing: true,
    replyToId: 2, text: '.theme', raw: {peerId: 'peer'}}};
  return {plugin, invocation, context, controller, client, edits, sends, invokes, logs};
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
  await link.handle({...f.invocation,args:['https://t.me/addtheme/mixedcaseslug'],subcommand:'link',subcommands:['link'],message:{...f.invocation.message,id:4}},f.context);
  const requests = f.invokes.filter(value => value instanceof Api.account.GetTheme);
  assert.equal(requests.length, 8);
  assert.deepEqual([...new Set(requests.map(request=>request.theme.slug))],['MixedCaseSlug','mixedcaseslug']);
  assert.equal(f.sends.length, 12);
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

test('theme keeps sent output when completion receipt or temp cleanup fails',async t=>{for(const options of [{editError:text=>text.includes('已完成')},{cleanupError:true}]){const f=await fixture(t,options);await f.plugin.commands.theme.subcommands.android.handle({...f.invocation,args:[],subcommand:'android',subcommands:['android']},f.context);assert.equal(f.sends.length,1);assert.equal(f.edits.some(x=>x.text.includes('主题转换失败')),false);assert.ok(f.logs.some(x=>/theme_(?:completion_receipt|temp_cleanup)_failed/.test(x.event)));assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE/);}});

test('theme cancellation after send propagates without a late completion edit',async t=>{const f=await fixture(t,{onSent(){f.controller.abort(new Error('stop'));}});await f.plugin.commands.theme.subcommands.android.handle({...f.invocation,args:[],subcommand:'android',subcommands:['android']},f.context);assert.equal(f.sends.length,1);assert.equal(f.edits.some(x=>x.text.includes('已完成')),false);assert.equal(f.edits.some(x=>x.text.includes('失败')),false);});

test('theme hides arbitrary conversion diagnostics behind fixed feedback and logs',async t=>{const secret='PRIVATE_THEME_SECRET',f=await fixture(t,{input:Buffer.from(secret)});await f.plugin.commands.theme.subcommands.android.handle({...f.invocation,args:[],subcommand:'android',subcommands:['android']},f.context);assert.deepEqual(f.logs,[{event:'theme_convert_failed',fields:undefined}]);assert.match(f.edits.at(-1).text,/主题转换失败，请检查文件格式后重试/);assert.doesNotMatch(JSON.stringify({edits:f.edits,logs:f.logs}),new RegExp(secret));});

test('theme upload cancellation starts no UploadMedia or CreateTheme side effect',async t=>{let started,release;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const f=await fixture(t,{async uploadFile(_value,controller){started();await gate;return new Api.InputFile({id:1n,parts:1,name:'x',md5Checksum:''});}});const running=f.plugin.commands.theme.subcommands.cloud.handle({...f.invocation,args:[],subcommand:'cloud',subcommands:['cloud']},f.context);await ready;f.controller.abort(new Error('cancel'));release();await running;assert.equal(f.invokes.some(x=>x instanceof Api.messages.UploadMedia||x instanceof Api.account.CreateTheme||x instanceof Api.account.UploadWallPaper),false);assert.equal(f.edits.some(x=>x.text.includes('失败')),false);});

test('theme publishes inflight before concurrent initial status edits settle',async t=>{let waiting=0,release;const gate=new Promise(r=>release=r);const f=await fixture(t,{editWait:async text=>{if(/正在(?:读取|复用)/.test(text)){waiting++;await gate;}},invoke:async request=>request instanceof Api.account.GetTheme?{settings:{baseTheme:new Api.BaseThemeDay(),accentColor:1}}:{}});const link=f.plugin.commands.theme.subcommands.link,a=link.handle({...f.invocation,args:['https://t.me/addtheme/RaceSlug'],subcommand:'link',subcommands:['link']},f.context),b=link.handle({...f.invocation,args:['https://t.me/addtheme/RaceSlug'],subcommand:'link',subcommands:['link'],message:{...f.invocation.message,id:8}},f.context);while(waiting<2)await new Promise(r=>setImmediate(r));release();await Promise.all([a,b]);assert.equal(f.invokes.filter(x=>x instanceof Api.account.GetTheme).length,4);});

test('theme reports partial link delivery without replacing sent formats',async t=>{const f=await fixture(t,{sendError:index=>index===1,invoke:async request=>request instanceof Api.account.GetTheme?{settings:{baseTheme:new Api.BaseThemeDay(),accentColor:1}}:{}});await f.plugin.commands.theme.subcommands.link.handle({...f.invocation,args:['https://t.me/addtheme/Partial'],subcommand:'link',subcommands:['link']},f.context);assert.equal(f.sends.length,1);assert.deepEqual(f.logs,[{event:'theme_link_partial_delivery_failed',fields:undefined}]);assert.match(f.edits.at(-1).text,/已发送 1 个格式/);});

test('cloud-settings backup failure preserves the created link',async t=>{const f=await fixture(t,{sendError:()=>true});await f.plugin.commands.theme.subcommands['cloud-settings'].handle({...f.invocation,args:[],subcommand:'cloud-settings',subcommands:['cloud-settings']},f.context);assert.ok(f.invokes.some(x=>x instanceof Api.account.CreateTheme));assert.deepEqual(f.logs,[{event:'theme_cloud_settings_backup_failed',fields:undefined}]);assert.match(f.edits.at(-1).text,/云端配色主题已创建[\s\S]*配色备份发送失败/);assert.equal(f.edits.some(x=>x.text==='云端配色创建失败，请稍后重试'),false);});

test('theme observes fetch rejection while initial edit is pending and permits retry',async t=>{let release,firstEdit=true,failFetch=true;const gate=new Promise(r=>release=r),unhandled=[];const listener=error=>unhandled.push(error);process.on('unhandledRejection',listener);t.after(()=>process.off('unhandledRejection',listener));const f=await fixture(t,{editWait:async text=>{if(firstEdit&&/正在读取/.test(text)){await gate;firstEdit=false;throw new Error('PRIVATE_EDIT');}},invoke:async request=>{if(request instanceof Api.account.GetTheme){if(failFetch)throw new Error('PRIVATE_FETCH');return{settings:{baseTheme:new Api.BaseThemeDay(),accentColor:1}};}return{};}}),link=f.plugin.commands.theme.subcommands.link;const first=link.handle({...f.invocation,args:['https://t.me/addtheme/RetrySlug'],subcommand:'link',subcommands:['link']},f.context);await new Promise(r=>setImmediate(r));release();await first;await new Promise(r=>setImmediate(r));assert.deepEqual(unhandled,[]);failFetch=false;await link.handle({...f.invocation,args:['https://t.me/addtheme/RetrySlug'],subcommand:'link',subcommands:['link'],message:{...f.invocation.message,id:11}},f.context);assert.equal(f.invokes.filter(x=>x instanceof Api.account.GetTheme).length,8);assert.equal(f.sends.length,4);});
