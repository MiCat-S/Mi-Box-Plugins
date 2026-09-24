"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({ id: "t", packageRoot: path.resolve(__dirname, "../t"), entry: "v2.ts" });
const entry = require(path.join(artifactDir, "index.cjs"));
const create = entry.default;

function memoryStore(initial) {
  let value = structuredClone(initial);
  return {
    async read() {
      return structuredClone(value);
    },
    async update(change) {
      value = await change(structuredClone(value));
      return structuredClone(value);
    },
    value: () => structuredClone(value),
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-t-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController(),
    requests = [],
    sent = [],
    edits = [],
    logs = [],
    processCalls = [];
  const initial = {
    schemaVersion: 1,
    users: { 1: { apiKey: "fish-secret", defaultRole: "雷军", defaultRoleId: "role-id" } },
    roles: {},
    covers: {},
  };
  const store = memoryStore(initial);
  const raw = {
    peerId: "peer",
    isPrivate: options.private === true,
    async delete(argument) {
      if (options.deleteFails) throw new Error("private delete failure");
      options.deletions?.push(argument);
    },
  };
  const context = {
    signal: controller.signal,
    log: {
      error(event) {
        logs.push(event);
      },
    },
    storage: {
      json() {
        return store;
      },
    },
    http: {
      async withResponse(url, init, operation, policy) {
        requests.push({ url: String(url), init, policy });
        return operation(options.response?.() ?? new Response(Buffer.from("fish-audio")), controller.signal);
      },
    },
    files: {
      async withTemp(operation) {
        const directory = await fs.mkdtemp(path.join(root, "job-"));
        const value = await operation(directory, controller.signal);
        await fs.rm(directory, { recursive: true, force: true });
        if (options.tempCleanupFails) throw new Error("private temp cleanup failure");
        return value;
      },
    },
    processes: {
      async run(file, args, runOptions) {
        processCalls.push({ file, args: [...args], options: runOptions });
        const output = args.at(-1);
        await fs.writeFile(output, Buffer.from("converted"));
        if (options.outputSize) await fs.truncate(output, options.outputSize);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async getReply() {
        return options.reply;
      },
      async withClient(operation) {
        return operation(
          {
            async sendFile(peer, sendOptions) {
              sent.push({ peer, options: sendOptions, bytes: await fs.readFile(sendOptions.file) });
            },
          },
          controller.signal,
        );
      },
    },
  };
  const run = args =>
    create().commands.t.handle(
      {
        command: "t",
        prefix: "!",
        args,
        message: { id: 3, chatId: "1", senderId: "1", replyToId: options.reply?.id, text: `!t ${args.join(" ")}`, raw },
      },
      context,
    );
  return { context, controller, requests, sent, edits, logs, processCalls, store, raw, run };
}

test("t production artifact loads in the real Host with the complete legacy role corpus and active-prefix usage", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-t-host-"))),
    edits = [];
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!"],
    logger: { info() {}, error() {} },
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    telegram: {
      async edit(_message, text) {
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
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: "!ts 3" });
  assert.match(edits.at(-1), /第 3\/3 页/);
  assert.match(edits.at(-1), /蔚蓝档案星野/);
  assert.match(edits.at(-1), /!ts 角色名/);
});

test("t preserves normal reply-source precedence and Fish Audio request protocol", async t => {
  const f = await fixture(t, { reply: { id: 9, text: "回复原文 🎉" } });
  await f.run(["显式", "文本"]);
  assert.equal(f.requests[0].url, "https://api.fish.audio/v1/tts");
  assert.equal(f.requests[0].init.method, "POST");
  assert.equal(f.requests[0].init.credentials, "omit");
  assert.equal(f.requests[0].init.headers.authorization, "Bearer fish-secret");
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { text: "显式 文本", reference_id: "role-id" });
  assert.equal(f.sent[0].options.replyTo, 9);
  assert.equal(f.sent[0].options.voiceNote, true);
  assert.ok(f.processCalls[0].args.includes("-protocol_whitelist"));
  assert.ok(f.processCalls[0].args.includes("-fs"));
  assert.equal(f.processCalls[0].options.cwd, path.dirname(f.processCalls[0].args.at(-1)));
  const replied = await fixture(t, { reply: { id: 10, text: "回复原文 🎉" } });
  await replied.run([]);
  assert.deepEqual(JSON.parse(replied.requests[0].init.body), { text: "回复原文", reference_id: "role-id" });
});

test("t music mode keeps command lyrics while replying and applies bounded file-only ffmpeg inputs", async t => {
  const f = await fixture(t, { reply: { id: 11, text: "不能替换歌词" } });
  await f.run(["歌名", "歌手", "歌词"]);
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { text: "歌词", reference_id: "role-id" });
  assert.equal(f.sent[0].options.replyTo, 11);
  assert.equal(f.sent[0].options.caption, "歌名 - 歌手");
  assert.ok(f.processCalls[0].args.includes("-protocol_whitelist"));
  assert.ok(f.processCalls[0].args.includes("-fs"));
});

test("t rejects sparse ffmpeg output above the measured 50 MiB boundary before Telegram send", async t => {
  const f = await fixture(t, { outputSize: 50 * 1024 * 1024 + 1 });
  await f.run(["超限"]);
  assert.equal(f.sent.length, 0);
  assert.ok(f.logs.includes("t_failed"));
  assert.match(f.edits.at(-1), /语音生成失败/);
});

test("t cover downloads require the Core public-address policy for the URL and every redirect", async t => {
  const f = await fixture(t);
  await f.context.storage.json().update(value => ({ ...value, covers: { 雷军: "https://covers.example/image.jpg" } }));
  await f.run(["歌名", "歌手", "歌词"]);
  const cover = f.requests.find(request => request.url === "https://covers.example/image.jpg");
  assert.equal(cover.policy.denyPrivateAddresses, true);
  assert.deepEqual(cover.policy.redirects, { allowedHosts: ["covers.example"], maxRedirects: 2 });
});

test("writeAll completes short writes and rejects a stalled writer", async () => {
  const output = [],
    signal = new AbortController().signal;
  await entry.writeAll(
    {
      async write(chunk, offset, length) {
        const count = Math.min(2, length);
        output.push(...chunk.subarray(offset, offset + count));
        return { bytesWritten: count };
      },
    },
    Uint8Array.from([1, 2, 3, 4, 5]),
    signal,
  );
  assert.deepEqual(output, [1, 2, 3, 4, 5]);
  await assert.rejects(
    entry.writeAll(
      {
        async write() {
          return { bytesWritten: 0 };
        },
      },
      Uint8Array.of(1),
      signal,
    ),
    /write failed/i,
  );
});

test("stream cancellation interrupts a hanging reader and releases the stream", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-t-stream-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cancelled = false,
    started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const body = new ReadableStream({
    pull() {
      started();
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const running = entry.stream(new Response(body), path.join(root, "audio"), controller.signal);
  await ready;
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(running, error => error?.name === "AbortError");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("t unload-style cancellation of a hanging Fish stream causes no process, send, delete, or late feedback", async t => {
  let cancelled = false,
    started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const deletions = [],
    body = new ReadableStream({
      pull() {
        started();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
  const f = await fixture(t, { deletions, response: () => new Response(body) });
  const running = f.run(["等待"]);
  await ready;
  while (!body.locked) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort(new DOMException("unload", "AbortError"));
  await running;
  assert.equal(cancelled, true);
  assert.equal(f.processCalls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(deletions.length, 0);
  assert.equal(f.edits.length, 0);
  assert.deepEqual(f.logs, []);
});

test("successful delivery survives temp and command cleanup failures without a false generation failure", async t => {
  const deletions = [],
    temp = await fixture(t, { tempCleanupFails: true, deletions });
  await temp.run(["完成"]);
  assert.equal(temp.sent.length, 1);
  assert.ok(temp.logs.includes("t_temp_cleanup_failed"));
  assert.ok(!temp.logs.includes("t_failed"));
  assert.doesNotMatch(temp.edits.join("\n"), /语音生成失败/);
  assert.equal(deletions.length, 1);
  const removal = await fixture(t, { deleteFails: true });
  await removal.run(["完成"]);
  assert.equal(removal.sent.length, 1);
  assert.ok(removal.logs.includes("t_command_cleanup_failed"));
  assert.ok(!removal.logs.includes("t_failed"));
});
