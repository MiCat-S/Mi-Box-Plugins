"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const built = buildPlugin({ id: "speedlink", packageRoot: path.resolve(__dirname, "../speedlink"), entry: "v2.ts" }),
  entry = path.join(built.artifactDir, "index.cjs"),
  { downloadImage } = require(entry);
const create = () => {
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
};
const fingerprint = "SHA256:AbCdEf0123456789+/AbCdEf0123456789abc=";
const servers = [
  { name: "one", username: "ubuntu", host: "203.0.113.1", port: 22, fingerprint },
  { name: "two", username: "root", host: "203.0.113.2", port: 2222, fingerprint },
];
const result = name =>
  Buffer.from(
    JSON.stringify({
      server: { id: name, name, location: "lab" },
      isp: "ISP",
      ping: { latency: 10 },
      download: { bandwidth: 12500000 },
      upload: { bandwidth: 6250000 },
    }),
  );
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-speedlink-"))),
    edits = [],
    replies = [],
    calls = [],
    logs = [];
  let state = {
    schemaVersion: 1,
    timeoutSeconds: 45,
    servers: structuredClone(options.servers ?? servers),
    legacyDatabaseDetected: false,
    legacyNoticeShown: false,
  };
  const controller = new AbortController(),
    context = {
      signal: controller.signal,
      log: {
        info(event, fields) {
          logs.push({ event, fields });
        },
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
      storage: {
        json() {
          return {
            async read() {
              return structuredClone(state);
            },
            async update(change) {
              state = await change(structuredClone(state));
              return structuredClone(state);
            },
          };
        },
      },
      files: {
        dataPath: name => path.join(root, name),
        async withTemp(operation) {
          const dir = await fs.mkdtemp(path.join(root, "temp-"));
          try {
            return await operation(dir, controller.signal);
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        },
      },
      processes: {
        async run(file, args, runOptions) {
          calls.push({ file, args, options: runOptions });
          if (options.process) return options.process(file, args, runOptions, calls);
          if (file.endsWith("ssh-keyscan"))
            return {
              stdout: Buffer.from(`${args.at(-1)} ssh-ed25519 AAAATEST\n`),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            };
          if (file.endsWith("ssh-keygen"))
            return { stdout: Buffer.from(`256 ${fingerprint} host (ED25519)\n`), stderr: Buffer.alloc(0), exitCode: 0 };
          if (file === "/usr/bin/ssh")
            return {
              stdout: result(args.includes("ubuntu@203.0.113.1") ? "one" : "two"),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            };
          if (args[0] === "--version")
            return { stdout: Buffer.from("speedtest 1.2"), stderr: Buffer.alloc(0), exitCode: 0 };
          return { stdout: result("local"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      },
      http: {},
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply(_m, text) {
          replies.push(text);
        },
        async getReply() {
          return options.reply;
        },
        async withClient(operation) {
          return operation(options.client ?? {}, controller.signal);
        },
      },
    };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (args, message = {}) =>
    create().commands.speedlink.handle(
      {
        command: "speedlink",
        prefix: ".",
        args,
        message: {
          id: 1,
          chatId: "1",
          senderId: "1",
          outgoing: true,
          text: ".speedlink " + args.join(" "),
          raw: { peerId: "peer" },
          ...message,
        },
      },
      context,
    );
  return { root, controller, context, edits, replies, calls, logs, state: () => state, run };
}

test("speedlink production artifact has one V2 definition and real Host loads without processes", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-speedlink-host-"))),
    edits = [],
    host = new PluginHost({
      storageRoot: root,
      processes: { concurrency: 2, queueCapacity: 8, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024 },
      logger: { info() {}, error() {} },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply() {},
        async invoke() {},
        async getReply() {},
        async withClient() {},
      },
    });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    host
      .listCommands()
      .filter(value => value.pluginId === "speedlink")
      .map(value => value.name)
      .sort(),
    ["sl", "speedlink"],
  );
  await host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".speedlink help" });
  assert.match(edits.at(-1), /SSH agent/);
});

test("speedlink preserves Legacy multi-server selectors with pinned fixed SSH and isolated environments", async t => {
  const previous = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = "/tmp/fixture-agent.sock";
  t.after(() => {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  });
  const f = await fixture(t);
  await f.run(["1", "two"]);
  const ssh = f.calls.filter(value => value.file === "/usr/bin/ssh");
  assert.equal(ssh.length, 2);
  for (const call of f.calls) {
    assert.ok(call.options.signal instanceof AbortSignal);
    if (call.file === "/usr/bin/ssh") assert.deepEqual(call.options.env, { SSH_AUTH_SOCK: "/tmp/fixture-agent.sock" });
    else assert.deepEqual(call.options.env, {});
  }
  for (const call of ssh) {
    assert.ok(call.args.includes("BatchMode=yes"));
    assert.ok(call.args.includes("PasswordAuthentication=no"));
    assert.ok(call.args.includes("KbdInteractiveAuthentication=no"));
    assert.ok(call.args.includes("StrictHostKeyChecking=yes"));
    assert.deepEqual(call.args.slice(-4), ["speedtest", "--accept-license", "--accept-gdpr", "--format=json"]);
    assert.equal(call.options.timeoutMs, 45000);
    assert.equal(call.options.maxOutputBytes, 2 * 1024 * 1024);
  }
  const output = [...f.edits.slice(-1), ...f.replies].join("\n");
  assert.match(output, /one/);
  assert.match(output, /two/);
});

test("speedlink local run uses fixed official arguments, empty environment and bounded time/output", async t => {
  const f = await fixture(t, { servers: [] });
  await f.run([]);
  assert.equal(f.calls[0].args[0], "--version");
  assert.deepEqual(f.calls[0].options.env, {});
  const run = f.calls.at(-1);
  assert.deepEqual(run.args, ["--accept-license", "--accept-gdpr", "--format=json"]);
  assert.deepEqual(run.options.env, {});
  assert.equal(run.options.timeoutMs, 45000);
  assert.equal(run.options.maxOutputBytes, 2 * 1024 * 1024);
  assert.match(f.edits.at(-1), /本机/);
});

test("speedlink hides arbitrary process errors and cancellation suppresses late failure", async t => {
  const bad = await fixture(t, {
    process: async () => {
      throw Object.assign(new Error("请提供 sk-secret-token"), { name: "EVIL" });
    },
  });
  await bad.run(["1"]);
  assert.match(bad.edits.at(-1), /请检查参数、配置与本机工具/);
  assert.doesNotMatch(JSON.stringify({ edits: bad.edits, logs: bad.logs }), /sk-secret|EVIL/);
  let started, release;
  const ready = new Promise(resolve => (started = resolve)),
    gate = new Promise(resolve => (release = resolve)),
    cancelled = await fixture(t, {
      process: async (file, args, runOptions) => {
        if (file.endsWith("ssh-keyscan")) {
          started();
          await gate;
          runOptions.signal.throwIfAborted();
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    }),
    running = cancelled.run(["1"]);
  await ready;
  const before = cancelled.edits.length;
  cancelled.controller.abort();
  release();
  await running;
  assert.equal(cancelled.edits.length, before);
  assert.ok(!cancelled.logs.some(value => value.event === "speedlink_command_failed"));
});

test("speedlink rejects option-like SSH usernames before persistence or processes", async t => {
  const f = await fixture(t, { servers: [] }),
    add = create().commands.speedlink.subcommands.add;
  await add.handle(
    {
      command: "speedlink",
      prefix: ".",
      args: ["bad", "-oProxyCommand=x@host.test:22", fingerprint],
      message: { id: 1, chatId: "1", outgoing: true, text: "" },
    },
    f.context,
  );
  assert.equal(f.state().servers.length, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1), /连接格式/);
});

test("speedlink actively cancels a hanging result-image reader and releases its lock", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-speedlink-image-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let cancelled = false,
    body;
  const context = {
    http: {
      withResponse: async (_url, _init, consume) => {
        body = new ReadableStream({
          pull() {},
          cancel() {
            cancelled = true;
          },
        });
        return consume(new Response(body, { headers: { "content-type": "image/png" } }), controller.signal);
      },
    },
  };
  const running = downloadImage(context, "https://www.speedtest.net/result/fixture", path.join(root, "image.png"));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, /abort/i);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("speedlink backup and restore contain only pinned configuration and stream within the fixed budget", async t => {
  let backup, downloadSignal;
  const client = {
    async sendFile(target, options) {
      backup = { target, options, body: JSON.parse(await fs.readFile(options.file, "utf8")) };
    },
    async *iterDownload(_source, options) {
      downloadSignal = options.signal;
      yield Buffer.from(JSON.stringify({ schemaVersion: 1, timeoutSeconds: 30, servers: [servers[1]] }));
    },
  };
  const f = await fixture(t, {
      client,
      reply: { id: 9, raw: { document: { size: 200 }, media: { document: { size: 200 } } } },
    }),
    definition = create(),
    message = {
      id: 1,
      chatId: "1",
      senderId: "1",
      outgoing: true,
      saved: true,
      text: ".speedlink backup",
      replyToId: 9,
      raw: { peerId: "peer" },
    },
    invoke = args => ({ command: "speedlink", prefix: ".", args, message });
  await definition.commands.speedlink.subcommands.backup.handle(invoke([]), f.context);
  assert.equal(backup.target.className, "InputPeerSelf");
  assert.deepEqual(backup.body.servers, servers);
  assert.doesNotMatch(JSON.stringify(backup.body), /password|credentials|privateKey/);
  await definition.commands.speedlink.subcommands.restore.subcommands.confirm.handle(invoke([]), f.context);
  assert.ok(downloadSignal instanceof AbortSignal);
  assert.equal(f.state().timeoutSeconds, 30);
  assert.deepEqual(f.state().servers, [servers[1]]);
});

test("speedlink committed configuration changes are not reported failed when receipt editing fails", async t => {
  let edits = 0;
  const f = await fixture(t);
  f.context.telegram.edit = async () => {
    if (++edits > 0) throw new Error("private receipt");
  };
  const handler = create().commands.speedlink.subcommands.rename;
  await handler.handle(
    {
      command: "speedlink",
      prefix: ".",
      args: ["1", "renamed"],
      message: { id: 1, chatId: "1", outgoing: true, text: ".speedlink rename 1 renamed" },
    },
    f.context,
  );
  assert.equal(f.state().servers[0].name, "renamed");
  assert.ok(f.logs.some(value => value.event === "speedlink_receipt_failed"));
  assert.ok(!f.logs.some(value => value.event === "speedlink_command_failed"));
});
