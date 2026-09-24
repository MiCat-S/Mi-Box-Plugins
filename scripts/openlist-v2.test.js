'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const packageRoot = process.env.OPENLIST_TEST_PACKAGE || path.resolve(__dirname, '../openlist');
const {artifactDir, manifest} = buildPlugin({id: 'openlist', packageRoot, entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function stateStore(initial = {}) {
  let value = {schemaVersion: 1, username: '', password: '', defaultPath: '', port: 5244, legacyImported: true, ...initial};
  return {
    json() { return {async read() { return structuredClone(value); }, async update(fn) { value = await fn(structuredClone(value)); return structuredClone(value); }}; },
    value: () => structuredClone(value),
  };
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-openlist-v2-')));
  const temporary = path.join(root, 'temp');
  await fs.mkdir(temporary);
  const store = stateStore(options.initial);
  const edits = [], processes = [], requests = [], logs = [];
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    log: {info(event, fields) {logs.push({level: 'info', event, fields});}, error(event, fields) {logs.push({level: 'error', event, fields});}},
    storage: store,
    files: {
      dataPath(name) { return path.join(root, name); },
      async dataDirectory(name) {const directory = path.join(root, name); await fs.mkdir(directory, {recursive: true}); return directory;},
      async withTemp(use) {
        const dir = await fs.mkdtemp(path.join(temporary, 'run-'));
        await options.beforeTempUse?.(dir);
        let value;
        try { value = await use(dir, controller.signal); }
        finally { await fs.rm(dir, {recursive: true, force: true}); }
        if (options.tempCleanupError) throw new Error(options.tempCleanupError);
        return value;
      },
    },
    processes: {async run(command, args, processOptions) {
      controller.signal.throwIfAborted();
      const call = {command, args: [...args], options: processOptions};
      processes.push(call);
      const result = await options.process?.(call, processes.length, controller);
      controller.signal.throwIfAborted();
      return result ?? {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};
    }},
    http: {async withResponse(url, init, consume, limits) {
      requests.push({url: String(url), init, limits});
      const response = await options.response?.(url, init) ?? new Response('invalid archive');
      return consume(response, controller.signal);
    }},
    telegram: {
      async edit(message, text, editOptions) {edits.push({message, text, options: editOptions}); await options.edit?.(edits.length, text);},
      async getReply() {return options.reply;}, async withClient(operation) {return operation(options.client ?? {}, controller.signal);},
    },
  };
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return {root, ctx, store, edits, processes, requests, logs, controller,
    command: async (args, extra = {}) => create(options.dependencies).commands.op.handle({
      message: {id: 1, chatId: '9007199254740993', senderId: '1', outgoing: true, saved: true, text: `.op ${args.join(' ')}`, ...extra},
      args, command: 'op', prefix: '<&',
    }, ctx)};
}

async function linux(t, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {value: 'linux'});
  try { return await operation(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}

test('candidate exposes one structured command tree, complete dynamic help and bounded resources', () => {
  const plugin = create();
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual(Object.keys(plugin.commands.op.subcommands), Object.keys(plugin.commands.openlist.subcommands));
  assert.equal(plugin.description.includes('v4.2.2'), true);
  assert.deepEqual(plugin.resources.processes, {concurrency: 1, queueCapacity: 4, timeoutMs: 120000, maxOutputBytes: 262144});
  const help = plugin.renderHelp('<&');
  for (const item of ['install', 'update', 'uninstall', 'status', 'backup', 'restore', 'setport', 'login', 'setdefault', 'save', 'admin setuser', 'v4.2.2', 'SHA-256']) assert.match(help, new RegExp(item));
  assert.match(help, /&lt;&amp;openlist/);
  assert.ok(manifest.imports.includes('node:crypto'));
});

test('credential-bearing commands alone require Saved Messages', async t => {
  const plugin = create();
  const root = plugin.commands.op;
  for (const command of ['install', 'update', 'uninstall', 'status', 'backup', 'restore', 'setport', 'save', 'setdefault']) {
    assert.equal(root.subcommands[command].authorize, undefined, command);
  }
  for (const command of [root.subcommands.login, root.subcommands.admin.subcommands.setpass, root.subcommands.admin.subcommands.random]) {
    const f = await fixture(t);
    const allowed = await command.authorize({message: {saved: false}}, f.ctx);
    assert.equal(allowed, false);
    assert.match(f.edits.at(-1).text, /收藏夹/);
    assert.doesNotMatch(f.edits.at(-1).text, /password|secret/i);
  }
  assert.equal(root.subcommands.admin.subcommands.setuser.authorize, undefined);
});

test('login and settings preserve spaced secrets without echoing them', async t => {
  const f = await fixture(t);
  await f.command(['login', 'alice', 's e c r e t']);
  assert.equal(f.store.value().username, 'alice');
  assert.equal(f.store.value().password, 's e c r e t');
  assert.equal(f.edits.some(edit => edit.text.includes('s e c r e t')), false);
  const settings = create().settings(f.ctx);
  assert.equal(settings.getSchema().find(item => item.key === 'password').secret, true);
  await settings.setValues({defaultPath: '/media/uploads', password: 'new secret'});
  assert.deepEqual(await settings.getValues(), {username: 'alice', password: 'new secret', defaultPath: '/media/uploads'});
});

test('setup imports legacy credentials once and initializes the managed port', async t => {
  const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
  await fs.writeFile(path.join(f.root, 'credentials.json'), JSON.stringify({username: 'legacy-user', password: 'legacy-secret', defaultPath: '/legacy'}));
  await create().setup(f.ctx);
  assert.deepEqual(f.store.value(), {schemaVersion: 1, username: 'legacy-user', password: 'legacy-secret', defaultPath: '/legacy', port: 5244, legacyImported: true});
  await fs.writeFile(path.join(f.root, 'credentials.json'), JSON.stringify({username: 'replace', password: 'replace'}));
  await create().setup(f.ctx);
  assert.equal(f.store.value().username, 'legacy-user');
});

test('malformed legacy credentials fail setup without marking migration complete', async t => {
  for (const body of ['{broken', 'null', '[]', '42', '"text"']) {
    const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
    await fs.writeFile(path.join(f.root, 'credentials.json'), body);
    await assert.rejects(create().setup(f.ctx), /旧凭据迁移失败/);
    assert.equal(f.store.value().legacyImported, false);
    assert.equal(f.store.value().port, undefined);
    assert.ok(f.logs.some(item => item.event === 'openlist_legacy_migration_failed'));
  }
});

test('cancelled legacy migration leaves state untouched', async t => {
  const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
  f.controller.abort();
  await assert.rejects(create().setup(f.ctx), {name: 'AbortError'});
  assert.equal(f.store.value().legacyImported, false);
  assert.equal(f.store.value().port, undefined);
});

test('unreadable legacy credential path is not treated as a fresh install', async t => {
  const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
  await fs.mkdir(path.join(f.root, 'credentials.json'));
  await assert.rejects(create().setup(f.ctx), /旧凭据迁移失败/);
  assert.equal(f.store.value().legacyImported, false);
});

test('legacy credential permission failure does not mark migration complete', async t => {
  const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
  const file = path.join(f.root, 'credentials.json');
  await fs.writeFile(file, JSON.stringify({username: 'hidden'}), {mode: 0o000});
  try {
    await assert.rejects(create().setup(f.ctx), /旧凭据迁移失败/);
    assert.equal(f.store.value().legacyImported, false);
  } finally {await fs.chmod(file, 0o600);}
});

test('a FIFO at the legacy credentials path is refused without blocking', async t => {
  const {execFileSync} = require('node:child_process');
  const f = await fixture(t, {initial: {legacyImported: false, port: undefined}});
  const fifo = path.join(f.root, 'credentials.json');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  // No writer is ever opened. A read that blocked on the FIFO would never
  // return, and an abort cannot interrupt a read already in flight, so the
  // plugin has to refuse the file rather than wait on it.
  await assert.rejects(create().setup(f.ctx), /旧凭据迁移失败/);
  assert.equal(f.store.value().legacyImported, false);
  assert.equal(f.store.value().port, undefined);
});

test('admin mutations use fixed argv, synchronize credentials and never echo passwords', async t => {
  const f = await fixture(t, {initial: {username: 'old-user', password: 'old-pass'}, process(call) {
    if (call.command === '/opt/openlist/openlist' && call.args.join(' ') === 'admin random') {
      return {stdout: Buffer.from('username: random-user\npassword: random-secret\n'), stderr: Buffer.alloc(0), exitCode: 0};
    }
  }});
  await f.command(['admin', 'setuser', 'new-user']);
  assert.equal(f.store.value().username, 'new-user');
  await f.command(['admin', 'setpass', 'new', 'secret']);
  assert.equal(f.store.value().password, 'new secret');
  await f.command(['admin', 'random']);
  assert.equal(f.store.value().username, 'random-user');
  assert.equal(f.store.value().password, 'random-secret');
  assert.deepEqual(f.processes.filter(call => call.command === '/opt/openlist/openlist').map(call => call.args), [
    ['admin', 'setuser', 'new-user'], ['admin', 'set', 'new secret'], ['admin', 'random'],
  ]);
  assert.equal(f.edits.some(edit => /new secret|random-secret/.test(edit.text)), false);
});

test('status reports the pinned version from a fixed managed process invocation', async t => {
  const f = await fixture(t, {process: call => {
    assert.equal(call.command, '/usr/bin/systemctl');
    assert.deepEqual(call.args, ['is-active', 'openlist']);
    return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
  }});
  await f.command(['status']);
  assert.equal(f.edits.at(-1).text, 'OpenList v4.2.2 服务运行中。');
});

test('a successful operation followed by receipt failure is not relabeled as an operation failure', async t => {
  const f = await fixture(t, {
    edit: async () => {throw new Error('private telegram transport');},
    process: () => ({stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0}),
  });
  await assert.rejects(f.command(['status']), /OPENLIST_RECEIPT_FAILED/);
  assert.equal(f.edits.length, 1);
  assert.ok(f.logs.some(item => item.event === 'openlist_receipt_failed'));
  assert.equal(f.logs.some(item => item.event === 'openlist_operation_failed'), false);
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('private telegram transport'), false);
});

test('local API abort actively cancels a hanging reader and waits for its cleanup', async t => {
  let reading, cancelStarted, releaseCancel;
  const readReady = new Promise(resolve => {reading = resolve;});
  const cancelReady = new Promise(resolve => {cancelStarted = resolve;});
  const gate = new Promise(resolve => {releaseCancel = resolve;});
  const f = await fixture(t, {
    initial: {username: 'alice', password: 'secret'},
    reply: {id: 2, raw: {media: {}, file: {name: 'sample.bin'}}},
    client: {async *iterDownload() {yield Buffer.from('media');}},
    response: async () => new Response(new ReadableStream({pull() {reading();}, async cancel() {cancelStarted(); await gate;}})),
  });
  let finished = false;
  const running = f.command(['save']).then(() => {finished = true;});
  await readReady;
  f.controller.abort();
  await cancelReady;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseCancel();
  await running;
  assert.equal(f.edits.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal((await fs.readdir(path.join(f.root, 'temp'))).length, 0);
});

test('save success survives temporary cleanup failure without a false operation error', async t => {
  let responses = 0;
  const f = await fixture(t, {
    initial: {username: 'alice', password: 'secret'}, tempCleanupError: 'private temp cleanup',
    reply: {id: 2, raw: {media: {}, file: {name: 'sample.bin'}}},
    client: {async *iterDownload() {yield Buffer.from('media');}},
    response: async () => Response.json(++responses === 1 ? {code: 200, data: {token: 'token'}} : {code: 200, data: null}),
  });
  await f.command(['save', '/uploads']);
  assert.match(f.edits.at(-1).text, /文件已上传到/);
  assert.doesNotMatch(f.edits.at(-1).text, /操作失败/);
  assert.ok(f.logs.some(item => item.event === 'openlist_temp_cleanup_failed' && item.fields.operation === 'save'));
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('private temp cleanup'), false);
});

test('install uses a verified staged binary, initializes credentials and never echoes the password', async t => linux(t, async () => {
  const f = await fixture(t, {
    dependencies: {
      async releaseBinary(_ctx, directory) { const binary = path.join(directory, 'verified-openlist'); await fs.writeFile(binary, 'verified'); return binary; },
      async ordinary() {return false;},
    },
    process(call) {
      if (call.command === '/opt/openlist/openlist') return {stdout: Buffer.from('username: admin\npassword: top-secret\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (call.args[0] === 'is-active') return {stdout: Buffer.from('inactive\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (call.args[0] === 'is-enabled') return {stdout: Buffer.from('disabled\n'), stderr: Buffer.alloc(0), exitCode: 0};
    },
  });
  await f.command(['install']);
  assert.match(f.edits.at(-1).text, /v4\.2\.2 安装完成/);
  assert.equal(f.store.value().username, 'admin');
  assert.equal(f.store.value().password, 'top-secret');
  assert.equal(JSON.stringify({edits: f.edits, logs: f.logs}).includes('top-secret'), false);
  assert.ok(f.processes.some(call => call.command === '/usr/bin/install' && call.args.includes('0755') && call.args.at(-1) === '/opt/openlist/openlist'));
  assert.ok(f.processes.some(call => call.command === '/usr/bin/install' && call.args.includes('0644') && call.args.at(-1) === '/etc/systemd/system/openlist.service'));
  assert.ok(f.processes.some(call => call.command === '/usr/bin/systemctl' && call.args.join(' ') === 'enable --now openlist'));
  assert.ok(f.processes.some(call => call.command === '/bin/rm' && call.args[0] === '-rf' && call.args[1].includes('/recovery/')));
}));

test('install success survives temporary cleanup failure without a false failure receipt', async t => linux(t, async () => {
  const f = await fixture(t, {
    tempCleanupError: 'private install temp cleanup',
    dependencies: {
      async releaseBinary(_ctx, directory) {const binary = path.join(directory, 'verified'); await fs.writeFile(binary, 'verified'); return binary;},
      async ordinary() {return false;},
    },
    process(call) {
      if (call.command === '/opt/openlist/openlist') return {stdout: Buffer.from('username: admin\npassword: secret\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (call.args[0] === 'is-active') return {stdout: Buffer.from('inactive\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (call.args[0] === 'is-enabled') return {stdout: Buffer.from('disabled\n'), stderr: Buffer.alloc(0), exitCode: 0};
    },
  });
  await f.command(['install']);
  assert.match(f.edits.at(-1).text, /v4\.2\.2 安装完成/);
  assert.doesNotMatch(f.edits.at(-1).text, /操作失败/);
  assert.ok(f.logs.some(item => item.event === 'openlist_temp_cleanup_failed' && item.fields.operation === 'install'));
}));

test('built-in release rejects untrusted bytes before tar extraction', async t => linux(t, async () => {
  const f = await fixture(t, {dependencies: {async ordinary() {return false;}}});
  await f.command(['install']);
  assert.match(f.edits.at(-1).text, /SHA-256 校验失败/);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /releases\/download\/v4\.2\.2\/openlist-linux-musl-arm64\.tar\.gz$/);
  assert.equal(f.processes.some(call => call.command === '/usr/bin/tar'), false);
}));

test('release open failure still cancels and unlocks the acquired response reader', async t => linux(t, async () => {
  let response, canceled = 0;
  const f = await fixture(t, {
    dependencies: {async ordinary() {return false;}},
    beforeTempUse: async directory => fs.writeFile(path.join(directory, 'openlist-linux-musl-arm64.tar.gz'), 'collision'),
    response: async () => response = new Response(new ReadableStream({start(controller) {controller.enqueue(Buffer.from('archive'));}, cancel() {canceled += 1;}})),
  });
  await f.command(['install']);
  assert.equal(canceled, 1);
  assert.equal(response.body.locked, false);
  assert.equal(f.processes.length, 0);
}));

test('release download abort actively cancels a hanging reader and awaits cleanup', async t => linux(t, async () => {
  let reading, cancelStarted, releaseCancel;
  const readReady = new Promise(resolve => {reading = resolve;});
  const cancelReady = new Promise(resolve => {cancelStarted = resolve;});
  const gate = new Promise(resolve => {releaseCancel = resolve;});
  const f = await fixture(t, {
    dependencies: {async ordinary() {return false;}},
    response: async () => new Response(new ReadableStream({pull() {reading();}, async cancel() {cancelStarted(); await gate;}})),
  });
  let finished = false;
  const running = f.command(['install']).then(() => {finished = true;});
  await readReady;
  f.controller.abort();
  await cancelReady;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseCancel();
  await running;
  assert.equal(f.processes.length, 0);
  assert.equal(f.edits.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'recovery')), {code: 'ENOENT'});
}));

test('failed update restores binary, service and data snapshots with the prior service state', async t => linux(t, async () => {
  const f = await fixture(t, {
    dependencies: {
      async releaseBinary(_ctx, directory) { const binary = path.join(directory, 'verified-openlist'); await fs.writeFile(binary, 'verified'); return binary; },
      async ordinary(target) {return ['/opt/openlist/openlist', '/etc/systemd/system/openlist.service', '/opt/openlist/data'].includes(target);},
    },
    process(call) {
      const joined = call.args.join(' ');
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'is-enabled openlist') return {stdout: Buffer.from('enabled\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'enable --now openlist') throw new Error('private process output');
    },
  });
  await f.command(['update']);
  assert.match(f.edits.at(-1).text, /OpenList 操作失败/);
  assert.equal(JSON.stringify({edits: f.edits, logs: f.logs}).includes('private process output'), false);
  const commands = f.processes.map(call => `${call.command} ${call.args.join(' ')}`);
  assert.ok(commands.some(value => /disable --now openlist$/.test(value)));
  assert.ok(commands.some(value => /install -m 0755 .*openlist\.previous \/opt\/openlist\/openlist$/.test(value)));
  assert.ok(commands.some(value => /install -m 0644 .*openlist\.service\.previous \/etc\/systemd\/system\/openlist\.service$/.test(value)));
  assert.ok(commands.some(value => /rm -rf \/opt\/openlist\/data$/.test(value)));
  assert.ok(commands.some(value => /cp -a .*data\.previous \/opt\/openlist\/data$/.test(value)));
  assert.ok(commands.some(value => /enable openlist$/.test(value)));
  assert.ok(commands.some(value => /start openlist$/.test(value)));
}));

test('rollback failure retains persistent binary, service and data snapshots', async t => linux(t, async () => {
  let failedInstall = false;
  const f = await fixture(t, {
    dependencies: {
      async releaseBinary(_ctx, directory) {const binary = path.join(directory, 'verified'); await fs.writeFile(binary, 'new'); return binary;},
      async ordinary(target) {return ['/opt/openlist/openlist', '/etc/systemd/system/openlist.service', '/opt/openlist/data'].includes(target);},
    },
    async process(call) {
      const joined = call.args.join(' ');
      if (call.command === '/bin/cp' && call.args[2]?.includes('/recovery/')) {
        if (call.args[1] === '/opt/openlist/data') {await fs.mkdir(call.args[2], {recursive: true}); await fs.writeFile(path.join(call.args[2], 'marker'), 'old-data');}
        else {await fs.mkdir(path.dirname(call.args[2]), {recursive: true}); await fs.writeFile(call.args[2], call.args[1].includes('service') ? 'old-service' : 'old-bin');}
      }
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'is-enabled openlist') return {stdout: Buffer.from('enabled\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'enable --now openlist') throw new Error('OpenList 初始账号信息未能读取；sk-activation-secret');
      if (!failedInstall && call.command === '/usr/bin/install' && call.args[2]?.includes('/recovery/')) {failedInstall = true; throw new Error('sk-rollback-secret');}
    },
  });
  await f.command(['update']);
  assert.match(f.edits.at(-1).text, /OpenList 操作失败/);
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('sk-'), false);
  assert.ok(f.logs.some(item => item.event === 'openlist_recovery_snapshot_retained'));
  const batches = await fs.readdir(path.join(f.root, 'recovery'));
  assert.equal(batches.length, 1);
  const recovery = path.join(f.root, 'recovery', batches[0]);
  assert.equal(await fs.readFile(path.join(recovery, 'openlist.previous'), 'utf8'), 'old-bin');
  assert.equal(await fs.readFile(path.join(recovery, 'openlist.service.previous'), 'utf8'), 'old-service');
  assert.equal(await fs.readFile(path.join(recovery, 'data.previous/marker'), 'utf8'), 'old-data');
}));

test('mid-update cancellation retains snapshots and does not bypass SDK cancellation for rollback', async t => linux(t, async () => {
  const f = await fixture(t, {
    dependencies: {
      async releaseBinary(_ctx, directory) {const binary = path.join(directory, 'verified'); await fs.writeFile(binary, 'new'); return binary;},
      async ordinary(target) {return ['/opt/openlist/openlist', '/etc/systemd/system/openlist.service', '/opt/openlist/data'].includes(target);},
    },
    async process(call, _count, controller) {
      const joined = call.args.join(' ');
      if (call.command === '/bin/cp' && call.args[2]?.includes('/recovery/')) {
        if (call.args[1] === '/opt/openlist/data') {await fs.mkdir(call.args[2], {recursive: true}); await fs.writeFile(path.join(call.args[2], 'marker'), 'old-data');}
        else {await fs.mkdir(path.dirname(call.args[2]), {recursive: true}); await fs.writeFile(call.args[2], 'snapshot');}
      }
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'is-enabled openlist') return {stdout: Buffer.from('enabled\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'stop openlist') controller.abort();
    },
  });
  await f.command(['update']);
  assert.equal(f.edits.length, 0);
  const batches = await fs.readdir(path.join(f.root, 'recovery'));
  assert.equal(batches.length, 1);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'recovery', batches[0]))).sort(), ['data.previous', 'openlist.previous', 'openlist.service.previous']);
  assert.equal(f.processes.filter(call => call.args.join(' ') === 'stop openlist').length, 1, 'rollback process calls are rejected by the cancelled SDK scope');
}));

test('uninstall disables the service and removes only the unit file while preserving data', async t => {
  const f = await fixture(t);
  await f.command(['uninstall']);
  assert.match(f.edits.at(-1).text, /数据目录保留/);
  assert.ok(f.processes.some(call => call.command === '/usr/bin/systemctl' && call.args.join(' ') === 'disable --now openlist'));
  assert.ok(f.processes.some(call => call.command === '/bin/rm' && call.args.join(' ') === '-f /etc/systemd/system/openlist.service'));
  assert.ok(f.processes.some(call => call.command === '/usr/bin/systemctl' && call.args.join(' ') === 'daemon-reload'));
  assert.equal(f.processes.some(call => call.args.includes('/opt/openlist/data')), false);
});

test('backup uses a validated millisecond name and removes a partial directory on copy failure', async t => {
  const f = await fixture(t, {process(call) {
    if (call.command === '/bin/date') return {stdout: Buffer.from('20260913_182233_007\n'), stderr: Buffer.alloc(0), exitCode: 0};
    if (call.command === '/bin/cp') throw new Error('copy failed');
  }});
  await f.command(['backup']);
  assert.match(f.edits.at(-1).text, /OpenList 操作失败/);
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('copy failed'), false);
  assert.ok(f.processes.some(call => call.command === '/bin/rm' && call.args.join(' ') === '-rf /opt/openlist_backups/backup_20260913_182233_007'));
});

test('setport updates a real temporary config and persists the API port only after restart', async t => {
  const config = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-config-')), 'config.json');
  t.after(() => fs.rm(path.dirname(config), {recursive: true, force: true}));
  await fs.writeFile(config, JSON.stringify({scheme: {http_port: 5244}, keep: true}));
  const f = await fixture(t, {
    dependencies: {configPath: config, async ordinary(target, kind) {
      try {const info = await fs.lstat(target); return kind === 'file' ? info.isFile() : info.isDirectory();} catch {return false;}
    }},
    async process(call) {
      if (call.command === '/bin/cp') {await fs.copyFile(call.args[1], call.args[2]); return;}
      if (call.command === '/usr/bin/install') {await fs.copyFile(call.args.at(-2), call.args.at(-1)); await fs.chmod(call.args.at(-1), 0o600); return;}
      if (call.args.join(' ') === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
    },
  });
  await f.command(['setport', '6262']);
  assert.match(f.edits.at(-1).text, /6262/);
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).scheme.http_port, 6262);
  assert.equal(f.store.value().port, 6262);
  assert.ok(f.processes.some(call => call.args.join(' ') === 'stop openlist'));
  assert.ok(f.processes.some(call => call.args.join(' ') === 'start openlist'));
});

test('setport success survives temporary cleanup failure and keeps the committed port', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-port-cleanup-')), config = path.join(directory, 'config.json');
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await fs.writeFile(config, JSON.stringify({scheme: {http_port: 5244}}));
  const f = await fixture(t, {
    tempCleanupError: 'private setport temp cleanup',
    dependencies: {configPath: config, async ordinary() {return true;}},
    async process(call) {
      if (call.command === '/bin/cp') {await fs.copyFile(call.args[1], call.args[2]); return;}
      if (call.command === '/usr/bin/install') {await fs.copyFile(call.args.at(-2), call.args.at(-1)); return;}
      if (call.args.join(' ') === 'is-active openlist') return {stdout: Buffer.from('inactive\n'), stderr: Buffer.alloc(0), exitCode: 0};
    },
  });
  await f.command(['setport', '6262']);
  assert.match(f.edits.at(-1).text, /6262/);
  assert.doesNotMatch(f.edits.at(-1).text, /操作失败/);
  assert.equal(f.store.value().port, 6262);
  assert.ok(f.logs.some(item => item.event === 'openlist_temp_cleanup_failed' && item.fields.operation === 'setport'));
});

test('setport rollback failure retains its persistent config snapshot without committing the port', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-port-rollback-')), config = path.join(directory, 'config.json');
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const original = JSON.stringify({scheme: {http_port: 5244}, marker: 'old'});
  await fs.writeFile(config, original);
  let startCalls = 0;
  const f = await fixture(t, {
    dependencies: {configPath: config, async ordinary() {return true;}},
    async process(call) {
      const joined = call.args.join(' ');
      if (call.command === '/bin/cp') {
        if (call.args[1].includes('/recovery/')) throw new Error('sk-config-rollback-secret');
        await fs.copyFile(call.args[1], call.args[2]); return;
      }
      if (call.command === '/usr/bin/install') {await fs.copyFile(call.args.at(-2), call.args.at(-1)); return;}
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'start openlist' && ++startCalls === 1) throw new Error('OpenList 初始账号信息未能读取；sk-port-start-secret');
    },
  });
  await f.command(['setport', '6262']);
  assert.match(f.edits.at(-1).text, /OpenList 操作失败/);
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('sk-'), false);
  assert.equal(f.store.value().port, 5244);
  const batches = await fs.readdir(path.join(f.root, 'recovery'));
  assert.equal(batches.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'recovery', batches[0], 'config.previous.json'), 'utf8'), original);
});

test('setport cancellation after stop retains config snapshot and performs no post-cancel mutation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-port-cancel-')), config = path.join(directory, 'config.json');
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const original = JSON.stringify({scheme: {http_port: 5244}, marker: 'old'});
  await fs.writeFile(config, original);
  const f = await fixture(t, {
    dependencies: {configPath: config, async ordinary() {return true;}},
    async process(call, _count, controller) {
      const joined = call.args.join(' ');
      if (call.command === '/bin/cp') {await fs.copyFile(call.args[1], call.args[2]); return;}
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'stop openlist') controller.abort();
    },
  });
  await f.command(['setport', '6262']);
  assert.equal(f.edits.length, 0);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.equal(f.store.value().port, 5244);
  const batches = await fs.readdir(path.join(f.root, 'recovery'));
  assert.equal(batches.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'recovery', batches[0], 'config.previous.json'), 'utf8'), original);
  assert.equal(f.processes.filter(call => call.args.join(' ') === 'stop openlist').length, 1);
});

test('restore failure atomically puts the old data directory back and restarts prior active service', async t => {
  let startCalls = 0;
  const f = await fixture(t, {
    dependencies: {async ordinary(target) {
      return target === '/opt/openlist_backups/backup_20260913_182233_007/data' ||
        target === '/opt/openlist/data' || target.includes('/data.mibot-stage-');
    }},
    process(call) {
      const joined = call.args.join(' ');
      if (joined === 'is-active openlist') return {stdout: Buffer.from('active\n'), stderr: Buffer.alloc(0), exitCode: 0};
      if (joined === 'start openlist' && ++startCalls === 1) throw new Error('private restore failure');
    },
  });
  await f.command(['restore', 'backup_20260913_182233_007']);
  assert.match(f.edits.at(-1).text, /OpenList 操作失败/);
  assert.equal(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}).includes('private restore failure'), false);
  const commands = f.processes.map(call => `${call.command} ${call.args.join(' ')}`);
  assert.equal(commands.filter(value => /systemctl stop openlist$/.test(value)).length, 2);
  assert.ok(commands.some(value => /rm -rf \/opt\/openlist\/data$/.test(value)));
  assert.ok(commands.some(value => /mv \/opt\/openlist\/data\.mibot-rollback-.* \/opt\/openlist\/data$/.test(value)));
  assert.equal(commands.filter(value => /systemctl start openlist$/.test(value)).length, 2);
});

test('parameter validation and full subcommand help perform no process or HTTP side effects', async t => {
  const f = await fixture(t);
  for (const [args, expected] of [
    [['restore', '../secret'], /有效的 OpenList 备份名/],
    [['setport', '70000'], /1 到 65535/],
    [['admin', 'setpass'], /缺少新凭据/],
    [['save'], /请回复媒体文件/],
  ]) { await f.command(args); assert.match(f.edits.at(-1).text, expected); }
  await f.command(['help']);
  assert.match(f.edits.at(-1).text, /v4\.2\.2/);
  assert.equal(f.processes.length + f.requests.length, 0);
});
