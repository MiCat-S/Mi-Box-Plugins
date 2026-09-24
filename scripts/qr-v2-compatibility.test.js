"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
const built = buildPlugin({ id: "qr", packageRoot: path.resolve(__dirname, "../qr"), entry: "v2.ts" }),
  create = require(path.join(built.artifactDir, "index.cjs")).default;

test("real Host unload aborts a pending iterDownload and starts no helper or late edit", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qr-host-"))),
    edits = [];
  let enteredResolve,
    nextCalls = 0,
    closed = false,
    downloadSignal;
  const entered = new Promise(resolve => {
    enteredResolve = resolve;
  });
  const client = {
    async *iterDownload(_media, options) {
      downloadSignal = options.signal;
      nextCalls++;
      try {
        enteredResolve();
        await new Promise((resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
        );
        nextCalls++;
        yield Buffer.from("late");
      } finally {
        closed = true;
      }
    },
  };
  const reply = { id: 2, chatId: "1", senderId: "2", outgoing: false, text: "", raw: { media: {}, photo: {} } },
    host = new PluginHost({
      storageRoot: root,
      logger: { info() {}, error() {} },
      processes: { concurrency: 1, queueCapacity: 4, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply() {},
        async invoke() {},
        async getReply() {
          return reply;
        },
        async withClient(fn, signal) {
          return fn(client, signal);
        },
      },
    });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  const running = host.dispatchPrimary({
    id: 1,
    chatId: "1",
    senderId: "1",
    outgoing: true,
    text: ".qr",
    replyToId: 2,
    raw: { peerId: new Api.InputPeerSelf() },
  });
  await entered;
  assert.equal((await host.unload("qr", 1000)).completed, true);
  await running;
  assert.equal(downloadSignal.aborted, true);
  assert.equal(nextCalls, 1);
  assert.equal(closed, true);
  assert.deepEqual(edits, ["正在识别二维码…"]);
});

test("qr generates a real CustomFile for an exact serializable TL peer", async () => {
  const peer = new Api.InputPeerUser({ userId: returnBigInt("9007199254740993"), accessHash: returnBigInt(77) }),
    sent = [],
    deleted = [];
  const signal = new AbortController().signal,
    context = {
      signal,
      log: { error() {} },
      processes: {
        async run() {
          return { stdout: Buffer.from("PNG"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      },
      telegram: {
        async edit() {},
        async withClient(fn) {
          return fn(
            {
              async sendFile(target, options) {
                assert.ok(target.getBytes().length > 0);
                assert.equal(target.userId.toString(), "9007199254740993");
                sent.push(options);
              },
            },
            signal,
          );
        },
      },
    };
  await create().commands.qr.handle(
    {
      command: "qr",
      prefix: ".",
      args: ["payload"],
      message: {
        id: 1,
        chatId: "9007199254740993",
        outgoing: true,
        text: ".qr payload",
        raw: {
          peerId: peer,
          async delete(value) {
            deleted.push(value);
          },
        },
      },
    },
    context,
  );
  const { CustomFile } = require(path.join(core, "node_modules/teleproto/client/uploads.js"));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].file instanceof CustomFile);
  assert.equal(sent[0].file.name, "qrcode.png");
  assert.deepEqual(deleted, [{ revoke: true }]);
});

test("qr cancellation during upload preserves the sent operation but performs no command delete or late edit", async () => {
  const controller = new AbortController(),
    edits = [],
    deleted = [];
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    release = new Promise(resolve => {
      releaseResolve = resolve;
    });
  const context = {
    signal: controller.signal,
    log: { error() {} },
    processes: {
      async run() {
        return { stdout: Buffer.from("PNG"), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async withClient(fn) {
        return fn(
          {
            async sendFile() {
              enteredResolve();
              await release;
            },
          },
          controller.signal,
        );
      },
    },
  };
  const running = create().commands.qr.handle(
    {
      command: "qr",
      prefix: ".",
      args: ["payload"],
      message: {
        id: 1,
        chatId: "1",
        outgoing: true,
        text: ".qr payload",
        raw: {
          peerId: new Api.InputPeerSelf(),
          async delete(value) {
            deleted.push(value);
          },
        },
      },
    },
    context,
  );
  await entered;
  controller.abort();
  releaseResolve();
  await running;
  assert.deepEqual(deleted, []);
  assert.deepEqual(edits, ["正在生成二维码…"]);
});

test("qr rejects a declared image over 20 MiB before opening a download", async () => {
  let clients = 0,
    runs = 0;
  const signal = new AbortController().signal;
  const context = {
    signal,
    log: { error() {} },
    files: {
      async withTemp() {
        assert.fail("temp file must not open");
      },
    },
    processes: {
      async run() {
        runs++;
      },
    },
    telegram: {
      async edit() {},
      async getReply() {
        return { id: 2, raw: { media: {}, photo: {}, document: { size: returnBigInt(20 * 1024 * 1024 + 1) } } };
      },
      async withClient() {
        clients++;
      },
    },
  };
  await create().commands.qr.handle(
    {
      command: "qr",
      prefix: ".",
      args: [],
      message: {
        id: 1,
        chatId: "1",
        replyToId: 2,
        outgoing: true,
        text: ".qr",
        raw: { peerId: new Api.InputPeerSelf() },
      },
    },
    context,
  );
  assert.equal(clients, 0);
  assert.equal(runs, 0);
});

test("qr keeps the first decoded result page when a later page fails and logs fixed metadata", async t => {
  const long = "<".repeat(3400),
    edits = [],
    replies = [],
    logs = [],
    signal = new AbortController().signal,
    context = {
      signal,
      log: {
        info(event, fields) {
          logs.push({ event, fields });
        },
        error() {},
      },
      files: {
        async withTemp(fn) {
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-pages-"));
          try {
            return await fn(dir, signal);
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        },
      },
      processes: {
        async run() {
          return { stdout: Buffer.from(`${long}\n${long}`), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply(_m, text) {
          replies.push(text);
          throw new Error("transport-secret");
        },
        async getReply() {
          return { id: 2, raw: { media: {}, photo: {} } };
        },
        async withClient(fn) {
          return fn(
            {
              async *iterDownload(_media, options) {
                assert.equal(options.signal.aborted, false);
                yield Buffer.from("image");
              },
            },
            signal,
          );
        },
      },
    };
  await create().commands.qr.handle(
    {
      command: "qr",
      prefix: ".",
      args: [],
      message: {
        id: 1,
        chatId: "1",
        replyToId: 2,
        outgoing: true,
        text: ".qr",
        raw: { peerId: new Api.InputPeerSelf() },
      },
    },
    context,
  );
  assert.equal(edits.length, 2);
  assert.match(edits[1], /&lt;/);
  assert.equal(logs[0].event, "qr_result_delivery_interrupted");
  assert.doesNotMatch(JSON.stringify({ edits, replies, logs }), /transport-secret/);
});
