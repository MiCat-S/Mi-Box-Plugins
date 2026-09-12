'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'convert', packageRoot: path.resolve(__dirname, '../convert'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('convert unlocks cover responses and keeps internal process failures private', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-http-')); t.after(() => fs.rm(root, {recursive: true, force: true}));
  const signal = new AbortController().signal, edits = [], calls = []; let responseBody;
  const source = {media: {document: {}}, document: {size: 4n, mimeType: 'video/mp4', attributes: [{fileName: 'input.mp4'}]}};
  const state = {schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true};
  const context = {signal, log: {error() {}}, storage: {json: () => ({async read() {return state;}, async update(operation) {return operation(state);}})},
    services: {available(plugin, service) {return plugin === 'ai' && service === 'search';}, async call() {return {text: '歌曲名：测试\n歌手：测试者\n专辑：测试'};}},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    http: {async json() {return {results: [{artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg'}]};}, async withResponse(url, init, consume) {responseBody = new ReadableStream({start(controller) {controller.enqueue(Buffer.from('cover')); controller.close();}}); return consume(new Response(responseBody, {status: 200}), signal);}},
    processes: {async run(command, args, options) {calls.push({command, args: [...args], options}); if (command.includes('ffprobe')) return {stdout: Buffer.from('1'), stderr: Buffer.alloc(0), exitCode: 0}; if (calls.filter(call => call.command.includes('ffmpeg')).length === 2) throw new Error(`/private/secret/${path.basename(args.at(-1))}`); await fs.writeFile(args.at(-1), Buffer.from('mp3')); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, raw: source};}, async withClient(operation) {return operation({async *iterDownload() {yield Buffer.from('data');}, async sendFile() {}}, signal);}}};
  const subcommand = create().commands.convert.subcommands.u;
  await subcommand.handle({command: 'convert', subcommand: 'u', subcommands: ['u'], prefix: '.', args: ['测试'], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.convert u 测试', raw: {peerId: '1'}}}, context);
  assert.equal(responseBody.locked, false);
  assert.match(edits.at(-1), /转换失败，请确认回复的是视频/);
  assert.doesNotMatch(edits.at(-1), /private|secret/);
  assert.ok(calls.filter(call => call.command.includes('ffmpeg')).every(call => call.args.includes('-fs') && call.options.cwd.startsWith(root)));
  assert.deepEqual(await fs.readdir(root), []);
});
