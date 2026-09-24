"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  os = require("node:os"),
  fs = require("node:fs/promises");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api } = require(path.join(core, "node_modules/teleproto"));
const built = buildPlugin({ id: "gif", packageRoot: path.resolve(__dirname, "../gif"), entry: "v2.ts" }),
  artifact = require(path.join(built.artifactDir, "index.cjs")),
  create = artifact.default;

async function fixture(options = {}) {
  const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gif-v2-"))),
    edits = [],
    runs = [],
    sent = [];
  let state = { schemaVersion: 1, maxFileSize: 50, maxDuration: 10, maxWidth: 512, maxHeight: 512, quality: 15 };
  const signal = options.signal ?? new AbortController().signal,
    source = {
      media: {
        document: {
          mimeType: "video/mp4",
          size: options.size ?? 4n,
          attributes: [{ className: "DocumentAttributeVideo", duration: options.duration ?? 1 }],
        },
      },
      document: {
        mimeType: "video/mp4",
        size: options.size ?? 4n,
        attributes: [{ className: "DocumentAttributeVideo", duration: options.duration ?? 1 }],
      },
    };
  const raw = {
    peerId: new Api.InputPeerSelf(),
    async delete() {
      this.deleted = true;
    },
  };
  let ffmpegCalls = 0;
  const client = {
    async *iterDownload() {
      for (const chunk of options.chunks ?? [Buffer.from("data")]) {
        signal.throwIfAborted();
        yield chunk;
      }
    },
    async sendFile(peer, value) {
      assert.ok((await fs.stat(value.file)).isFile());
      sent.push({ peer, value });
    },
  };
  const context = {
    signal,
    log: { info() {}, error() {} },
    storage: {
      json: () => ({
        async read() {
          return structuredClone(state);
        },
        async update(fn) {
          state = await fn(structuredClone(state));
          return structuredClone(state);
        },
      }),
    },
    files: {
      async withTemp(fn) {
        const directory = await fs.mkdtemp(path.join(temporaryRoot, "job-"));
        try {
          return await fn(directory, signal);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    },
    processes: {
      async run(command, args, processOptions) {
        runs.push({ command, args: [...args], options: processOptions });
        if (options.process)
          return options.process({
            command,
            args,
            processOptions,
            ffmpegCalls: command.endsWith("ffmpeg") ? ++ffmpegCalls : ffmpegCalls,
          });
        if (command.endsWith("ffprobe")) {
          const output = args.at(-1).endsWith("sticker.webm")
            ? { streams: [{ width: 300, height: 168 }], format: { duration: "1.2" } }
            : { streams: [{ width: 640, height: 360 }], format: { duration: "1.25" } };
          return { stdout: Buffer.from(JSON.stringify(output)), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        await fs.writeFile(args.at(-1), Buffer.from("webm"));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async getReply() {
        return { id: 7, chatId: "1", outgoing: false, text: "", raw: source };
      },
      async withClient(fn) {
        return fn(client, signal);
      },
    },
  };
  return { temporaryRoot, context, edits, runs, sent, raw, state: () => state };
}
const invocation = raw => ({
  command: "gif",
  prefix: ".",
  args: [],
  message: { id: 1, chatId: "1", replyToId: 7, outgoing: true, text: ".gif", raw },
});

test("API 2 artifact declares bounded process resources and imports", () => {
  const plugin = create();
  assert.equal(plugin.apiVersion, 2);
  assert.notEqual(plugin, create());
  assert.deepEqual(built.manifest.imports, ["node:fs/promises", "node:path", "telebox/sdk", "teleproto"]);
  assert.deepEqual(plugin.resources.processes, {
    concurrency: 1,
    queueCapacity: 1,
    timeoutMs: 180000,
    maxOutputBytes: 262144,
  });
});

test("managed conversion emits serializable animated sticker attributes with probed dimensions", async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.temporaryRoot, { recursive: true, force: true }));
  const plugin = create();
  await plugin.setup(f.context);
  await plugin.commands.gif.handle(invocation(f.raw), f.context);
  assert.equal(f.sent.length, 1);
  assert.equal(f.runs.length, 3);
  assert.ok(
    f.runs.every(
      run => path.isAbsolute(run.command) && run.args.includes("-protocol_whitelist") && run.args.includes("file"),
    ),
  );
  assert.ok(f.runs.every(run => run.options.cwd.startsWith(f.temporaryRoot)));
  const attrs = f.sent[0].value.attributes,
    video = attrs.find(value => value instanceof Api.DocumentAttributeVideo);
  assert.deepEqual(
    { duration: video.duration, width: video.w, height: video.h },
    { duration: 2, width: 300, height: 168 },
  );
  assert.ok(attrs.some(value => value instanceof Api.DocumentAttributeAnimated));
  assert.ok(attrs.some(value => value instanceof Api.DocumentAttributeSticker));
  for (const attribute of attrs) assert.ok(attribute.getBytes().length > 0);
  assert.ok(f.sent[0].peer.getBytes().length > 0);
  assert.equal(f.raw.deleted, true);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test("oversized first output retries with lower quality and bounded webm output", async t => {
  const f = await fixture({
    process: async ({ command, args, ffmpegCalls }) => {
      if (command.endsWith("ffprobe"))
        return {
          stdout: Buffer.from(
            JSON.stringify(
              args.at(-1).endsWith("sticker.webm")
                ? { streams: [{ width: 320, height: 180 }], format: { duration: "1.1" } }
                : { streams: [{ width: 800, height: 450 }], format: { duration: "1" } },
            ),
          ),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      await fs.writeFile(args.at(-1), Buffer.alloc(ffmpegCalls === 1 ? 300 * 1024 : 1024));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  });
  t.after(() => fs.rm(f.temporaryRoot, { recursive: true, force: true }));
  await create().commands.gif.handle(invocation(f.raw), f.context);
  const conversions = f.runs.filter(run => run.command.endsWith("ffmpeg"));
  assert.equal(conversions.length, 2);
  assert.match(conversions[1].args[conversions[1].args.indexOf("-vf") + 1], /scale=320:320/);
  assert.equal(conversions[1].args[conversions[1].args.indexOf("-crf") + 1], "25");
  for (const run of conversions) {
    assert.equal(run.args[run.args.indexOf("-f") + 1], "webm");
    assert.equal(run.args[run.args.indexOf("-fs") + 1], String(2 * 1024 * 1024));
  }
  assert.equal(f.sent.length, 1);
});

test("declared and streamed size limits reject input and clean temporary files", async t => {
  const declared = await fixture({ size: 51n * 1024n * 1024n });
  t.after(() => fs.rm(declared.temporaryRoot, { recursive: true, force: true }));
  await create().commands.gif.handle(invocation(declared.raw), declared.context);
  assert.equal(declared.runs.length, 0);
  assert.match(declared.edits.at(-1), /文件超过配置上限/);
  const streamed = await fixture({
    size: undefined,
    chunks: [Buffer.alloc(30 * 1024 * 1024), Buffer.alloc(21 * 1024 * 1024)],
  });
  t.after(() => fs.rm(streamed.temporaryRoot, { recursive: true, force: true }));
  streamed.context.telegram.getReply = async () => ({
    id: 7,
    raw: {
      media: { document: { mimeType: "video/mp4", attributes: [] } },
      document: { mimeType: "video/mp4", attributes: [] },
    },
  });
  await create().commands.gif.handle(invocation(streamed.raw), streamed.context);
  assert.equal(streamed.runs.length, 0);
  assert.match(streamed.edits.at(-1), /文件超过配置上限/);
  assert.deepEqual(await fs.readdir(streamed.temporaryRoot), []);
});

test("cancellation aborts a pending managed download without another iterator request", async t => {
  const controller = new AbortController();
  let enteredResolve,
    nextCalls = 0,
    downloadSignal;
  const entered = new Promise(resolve => {
    enteredResolve = resolve;
  });
  const f = await fixture({ signal: controller.signal });
  t.after(() => fs.rm(f.temporaryRoot, { recursive: true, force: true }));
  f.context.telegram.withClient = async fn =>
    fn(
      {
        async *iterDownload(_media, params) {
          downloadSignal = params.signal;
          nextCalls++;
          yield Buffer.from("first");
          nextCalls++;
          enteredResolve();
          await new Promise((resolve, reject) =>
            params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true }),
          );
          nextCalls++;
          yield Buffer.from("late");
        },
        async sendFile() {
          assert.fail("upload after cancellation");
        },
      },
      controller.signal,
    );
  const running = create().commands.gif.handle(invocation(f.raw), f.context);
  await entered;
  controller.abort();
  await running;
  assert.equal(downloadSignal.aborted, true);
  assert.equal(nextCalls, 2);
  assert.equal(f.runs.length, 0);
  assert.deepEqual(f.edits, ["正在下载并转换动态贴纸…"]);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test("cancellation during a short write performs no later write", async () => {
  const controller = new AbortController();
  let enteredResolve,
    releaseResolve,
    writes = 0;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    release = new Promise(resolve => {
      releaseResolve = resolve;
    });
  const handle = {
    async write(_chunk, _offset, length) {
      writes++;
      if (writes === 1) return { bytesWritten: Math.min(2, length) };
      enteredResolve();
      await release;
      return { bytesWritten: Math.min(2, length) };
    },
  };
  const running = artifact.writeAll(handle, Buffer.from("abcdef"), controller.signal);
  await entered;
  controller.abort();
  releaseResolve();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(writes, 2);
});

test("cancellation during upload prevents command deletion and late feedback", async t => {
  const controller = new AbortController();
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    release = new Promise(resolve => {
      releaseResolve = resolve;
    });
  const f = await fixture({ signal: controller.signal });
  t.after(() => fs.rm(f.temporaryRoot, { recursive: true, force: true }));
  f.context.telegram.withClient = async fn =>
    fn(
      {
        async *iterDownload(_media, params) {
          assert.equal(params.signal.aborted, false);
          yield Buffer.from("data");
        },
        async sendFile() {
          enteredResolve();
          await release;
        },
      },
      controller.signal,
    );
  const running = create().commands.gif.handle(invocation(f.raw), f.context);
  await entered;
  controller.abort();
  releaseResolve();
  await running;
  assert.notEqual(f.raw.deleted, true);
  assert.deepEqual(f.edits, ["正在下载并转换动态贴纸…"]);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test("unknown helper failures use the fixed error and never expose paths", async t => {
  const f = await fixture({
    process: async ({ command, args }) => {
      if (command.endsWith("ffprobe"))
        return {
          stdout: Buffer.from(JSON.stringify({ streams: [{ width: 640, height: 360 }], format: { duration: "1" } })),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      throw new Error(`/private/secret/${path.basename(args.at(-1))}`);
    },
  });
  t.after(() => fs.rm(f.temporaryRoot, { recursive: true, force: true }));
  await create().commands.gif.handle(invocation(f.raw), f.context);
  assert.match(f.edits.at(-1), /转换失败：请检查媒体格式和 FFmpeg/);
  assert.doesNotMatch(f.edits.at(-1), /private|secret/);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test("real PluginHost loads, unloads and reloads the gif factory", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gif-host-"))),
    host = new PluginHost({
      storageRoot: root,
      logger: { info() {}, error() {} },
      telegram: {
        async edit() {},
        async reply() {},
        async invoke() {},
        async getReply() {},
        async withClient(fn, signal) {
          return fn({}, signal);
        },
      },
      processes: { concurrency: 1, queueCapacity: 1, timeoutMs: 180000, maxOutputBytes: 262144 },
    });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  assert.equal((await host.unload("gif", 1000)).completed, true);
  await host.load(create());
  assert.equal((await host.unload("gif", 1000)).completed, true);
});
