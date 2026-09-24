"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const esbuild = require(path.join(core, "node_modules/esbuild"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { HTMLParser } = require(path.join(core, "node_modules/teleproto/extensions/html.js"));
const { artifactDir } = buildPlugin({ id: "say", packageRoot: path.resolve(__dirname, "../say"), entry: "v2.ts" });
const create = require(path.join(artifactDir, "index.cjs")).default;

async function fixture(t, responder) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-say-v2-")));
  const edits = [],
    requests = [],
    sent = [],
    deleted = [];
  const audio = Buffer.from("OggS scoped voice");
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    http: {
      async fetch(url, init) {
        requests.push({ url: new URL(url), init });
        if (responder) return responder(new URL(url), init, audio);
        return new Response(`${JSON.stringify({ code: 0, data: audio.toString("base64") })}\n`, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(operation, signal) {
        return operation(
          {
            async sendFile(peer, options) {
              const info = await fs.stat(options.file);
              sent.push({ peer, options, bytes: await fs.readFile(options.file) });
              assert.ok(info.isFile());
              return {
                async edit(value) {
                  sent.at(-1).edited = value;
                },
              };
            },
          },
          signal,
        );
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const message = (text, extra = {}) => ({
    id: edits.length + 1,
    chatId: "9007199254740993",
    senderId: "1",
    outgoing: true,
    text,
    raw: {
      peerId: "9007199254740993",
      async delete(options) {
        deleted.push(options);
      },
    },
    ...extra,
  });
  const run = (text, extra = {}) => host.dispatchPrimary(message(text, extra));
  const listen = (text, extra = {}) => host.dispatchListeners(message(text, extra));
  return { host, root, edits, requests, sent, deleted, run, listen };
}

test("say keeps keys non-echoing and sends Volc OGG from a scoped temporary file", async t => {
  const f = await fixture(t);
  await f.run(".say key volc private-volc-token", { saved: true });
  assert.doesNotMatch(f.edits.at(-1).text, /private-volc-token/);
  await f.run(".say voice volc zh_female_test");
  await f.run(".say 你好");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, "https://openspeech.bytedance.com/api/v3/tts/unidirectional");
  assert.equal(f.requests[0].init.headers["X-Api-Key"], "private-volc-token");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.voiceNote, true);
  assert.equal(f.sent[0].bytes.toString(), "OggS scoped voice");
  assert.equal(f.deleted.length, 1);
  assert.deepEqual(
    await fs
      .readdir(path.join(f.root, ".temp", "say"))
      .catch(error => (error.code === "ENOENT" ? [] : Promise.reject(error))),
    [],
  );
  const settings = await f.host.readSettings("say");
  assert.equal(settings.secretSet.volcKey, true);
  assert.equal(settings.values.volcKey, undefined);
});

test("say automatic mode is isolated by decimal chat-id and reloads without retained work", async t => {
  const f = await fixture(t);
  await f.run(".say key volc token", { saved: true });
  await f.run(".say on");
  await f.listen("自动语音文本");
  assert.equal(f.sent.length, 1);
  assert.equal(f.deleted.length, 1);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, "say/config.json"), "utf8"));
  assert.equal(stored.chats["9007199254740993"], true);
  assert.equal((await f.host.unload("say", 1000)).completed, true);
  await f.host.load(create());
  assert.equal(f.host.snapshot().plugins, 1);
});

test("say falls back from the selected MiMo provider to a configured Volc provider", async t => {
  const f = await fixture(t, (url, _init, audio) => {
    if (url.hostname === "api.xiaomimimo.com")
      return Response.json({ error: { message: "fixture failure" } }, { status: 503 });
    return new Response(`${JSON.stringify({ code: 0, data: audio.toString("base64") })}\n`, { status: 200 });
  });
  await f.run(".say key mimo mimo-token", { saved: true });
  await f.run(".say key volc volc-token", { saved: true });
  await f.run(".say voice volc zh_female_test");
  await f.run(".say provider mimo");
  await f.run(".say fallback");
  assert.deepEqual(
    f.requests.map(item => item.url.hostname),
    ["api.xiaomimimo.com", "openspeech.bytedance.com"],
  );
  assert.equal(f.sent.length, 1);
});

test("say unload cancels an in-flight provider request without late media or deletion", async t => {
  let started;
  const pending = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, (_url, init) => {
    started();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
    );
  });
  await f.run(".say key volc token", { saved: true });
  await f.run(".say voice volc zh_female_test");
  const running = f.run(".say pending");
  await pending;
  const report = await f.host.unload("say", 1000);
  await running;
  assert.equal(report.completed, true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted.length, 0);
  assert.deepEqual(
    await fs
      .readdir(path.join(f.root, ".temp", "say"))
      .catch(error => (error.code === "ENOENT" ? [] : Promise.reject(error))),
    [],
  );
});

test("say cancels a hung response reader and waits for underlying cleanup", async t => {
  let ready,
    release,
    cancelled = 0;
  const started = new Promise(r => {
    ready = r;
  });
  const gate = new Promise(r => {
    release = r;
  });
  const f = await fixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          start() {
            ready();
          },
          cancel() {
            cancelled++;
            return gate;
          },
        }),
      ),
  );
  await f.run(".say key fish token", { saved: true });
  const running = f.run(".say pending");
  await started;
  const unloading = f.host.unload("say", 1000);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(cancelled, 1);
  release();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted.length, 0);
});

test("say never exposes arbitrary provider diagnostics", async t => {
  const secret = "PRIVATE_PROVIDER_SECRET";
  const f = await fixture(t, () => {
    throw Object.assign(new Error(secret), { name: secret });
  });
  await f.run(".say key fish token", { saved: true });
  await f.run(".say hello");
  assert.match(f.edits.at(-1).text, /语音操作失败，请检查配置或稍后重试/);
  assert.doesNotMatch(JSON.stringify(f.edits), new RegExp(secret));
});

test("say captions stay within Telegram HTML bounds with closed entities", async t => {
  const f = await fixture(t);
  await f.run(".say key volc token", { saved: true });
  await f.run(`.say ${"<&🙂".repeat(260)}`);
  const value = f.sent[0].options.caption;
  assert.ok(value.length <= 1024);
  assert.doesNotThrow(() => HTMLParser.parse(value));
  assert.equal((value.match(/<blockquote>/g) || []).length, (value.match(/<\/blockquote>/g) || []).length);
});

test("say converts MiMo and Fish audio through managed FFmpeg while the scoped file exists", async t => {
  const root = await fs.mkdtemp(path.join(core, "dist", "mibot-say-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "media.cjs");
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "../say/v2/media.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const { sendVoice } = require(output);
  for (const provider of ["mimo", "fish"]) {
    const scoped = path.join(root, `temp-${provider}`);
    await fs.mkdir(scoped);
    const sent = [],
      calls = [];
    const config = {
      schemaVersion: 1,
      primary: provider,
      speed: 1,
      style: "",
      translate: false,
      chats: {},
      providers: {
        mimo: { apiKey: provider === "mimo" ? "mimo-key" : "", voice: "voice", endpoint: "standard" },
        volc: { apiKey: "", resourceId: "seed-tts-2.0", voice: "" },
        fish: { apiKey: provider === "fish" ? "fish-key" : "", voice: "fish-voice" },
      },
    };
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      log: { error() {} },
      services: {
        available() {
          return false;
        },
      },
      http: {
        async withResponse(_url, _init, consume) {
          const source =
            provider === "mimo"
              ? Response.json({ choices: [{ message: { audio: { data: Buffer.from("wav").toString("base64") } } }] })
              : new Response(Buffer.from("mp3"));
          return consume(source, controller.signal);
        },
      },
      processes: {
        async run(file, args, options) {
          calls.push({ file, args, options });
          if (args[0] === "-version") return { stdout: Buffer.from("ffmpeg fixture") };
          await fs.writeFile(args.at(-1), Buffer.from("OggS converted"));
          return { stdout: Buffer.alloc(0) };
        },
      },
      files: {
        async withTemp(operation) {
          try {
            return await operation(scoped, controller.signal);
          } finally {
            await fs.rm(scoped, { recursive: true, force: true });
          }
        },
      },
      telegram: {
        async withClient(operation) {
          return operation(
            {
              async sendFile(_peer, options) {
                assert.ok((await fs.stat(options.file)).isFile());
                sent.push(await fs.readFile(options.file));
                return {};
              },
            },
            controller.signal,
          );
        },
      },
    };
    await sendVoice(
      context,
      { message: { id: 1, chatId: "1", outgoing: true, text: "hello", raw: { peerId: "peer" } } },
      "hello",
      config,
      async () => {},
    );
    assert.equal(sent[0].toString(), "OggS converted");
    assert.ok(calls.some(value => value.args.includes("libopus")));
    const conversion = calls.find(value => value.args.includes("libopus"));
    assert.equal(conversion.options.cwd, scoped);
    assert.equal(conversion.args[conversion.args.indexOf("-protocol_whitelist") + 1], "file");
    assert.deepEqual(conversion.args.slice(-3, -1), ["-fs", String(32 * 1024 * 1024)]);
    await assert.rejects(fs.stat(scoped), { code: "ENOENT" });
  }
});

test("say delivers complete short and long translations outside the bounded caption", async t => {
  const root = await fs.mkdtemp(path.join(core, "temp/say-translation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "media.cjs");
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "../say/v2/media.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const { sendVoice } = require(output),
    controller = new AbortController(),
    replies = [],
    sent = [],
    long = `LONG_${"译<&🙂".repeat(900)}_END`;
  const cfg = {
    schemaVersion: 1,
    primary: "volc",
    speed: 1,
    style: "",
    translate: true,
    chats: {},
    providers: {
      mimo: { apiKey: "", voice: "", endpoint: "standard" },
      volc: { apiKey: "k", resourceId: "r", voice: "v" },
      fish: { apiKey: "", voice: "" },
    },
  };
  const ctx = {
    signal: controller.signal,
    log: { error() {} },
    http: {
      withResponse: async (_u, _i, consume) =>
        consume(
          new Response(JSON.stringify({ code: 0, data: Buffer.from("OggS").toString("base64") })),
          controller.signal,
        ),
    },
    services: {
      available: () => true,
      call: async (_p, _s, input) => (input.target === "en" ? "short translation" : long),
    },
    files: { withTemp: async use => use(root, controller.signal) },
    telegram: {
      withClient: async op =>
        op(
          {
            sendFile: async (_p, v) => {
              sent.push(v);
              return {};
            },
          },
          controller.signal,
        ),
      reply: async (_m, text) => replies.push(text),
    },
  };
  await sendVoice(
    ctx,
    { message: { raw: { peerId: "p" }, text: "短原文", chatId: "1", id: 1, outgoing: true } },
    "短原文",
    cfg,
    async () => {},
  );
  assert.ok(sent[0].caption.length <= 1024);
  const joined = replies.join("");
  assert.match(joined, /short translation/);
  assert.match(joined, /LONG_/);
  assert.match(joined, /_END/);
  assert.equal((joined.match(/译/g) || []).length, 2700);
});

test("say propagates upload cancellation but contains cleanup failure after a sent voice", async t => {
  const root = await fs.mkdtemp(path.join(core, "temp/say-gates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "media.cjs");
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "../say/v2/media.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const { sendVoice } = require(output),
    cfg = {
      schemaVersion: 1,
      primary: "volc",
      speed: 1,
      style: "",
      translate: false,
      chats: {},
      providers: {
        mimo: { apiKey: "", voice: "", endpoint: "standard" },
        volc: { apiKey: "k", resourceId: "r", voice: "v" },
        fish: { apiKey: "", voice: "" },
      },
    },
    make = (controller, cleanup = false) => {
      const logs = [];
      return [
        {
          signal: controller.signal,
          log: { error: e => logs.push(e) },
          http: {
            withResponse: async (_u, _i, c) =>
              c(
                new Response(JSON.stringify({ code: 0, data: Buffer.from("OggS").toString("base64") })),
                controller.signal,
              ),
          },
          services: { available: () => false },
          files: {
            withTemp: async use => {
              const value = await use(root, controller.signal);
              if (cleanup) throw new Error("cleanup");
              return value;
            },
          },
          telegram: {
            withClient: async op =>
              op(
                {
                  sendFile: async () => {
                    if (!cleanup) controller.abort();
                    return {};
                  },
                },
                controller.signal,
              ),
          },
        },
        logs,
      ];
    };
  let c = new AbortController(),
    [ctx] = make(c);
  await assert.rejects(sendVoice(ctx, { message: { raw: { peerId: "p" } } }, "text", cfg, async () => {}));
  await fs.rm(path.join(root, "voice.ogg"), { force: true });
  c = new AbortController();
  const pair = make(c, true);
  assert.ok(await sendVoice(pair[0], { message: { raw: { peerId: "p" } } }, "text", cfg, async () => {}));
  assert.deepEqual(pair[1], ["say_temp_cleanup_failed"]);
});
