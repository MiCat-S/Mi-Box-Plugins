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

test('convert rejects a declared input above 512 MiB before download and helper execution', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-bounds-')); t.after(() => fs.rm(root, {recursive: true, force: true}));
  const signal = new AbortController().signal, edits = []; let downloaded = false, processed = false;
  const source = {media: {document: {}}, document: {size: 513n * 1024n * 1024n, mimeType: 'video/mp4'}};
  const context = {
    signal,
    log: {error() {}},
    storage: {json: () => ({async read() {return {schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true};}, async update(operation) {return operation({schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true});}})},
    services: {available() {return false;}},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    processes: {async run() {processed = true; throw new Error('unexpected process');}},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, chatId: '1', outgoing: false, text: '', raw: source};}, async withClient(operation) {return operation({async *iterDownload() {downloaded = true; yield Buffer.from('x');}}, signal);}},
  };
  await create().commands.convert.handle({command: 'convert', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.convert', raw: {peerId: '1'}}}, context);
  assert.equal(downloaded, false);
  assert.equal(processed, false);
  assert.match(edits.at(-1), /转换失败/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('convert bounds helper files and runs local-only helpers inside the temp directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-process-')); t.after(() => fs.rm(root, {recursive: true, force: true}));
  const signal = new AbortController().signal, edits = [], calls = []; let sent = 0;
  const source = {media: {document: {}}, document: {size: 4n, mimeType: 'video/mp4', attributes: [{fileName: 'input.mp4'}]}};
  const context = {signal, log: {error() {}},
    storage: {json: () => ({async read() {return {schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true};}, async update(operation) {return operation({schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true});}})},
    services: {available() {return false;}},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    processes: {async run(command, args, options) {calls.push({command, args: [...args], options}); if (command.includes('ffprobe')) return {stdout: Buffer.from('1'), stderr: Buffer.alloc(0), exitCode: 0}; await fs.writeFile(args.at(-1), Buffer.from('mp3')); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, chatId: '1', outgoing: false, text: '', raw: source};}, async withClient(operation) {return operation({async *iterDownload() {yield Buffer.from('data');}, async sendFile() {sent++;}}, signal);}},
  };
  await create().commands.convert.handle({command: 'convert', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.convert', raw: {peerId: '1'}}}, context);
  assert.equal(sent, 1);
  const encode = calls.find(call => call.command.includes('ffmpeg'));
  assert.ok(encode);
  assert.deepEqual(encode.args.slice(2, 4), ['-protocol_whitelist', 'file']);
  assert.equal(encode.args[encode.args.indexOf('-fs') + 1], String(512 * 1024 * 1024));
  assert.ok(encode.options.cwd.startsWith(root));
  assert.equal(encode.options.signal, signal);
  assert.ok(calls.find(call => call.command.includes('ffprobe')).args.includes('file'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('convert rejects a sparse helper output above 512 MiB without sending it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-output-')); t.after(() => fs.rm(root, {recursive: true, force: true}));
  const signal = new AbortController().signal, edits = []; let sent = false;
  const source = {media: {document: {}}, document: {size: 4n, mimeType: 'video/mp4', attributes: []}};
  const context = {signal, log: {error() {}}, storage: {json: () => ({async read() {return {schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true};}, async update(value) {return value({schemaVersion: 1, apiKey: '', legacyImported: true, aiMigrated: true});}})}, services: {available() {return false;}},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    processes: {async run(command, args) {assert.ok(args.includes('-fs')); await fs.writeFile(args.at(-1), Buffer.alloc(1)); await fs.truncate(args.at(-1), 512 * 1024 * 1024 + 1); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, raw: source};}, async withClient(operation) {return operation({async *iterDownload() {yield Buffer.from('data');}, async sendFile() {sent = true;}}, signal);}}};
  await create().commands.convert.handle({command: 'convert', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.convert', raw: {peerId: '1'}}}, context);
  assert.equal(sent, false);
  assert.match(edits.at(-1), /转换失败/);
  assert.deepEqual(await fs.readdir(root), []);
});
