"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
function create(id) {
  const { artifactDir } = buildPlugin({ id, packageRoot: path.resolve(__dirname, `../${id}`), entry: "v2.ts" });
  delete require.cache[require.resolve(path.join(artifactDir, "index.cjs"))];
  return require(path.join(artifactDir, "index.cjs")).default();
}
const central = {
  configs: {
    main: {
      tag: "main",
      url: "https://api.example.test/v1",
      key: "central-key",
      type: "openai-compatible",
      stream: false,
      responses: false,
      models: { chat: "vision-model" },
    },
  },
  currentChatTag: "main",
  currentChatModel: "vision-model",
  currentChatReasoningEffort: "auto",
  currentChatServiceTier: "auto",
  currentSearchTag: "",
  currentSearchModel: "",
  currentSearchReasoningEffort: "auto",
  currentSearchServiceTier: "auto",
  currentImageTag: "",
  currentImageModel: "",
  currentVideoTag: "",
  currentVideoModel: "",
  prompt: "",
  timeout: 30,
};

async function hosted(t, legacy) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-xmsl-host-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai", "config.json"),
    JSON.stringify(legacy ? { ...central, configs: {}, currentChatTag: "", currentChatModel: "" } : central),
  );
  if (legacy) {
    await fs.mkdir(path.join(root, "xmsl"));
    await fs.writeFile(path.join(root, "xmsl", "config.json"), JSON.stringify(legacy));
  }
  const edits = [],
    requests = [];
  let reply;
  const host = new PluginHost({
    storageRoot: root,
    processes: { timeoutMs: 90000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        requests.push({ url: new URL(url), init });
        return Response.json({ choices: [{ message: { content: "<think>隐藏</think> 羡慕富哥" } }] });
      },
    },
    telegram: {
      async edit(_message, text, options) {
        edits.push({ text, options });
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return reply;
      },
      async withClient() {
        assert.fail("unexpected native Telegram call");
      },
    },
  });
  await host.load(create("ai"));
  await host.load(create("xmsl"));
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    requests,
    setReply(value) {
      reply = value;
    },
    run: (text, message = {}) =>
      host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text, ...message }),
  };
}

test("xmsl uses the current central chat provider and redirects old provider commands", async t => {
  const f = await hosted(t);
  assert.deepEqual(
    f.host
      .listCommands()
      .filter(item => item.pluginId === "xmsl")
      .map(item => item.name),
    ["xm", "xmsl"],
  );
  await f.run(".xm set key local-secret", { saved: true });
  assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
  await f.run(".xmsl 买新手机了");
  assert.equal(f.requests[0].url.href, "https://api.example.test/v1/chat/completions");
  assert.equal(f.requests[0].init.headers.Authorization, "Bearer central-key");
  assert.equal(JSON.parse(f.requests[0].init.body).model, "vision-model");
  assert.equal(f.edits.at(-1).text, "羡慕富哥");
  await assert.rejects(f.host.readSettings("xmsl"), /unavailable/i);
});

test("xmsl migrates its legacy provider to ai and scrubs local credentials idempotently", async t => {
  const f = await hosted(t, {
    apiMode: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    apiKey: "legacy-secret",
    model: "legacy-model",
    importedLegacy: true,
    future: "preserved",
  });
  let ai = JSON.parse(await fs.readFile(path.join(f.root, "ai", "config.json"), "utf8"));
  let local = JSON.parse(await fs.readFile(path.join(f.root, "xmsl", "config.json"), "utf8"));
  assert.equal(ai.configs.xmsl.key, "legacy-secret");
  assert.equal(ai.configs.xmsl.models.chat, "legacy-model");
  assert.equal(ai.currentChatTag, "xmsl");
  assert.equal(local.apiKey, "");
  assert.equal(local.baseUrl, "");
  assert.equal(local.model, "");
  assert.equal(local.future, "preserved");
  assert.equal((await f.host.unload("xmsl", 1000)).completed, true);
  await f.host.load(create("xmsl"));
  ai = JSON.parse(await fs.readFile(path.join(f.root, "ai", "config.json"), "utf8"));
  assert.deepEqual(Object.keys(ai.configs), ["xmsl"]);
});

function direct(options = {}) {
  const edits = [],
    replies = [],
    errors = [],
    calls = [],
    serviceCalls = [],
    downloadOptions = [];
  const controller = new AbortController(),
    signal = controller.signal;
  let editAttempts = 0,
    replyAttempts = 0;
  let state = {
    schemaVersion: 1,
    apiMode: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    importedLegacy: true,
    aiMigrated: true,
  };
  const context = {
    signal,
    log: {
      info() {},
      error(event) {
        errors.push(event);
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
    services: {
      available(id, service) {
        return id === "ai" && ["chat", "selection"].includes(service);
      },
      async call(id, service, input) {
        serviceCalls.push({ id, service, input });
        if (service === "selection") return { chat: { tag: "main", model: "vision" } };
        return options.answer || "羡慕猫奴";
      },
    },
    files: {
      async withTemp(use) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-xmsl-media-"));
        let value;
        try {
          value = await use(dir, signal);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
        if (options.cleanupFails) throw new Error("private cleanup");
        return value;
      },
    },
    processes: {
      async run(command, args, runOptions) {
        calls.push({ command, args, options: runOptions });
        if (options.processError) throw options.processError;
        const output = args.at(-1);
        if (output.endsWith(".gif")) await fs.writeFile(output, "gif");
        else await fs.writeFile(output, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    },
    telegram: {
      async edit(_message, text, editOptions) {
        editAttempts++;
        if (options.resultEditFailsOnce && editAttempts === 2) throw new Error("private first page failure");
        edits.push({ text, options: editOptions });
      },
      async reply(_message, text, replyOptions) {
        replyAttempts++;
        if (options.replyFails || (options.replyFailsOnce && replyAttempts === 1))
          throw new Error("private delivery failure");
        replies.push({ text, options: replyOptions });
      },
      async getReply() {
        return options.reply;
      },
      async withClient(operation) {
        return operation(
          {
            iterDownload(_media, current) {
              downloadOptions.push(current);
              if (options.iterator) return options.iterator(current);
              return (async function* () {
                yield options.mediaBytes || Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
              })();
            },
          },
          signal,
        );
      },
    },
  };
  const run = (text = ".xmsl") =>
    create("xmsl").commands.xmsl.handle(
      {
        command: "xmsl",
        prefix: ".",
        args: text.split(/\s+/).slice(1),
        message: { id: 1, chatId: "1", senderId: "1", outgoing: true, text, replyToId: 2, raw: { peerId: 1 } },
      },
      context,
    );
  return { context, edits, replies, errors, calls, serviceCalls, downloadOptions, controller, run };
}

test("xmsl sends replied static images to the central multimodal chat service", async () => {
  const f = direct({ reply: { id: 2, text: "猫", raw: { media: { photo: {} }, photo: {} } } });
  await f.run();
  const input = f.serviceCalls.find(call => call.service === "chat").input;
  assert.equal(input.images[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(input.images[0].data), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  assert.equal(f.edits.at(-1).text, "羡慕猫奴");
});

test("xmsl extracts WebM and TGS first frames with bounded helpers", async () => {
  const webm = direct({
    reply: {
      id: 2,
      text: "",
      raw: { media: { document: { mimeType: "video/webm", attributes: [{ className: "DocumentAttributeSticker" }] } } },
    },
    mediaBytes: Buffer.from("webm"),
  });
  await webm.run();
  assert.equal(webm.calls[0].command, "/usr/bin/ffmpeg");
  assert.deepEqual(webm.calls[0].args.slice(0, 5), ["-nostdin", "-y", "-protocol_whitelist", "file", "-i"]);
  assert.ok(webm.calls[0].args.includes("-fs"));
  assert.ok(webm.calls[0].options.signal instanceof AbortSignal);
  assert.ok(webm.calls[0].options.cwd);
  const tgs = direct({
    reply: {
      id: 2,
      text: "",
      raw: {
        media: {
          document: { mimeType: "application/x-tgsticker", attributes: [{ className: "DocumentAttributeSticker" }] },
        },
      },
    },
    mediaBytes: Buffer.from("tgs"),
  });
  await tgs.run();
  assert.equal(tgs.calls[0].command, "/usr/bin/python3");
  assert.equal(tgs.calls[1].command, "/usr/bin/ffmpeg");
  assert.equal(tgs.serviceCalls.filter(call => call.service === "chat").length, 1);
});

test("xmsl stops after a timed-out media helper and declares its process budget", async () => {
  const f = direct({
    reply: {
      id: 2,
      text: "",
      raw: { media: { document: { mimeType: "video/webm", attributes: [{ className: "DocumentAttributeSticker" }] } } },
    },
    mediaBytes: Buffer.from("webm"),
    processError: Object.assign(new Error("private argv"), { code: "TIMED_OUT" }),
  });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.match(f.edits.at(-1).text, /WebM 贴纸转换失败/);
  assert.doesNotMatch(f.edits.at(-1).text, /private argv/);
  assert.deepEqual(create("xmsl").resources.processes, {
    concurrency: 1,
    queueCapacity: 1,
    timeoutMs: 90000,
    maxOutputBytes: 256 * 1024,
  });
});

test("xmsl preserves the complete legacy instruction corpus and long-answer notice", async t => {
  const f = await hosted(t);
  await f.run(".xmsl 我今天心情不好");
  const body = JSON.parse(f.requests[0].init.body),
    prompt = body.messages.find(message => message.role === "system").content;
  assert.match(prompt, /负面内容也可以轻轻调侃/);
  assert.match(prompt, /用户：\[一张美食图片\]/);
  assert.match(prompt, /你：羡慕会吃/);
  const long = direct({ answer: "甲".repeat(16001) });
  await long.run(".xmsl 测试");
  assert.match(long.edits.at(-1).text, /^⚠️ 回复过长\(4001 tokens, 超过限制4000\)/);
  assert.equal(long.edits.at(-1).text.endsWith("..."), true);
});

test("xmsl falls back to replied text when media conversion fails and preserves completed media across temp cleanup failure", async () => {
  const fallback = direct({
    reply: {
      id: 2,
      text: "仍然分析这段字",
      raw: { media: { document: { mimeType: "video/webm", attributes: [{ className: "DocumentAttributeSticker" }] } } },
    },
    mediaBytes: Buffer.from("webm"),
    processError: Object.assign(new Error("private helper"), { code: "TIMED_OUT" }),
  });
  await fallback.run();
  const chat = fallback.serviceCalls.find(call => call.service === "chat");
  assert.equal(chat.input.text, "仍然分析这段字");
  assert.equal(chat.input.images, undefined);
  const cleanup = direct({
    cleanupFails: true,
    reply: { id: 2, text: "猫", raw: { media: { photo: {} }, photo: {} } },
  });
  await cleanup.run();
  assert.equal(cleanup.serviceCalls.filter(call => call.service === "chat").length, 1);
  assert.equal(cleanup.edits.at(-1).text, "羡慕猫奴");
});

test("xmsl media writer completes short writes", async () => {
  const { artifactDir } = buildPlugin({ id: "xmsl", packageRoot: path.resolve(__dirname, "../xmsl"), entry: "v2.ts" });
  const { writeAll } = require(path.join(artifactDir, "index.cjs"));
  const bytes = [],
    signal = new AbortController().signal;
  await writeAll(
    {
      async write(chunk, offset, length) {
        const count = Math.min(2, length);
        bytes.push(...chunk.subarray(offset, offset + count));
        return { bytesWritten: count };
      },
    },
    Uint8Array.from([1, 2, 3, 4, 5]),
    signal,
  );
  assert.deepEqual(bytes, [1, 2, 3, 4, 5]);
});

test("xmsl passes the combined signal into iterDownload and cancellation prevents late processing", async () => {
  let began;
  const started = new Promise(resolve => {
    began = resolve;
  });
  const f = direct({
    reply: { id: 2, text: "", raw: { media: { photo: {} }, photo: {} } },
    iterator(current) {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          began();
          return new Promise((_resolve, reject) =>
            current.signal.addEventListener("abort", () => reject(current.signal.reason), { once: true }),
          );
        },
      };
    },
  });
  const running = f.run();
  await started;
  assert.ok(f.downloadOptions[0].signal instanceof AbortSignal);
  f.controller.abort(new DOMException("unload", "AbortError"));
  await running;
  assert.equal(f.calls.length, 0);
  assert.equal(f.serviceCalls.filter(call => call.service === "chat").length, 0);
  assert.deepEqual(f.edits, []);
});

test("xmsl closes a newly opened handle when cancellation lands before iteration starts", async t => {
  const promises = require("node:fs/promises"),
    controller = new AbortController();
  let closed = 0,
    iterated = 0;
  t.mock.method(promises, "open", async () => {
    controller.abort(new DOMException("unload", "AbortError"));
    return {
      async close() {
        closed++;
      },
    };
  });
  const context = {
    signal: controller.signal,
    telegram: {
      async withClient(operation) {
        return operation(
          {
            iterDownload() {
              iterated++;
              return [];
            },
          },
          new AbortController().signal,
        );
      },
    },
  };
  await assert.rejects(
    require(
      path.join(
        buildPlugin({ id: "xmsl", packageRoot: path.resolve(__dirname, "../xmsl"), entry: "v2.ts" }).artifactDir,
        "index.cjs",
      ),
    ).download(context, { media: {} }, "/unused", controller.signal),
    error => error?.name === "AbortError",
  );
  assert.equal(closed, 1);
  assert.equal(iterated, 0);
});

test("xmsl safely paginates a normal long result and does not overwrite partial delivery with an AI failure", async () => {
  const answer = "&".repeat(8000),
    complete = direct({ answer });
  await complete.run(".xmsl 长回复");
  const pages = [complete.edits.at(-1), ...complete.replies];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.text.length <= 4000 && page.options.parseMode === "html"));
  assert.equal(
    pages.reduce((count, page) => count + (page.text.match(/&amp;/g) || []).length, 0),
    8000,
  );
  assert.ok(pages.every(page => /\d+\/\d+ 页$/.test(page.text)));
  const partial = direct({ answer, replyFailsOnce: true });
  await partial.run(".xmsl 长回复");
  assert.equal(partial.edits.length, 2);
  assert.ok(partial.errors.includes("xmsl_delivery_interrupted"));
  assert.match(partial.replies.at(-1).text, /已发送 1\/\d+ 页，后续页发送中断/);
  assert.doesNotMatch(partial.edits.at(-1).text, /XMSL 调用失败/);
  const none = direct({ answer, resultEditFailsOnce: true });
  await none.run(".xmsl 长回复");
  assert.equal(none.edits.at(-1).text, "XMSL 结果发送失败，请重新执行");
  assert.ok(none.errors.includes("xmsl_delivery_failed"));
  const noticeFailure = direct({ answer, replyFails: true });
  await noticeFailure.run(".xmsl 长回复");
  assert.ok(noticeFailure.errors.includes("xmsl_delivery_notice_failed"));
  assert.ok(!noticeFailure.errors.includes("xmsl_failed"));
});
