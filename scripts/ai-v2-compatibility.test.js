"use strict";
// Behavioral compatibility tests for ai AI03 (read-only queries) and the
// AI04 Telegraph status/index-delete path. Runs against the real PluginHost with
// simulated Telegram and a fetch that fails on any unexpected external request.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { buildSync } = require(path.join(core, "node_modules/esbuild"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));

let create, deliverAnswer;
test.before(async () => {
  create = require(
    path.join(
      buildPlugin({ id: "ai", packageRoot: path.resolve(__dirname, "../ai"), entry: "v2.ts", rootDir: core })
        .artifactDir,
      "index.cjs",
    ),
  ).default;
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-answer-build-")));
  buildSync({
    entryPoints: [path.resolve(__dirname, "../ai/v2/answer.ts")],
    outfile: path.join(root, "answer.cjs"),
    bundle: true,
    platform: "node",
    packages: "external",
  });
  deliverAnswer = require(path.join(root, "answer.cjs")).deliverAnswer;
});

const CONFIG = {
  configs: {
    main: {
      tag: "main",
      url: "https://api.example.com/v1",
      key: "secret-key",
      stream: false,
      responses: false,
      models: { chat: "gpt-4o", search: "gpt-4o", image: "dall-e-3", video: "sora" },
    },
  },
  currentChatTag: "main",
  currentChatModel: "gpt-4o",
  currentChatReasoningEffort: "high",
  currentChatServiceTier: "priority",
  currentSearchTag: "main",
  currentSearchModel: "gpt-4o",
  currentSearchReasoningEffort: "low",
  currentSearchServiceTier: "flex",
  currentImageTag: "main",
  currentImageModel: "dall-e-3",
  currentVideoTag: "main",
  currentVideoModel: "sora",
  imagePreview: true,
  videoPreview: false,
  videoAudio: true,
  videoDuration: 12,
  prompt: "be nice",
  collapse: false,
  timeout: 45,
  telegraphToken: "token-value",
  telegraph: {
    enabled: true,
    limit: 3,
    list: [
      { url: "https://telegra.ph/a", title: "A", createdAt: "2026-01-01" },
      { url: "https://telegra.ph/b", title: "B", createdAt: "2026-01-02" },
    ],
  },
};

async function fixture(initial = CONFIG) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-compat-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(path.join(root, "ai/config.json"), JSON.stringify(initial));
  const edits = [],
    httpCalls = [];
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (...args) => {
        httpCalls.push(args);
        throw new Error("unexpected external request");
      },
    },
    telegram: {
      edit: async (message, text, _opts, signal) => {
        signal.throwIfAborted();
        edits.push({ id: message.id, text });
      },
      reply: async (message, text, _opts, signal) => {
        signal.throwIfAborted();
        edits.push({ id: message.id, text });
      },
      invoke: async () => ({}),
      getReply: async () => undefined,
      withClient: async (operation, signal) => operation({}, signal),
    },
  });
  await host.load(create());
  const send = (text, id = 1) => host.dispatchPrimary({ id, chatId: "chat", senderId: "1", outgoing: true, text });
  const read = async () => fs.readFile(path.join(root, "ai/config.json"), "utf8");
  const cleanup = async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  };
  return { host, send, edits, httpCalls, read, cleanup };
}

// ---------------------------------------------------------------------------
// AI03: every settings command answers a read-only query with the current value
// ---------------------------------------------------------------------------
const READ_ONLY = [
  [
    "!p model",
    [
      /chat 模型: <code>gpt-4o<\/code>/,
      /video 模型: <code>sora<\/code>/,
      /chat 思考强度: <code>high<\/code>/,
      /search 服务等级: <code>flex<\/code>/,
    ],
  ],
  ["!p reasoning", [/chat: <code>high<\/code>/, /search: <code>low<\/code>/]],
  ["!p service", [/chat: <code>priority<\/code>/, /search: <code>flex<\/code>/]],
  ["!p prompt", [/内容: <code>be nice<\/code>/]],
  ["!p collapse", [/当前状态: 关闭/]],
  ["!p timeout", [/45 秒/]],
  ["!p image preview", [/图片预览状态/, /当前状态: 开启/]],
  ["!p video preview", [/视频预览状态/, /当前状态: 关闭/]],
  ["!p video audio", [/视频音频状态/, /当前状态: 开启/]],
  ["!p video duration", [/视频时长/, /12 秒/]],
  [
    "!p telegraph",
    [
      /Telegraph 状态/,
      /当前状态: 开启/,
      /限制数量: <code>3<\/code>/,
      /记录数量: <code>2\/3<\/code>/,
      /https:\/\/telegra\.ph\/a/,
      /https:\/\/telegra\.ph\/b/,
    ],
  ],
];

test("AI03 read-only queries answer with current values, no writes and no external requests", async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const before = await f.read();
  for (const [index, [command, patterns]] of READ_ONLY.entries()) {
    await f.send(command, index + 1);
    const page = f.edits.at(-1).text;
    for (const pattern of patterns) assert.match(page, pattern, `${command} -> ${page}`);
  }
  assert.equal(await f.read(), before, "read-only queries never change stored config");
  assert.deepEqual(f.httpCalls, [], "read-only queries make no external request");
});

test("AI03 read-only output never leaks the API key or telegraph token", async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  for (const [command] of READ_ONLY) {
    await f.send(command, 1);
    assert.ok(!f.edits.at(-1).text.includes("secret-key"), `${command} must not leak the key`);
    assert.ok(!f.edits.at(-1).text.includes("token-value"), `${command} must not leak the token`);
  }
});

// ---------------------------------------------------------------------------
// AI04: Telegraph status and index deletion
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI01: reply context and reply/own image parts reach the real request body
// ---------------------------------------------------------------------------
test("AI01 chat request carries reply context and the reply image part", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-vision-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  const edits = [],
    bodies = [];
  const reply = {
    id: 2,
    chatId: "chat",
    text: "CONTEXT-TEXT",
    raw: {
      media: { className: "MessageMediaDocument", document: { className: "Document", mimeType: "image/png", size: 3 } },
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    telegram: {
      edit: async (_message, text) => {
        edits.push(text);
      },
      reply: async (_message, text) => {
        edits.push(text);
      },
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) => operation({ downloadMedia: async () => Buffer.from([1, 2, 3]) }, signal),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p WHAT-IS-THIS" });
  assert.equal(bodies.length, 1, "exactly one chat request is made");
  const body = bodies[0];
  assert.ok(body.includes("CONTEXT-TEXT"), "request body includes the reply context");
  assert.ok(body.includes("WHAT-IS-THIS"), "request body includes the own question");
  assert.match(body, /data:image\/png;base64/, "request body includes the reply image");
});

test("AI04 telegraph del removes one index atomically and rejects out-of-range", async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  await f.send("!p telegraph del 1", 1);
  assert.match(f.edits.at(-1).text, /已删除第 1 项/);
  let data = JSON.parse(await f.read());
  assert.deepEqual(
    data.telegraph.list.map(item => item.title),
    ["B"],
  );

  const before = await f.read();
  await f.send("!p telegraph del 5", 2);
  assert.match(f.edits.at(-1).text, /序号超出范围/);
  assert.equal(await f.read(), before, "out-of-range deletion changes nothing");

  await f.send("!p telegraph del all", 3);
  assert.match(f.edits.at(-1).text, /已删除所有记录/);
  data = JSON.parse(await f.read());
  assert.deepEqual(data.telegraph.list, []);
});

// ---------------------------------------------------------------------------
// AI02: markdown Q/A new reply, signature and best-effort command deletion
// ---------------------------------------------------------------------------
test("AI02 renders safe markdown, sends a signed new reply and deletes the command", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-answer-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
      collapse: false,
      telegraph: { enabled: false, limit: 5, list: [] },
    }),
  );
  const deleted = [],
    sent = [];
  const client = {
    sendMessage: async (_peer, payload) => {
      sent.push(payload);
      return { id: 100 + sent.length };
    },
    deleteMessages: async (peer, ids, opts) => {
      deleted.push({ peer, ids, opts });
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "**bold**\n\n```js\ncode();\n```" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? { id: 2, chatId: "chat", text: "the question" } : undefined),
      withClient: async (operation, signal) => operation(client, signal),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p tell me" });
  assert.equal(sent.length, 1, "a new message is sent instead of editing the command");
  const html = String(sent[0].message);
  assert.match(html, /Q:/);
  assert.match(html, /A:/);
  assert.match(html, /<b>bold<\/b>/, "markdown bold becomes HTML");
  assert.match(html, /<pre><code class="language-js">code\(\);/, "fenced code becomes pre/code");
  assert.match(html, /🍀Powered by main/);
  assert.equal(sent[0].replyTo, 2, "the answer is anchored to the reply target");
  assert.deepEqual(
    deleted.map(entry => entry.ids),
    [[1]],
    "the command message is deleted after send",
  );
  assert.equal(deleted[0].opts.revoke, true);
});

test("AI02 a failed command deletion does not fail the answer", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-answer-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
      collapse: false,
      telegraph: { enabled: false, limit: 5, list: [] },
    }),
  );
  const logs = [],
    sent = [];
  const client = {
    sendMessage: async (_peer, payload) => {
      sent.push(payload);
      return { id: 7 };
    },
    deleteMessages: async () => {
      throw new Error("delete failed");
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error: event => logs.push(event) },
    http: {
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async () => undefined,
      withClient: async (operation, signal) => operation(client, signal),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p hi" });
  assert.equal(sent.length, 1, "the answer still sends");
  assert.ok(logs.includes("ai:command-delete-failed"), "deletion failure is logged with a fixed event");
});

// ---------------------------------------------------------------------------
// AI02 pagination: real anchor ids, bounded pages, complete content
// ---------------------------------------------------------------------------
function answerContext(sent, controller = new AbortController()) {
  return {
    signal: controller.signal,
    log: { info() {}, error() {} },
    telegram: {
      withClient: async operation =>
        operation(
          {
            sendMessage: async (_peer, payload) => {
              sent.push(payload);
              return { id: 100 + sent.length };
            },
            deleteMessages: async () => {},
          },
          controller.signal,
        ),
      reply: async () => {},
    },
  };
}

test("AI02 long single-line answer paginates, anchors continuations to the first answer and keeps all text", async () => {
  const sent = [];
  const answer = "x".repeat(5000);
  await deliverAnswer(
    answerContext(sent),
    { id: 90, chatId: "chat", raw: { peerId: "chat" } },
    { question: "q", answer, tag: "main", collapse: false, replyToId: 12 },
    new AbortController().signal,
  );
  assert.ok(sent.length >= 2, `the 5000-char answer paginates (${sent.length})`);
  assert.equal(sent[0].replyTo, 12, "first page anchors to the reply target");
  assert.equal(sent[1].replyTo, 101, "continuation anchors to the first answer id");
  for (const payload of sent) assert.ok(payload.message.length <= 3500, `bounded page (${payload.message.length})`);
  const joined = sent.map(payload => payload.message).join("\n");
  assert.equal((joined.match(/x/g) ?? []).length, 5000, "every character survives pagination");
  assert.match(sent[0].message, /Q:/);
  assert.match(sent.at(-1).message, /🍀Powered by main/);
});

test("AI02 long question and cross-page code block paginate without splitting or overflowing", async () => {
  const sent = [];
  const question = "line ".repeat(2000);
  const answer =
    "intro\n\n```js\n" + Array.from({ length: 400 }, (_, index) => `const v${index} = ${index};`).join("\n") + "\n```";
  await deliverAnswer(
    answerContext(sent),
    { id: 90, chatId: "chat", raw: { peerId: "chat" } },
    { question, answer, tag: "main", collapse: true, replyToId: 12 },
    new AbortController().signal,
  );
  assert.ok(sent.length >= 2, "long content paginates");
  for (const payload of sent) {
    assert.ok(payload.message.length <= 3500, `bounded page (${payload.message.length})`);
    const opens = (payload.message.match(/<blockquote/g) ?? []).length;
    const closes = (payload.message.match(/<\/blockquote>/g) ?? []).length;
    assert.equal(opens, closes, "blockquote tags are page-local");
  }
  const joined = sent.map(payload => payload.message).join("\n");
  assert.ok(joined.includes("const v0 = 0;"), "code starts intact");
  assert.ok(joined.includes("const v399 = 399;"), "code ends intact");
  assert.ok(!/<pre>[^<]*$/.test(sent[0].message), "no page ends inside an unclosed pre");
  assert.match(sent.at(-1).message, /🍀Powered by main/);
});

test("AI02 escapes HTML in the question and answer across pages", async () => {
  const sent = [];
  await deliverAnswer(
    answerContext(sent),
    { id: 90, chatId: "chat", raw: { peerId: "chat" } },
    {
      question: "<script>alert(1)</script>",
      answer: "<img src=x onerror=alert(1)> ".repeat(400),
      tag: "main",
      collapse: false,
    },
    new AbortController().signal,
  );
  const joined = sent.map(payload => payload.message).join("\n");
  assert.ok(!joined.includes("<script>"), "raw question markup is escaped");
  assert.ok(!/<img\s/.test(joined), "raw answer markup is escaped");
  assert.ok(joined.includes("&lt;script&gt;") || joined.includes("&lt;img"), "escaped markup is present");
  for (const payload of sent) assert.ok(payload.message.length <= 3500);
});

// ---------------------------------------------------------------------------
// AI01 album: every grouped image part is collected in original order
// ---------------------------------------------------------------------------
test("AI01 album reply collects every grouped image in order", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-album-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  const bodies = [];
  const album = [
    { id: 3, groupedId: 99n, media: { className: "MessageMediaPhoto" } },
    { id: 2, groupedId: 99n, media: { className: "MessageMediaPhoto" } },
  ];
  const reply = {
    id: 2,
    chatId: "chat",
    text: "CONTEXT",
    raw: { groupedId: 99n, media: { className: "MessageMediaPhoto" }, chatId: "chat", peerId: "chat" },
  };
  const client = {
    async *iterMessages(_peer, _params) {
      for (const item of album) yield item;
    },
    downloadMedia: async () => Buffer.from([1, 2, 3]),
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) => operation(client, signal),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p describe" });
  assert.equal(bodies.length, 1);
  const matches = bodies[0].match(/data:image\/jpeg;base64/g) ?? [];
  assert.equal(matches.length, 2, "both album images reach the request");
});

test("AI01 streaming progress over budget aborts using real big-integer sizes", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-progress-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  let downloads = 0;
  let providerCalls = 0;
  const edits = [];
  const reply = {
    id: 2,
    chatId: "chat",
    text: "",
    raw: { media: { className: "MessageMediaDocument", document: { className: "Document", mimeType: "image/png" } } },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async () => {
        providerCalls += 1;
        throw new Error("must not call provider");
      },
    },
    telegram: {
      edit: async (_m, text) => {
        edits.push(text);
      },
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) =>
        operation(
          {
            downloadMedia: async (_raw, options) => {
              downloads += 1;
              // Teleproto passes bigInt(downloaded), bigInt(total).
              options.progressCallback?.(
                { toString: () => String(25 * 1024 * 1024) },
                { toString: () => String(25 * 1024 * 1024) },
              );
              return Buffer.from([1, 2, 3]);
            },
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p what is this" });
  assert.equal(downloads, 1, "the download starts and the streaming byte limit aborts it");
  assert.equal(providerCalls, 0, "the provider is never reached once the streaming limit trips");
  assert.match(edits.at(-1), /失败/, `expected a failure edit, got: ${edits.at(-1)}`);
});

test("AI01 GIF without thumb yields a PNG first frame while webm/TGS are not faked", async t => {
  const sharp = require(path.join(core, "node_modules/sharp"));
  const gif = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .gif()
    .toBuffer();
  const runCase = async (mime, bytes) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-media-")));
    await fs.mkdir(path.join(root, "ai"));
    await fs.writeFile(
      path.join(root, "ai/config.json"),
      JSON.stringify({
        configs: {
          main: {
            tag: "main",
            url: "https://api.example.com/v1",
            key: "k",
            stream: false,
            responses: false,
            models: { chat: "gpt-4o" },
          },
        },
        currentChatTag: "main",
        currentChatModel: "gpt-4o",
      }),
    );
    const bodies = [];
    const reply = {
      id: 2,
      chatId: "chat",
      text: "",
      raw: { media: { className: "MessageMediaDocument", document: { className: "Document", mimeType: mime } } },
    };
    const host = new PluginHost({
      storageRoot: root,
      selfId: "1",
      prefixes: ["!"],
      aliases: { p: "ai" },
      logger: { info() {}, error() {} },
      http: {
        fetch: async (_url, init) => {
          bodies.push(String(init.body));
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      telegram: {
        edit: async () => {},
        reply: async () => {},
        invoke: async () => ({}),
        getReply: async message => (message.id === 1 ? reply : undefined),
        withClient: async (operation, signal) =>
          operation(
            { downloadMedia: async () => bytes, sendMessage: async () => ({ id: 1 }), deleteMessages: async () => {} },
            signal,
          ),
      },
    });
    await host.load(create());
    t.after(async () => {
      await host.shutdown(1000);
      await fs.rm(root, { recursive: true, force: true });
    });
    await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p describe" });
    return bodies[0] ?? "";
  };
  const gifBody = await runCase("image/gif", gif);
  assert.match(gifBody, /data:image\/png;base64/, "GIF is decoded to a PNG first frame");
  const webmBody = await runCase("video/webm", Buffer.from("not-a-real-webm"));
  assert.doesNotMatch(webmBody, /data:image\//, "webm without a thumb is not faked as an image");
});

test("AI01 a 5-image album downloads four and discloses the drop", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-album5-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  let downloads = 0;
  const replies = [];
  const album = Array.from({ length: 5 }, (_, index) => ({
    id: 10 + index,
    groupedId: 5n,
    media: { className: "MessageMediaPhoto" },
  }));
  const reply = {
    id: 10,
    chatId: "chat",
    text: "",
    raw: { groupedId: 5n, media: { className: "MessageMediaPhoto" }, chatId: "chat", peerId: "chat" },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    telegram: {
      edit: async () => {},
      reply: async (_m, text) => {
        replies.push(text);
      },
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) =>
        operation(
          {
            async *iterMessages() {
              for (const item of album) yield item;
            },
            downloadMedia: async () => {
              downloads += 1;
              return Buffer.from([1, 2, 3]);
            },
            sendMessage: async () => ({ id: 1 }),
            deleteMessages: async () => {},
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p describe" });
  assert.equal(downloads, 4, "only four album images are downloaded");
  assert.ok(
    replies.some(text => text.includes("部分图片")),
    "the album drop is disclosed in Chinese",
  );
});

test("AI01 a large video thumb is fetched by thumb size, not the whole video", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-thumb-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  const sharp = require(path.join(core, "node_modules/sharp"));
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
    .png()
    .toBuffer();
  const fetched = [];
  const bodies = [];
  const thumb = { className: "PhotoSize", size: 2048, w: 320, h: 240 };
  const reply = {
    id: 2,
    chatId: "chat",
    text: "",
    raw: {
      media: {
        className: "MessageMediaDocument",
        document: { className: "Document", mimeType: "video/mp4", size: BigInt("30000000"), thumbs: [thumb] },
      },
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) =>
        operation(
          {
            downloadMedia: async (_raw, options) => {
              fetched.push(options?.thumb ? "thumb" : "full");
              return options?.thumb ? png : Buffer.from("big");
            },
            sendMessage: async () => ({ id: 1 }),
            deleteMessages: async () => {},
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p describe" });
  assert.deepEqual(fetched, ["thumb"], "the small thumb is downloaded and the huge video is not");
  assert.match(bodies[0], /data:image\/png;base64/, "the thumb is sent as an image input");
});

test("AI01 oversized document is rejected before download", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-bigdoc-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  let downloads = 0;
  const reply = {
    id: 2,
    chatId: "chat",
    text: "CONTEXT",
    raw: {
      media: {
        className: "MessageMediaDocument",
        document: { className: "Document", mimeType: "image/png", size: 30 * 1024 * 1024 },
      },
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) =>
        operation(
          {
            downloadMedia: async () => {
              downloads += 1;
              return Buffer.from([1]);
            },
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p describe" });
  assert.equal(downloads, 0, "declared oversize document is never downloaded");
});

// ---------------------------------------------------------------------------
// AI05: real Gemini / Doubao video protocols
// ---------------------------------------------------------------------------

test("AI05 Gemini video posts the original endpoint/body and polls to completion", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-veo-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        v: {
          tag: "v",
          url: "https://generativelanguage.googleapis.com",
          key: "veo-key",
          type: "gemini",
          stream: false,
          responses: false,
          models: { video: "veo-2.0-generate-001" },
        },
      },
      currentVideoTag: "v",
      currentVideoModel: "veo-2.0-generate-001",
      videoAudio: true,
      videoDuration: 12,
      videoPreview: true,
    }),
  );
  const calls = [];
  const bytes = Buffer.from("veo-bytes").toString("base64");
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? String(init.body) : undefined,
        });
        if (String(url).includes(":generateVideos"))
          return new Response(JSON.stringify({ name: "operations/abc" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (String(url).includes("operations/abc"))
          return new Response(
            JSON.stringify({ done: true, response: { generatedVideos: [{ video: { videoBytes: bytes } }] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async () => undefined,
      withClient: async (operation, signal) =>
        operation({ sendFile: async () => ({ id: 1 }), deleteMessages: async () => {} }, signal),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p video a cat" });
  const post = calls.find(call => call.url.includes(":generateVideos"));
  assert.ok(post, "Gemini generateVideos endpoint is used");
  assert.match(post.url, /veo-2\.0-generate-001:generateVideos/);
  assert.match(post.url, /key=veo-key/);
  const body = JSON.parse(post.body);
  assert.deepEqual(body.videoGenerationConfig, { numberOfVideos: 1, durationSeconds: 12, enableAudio: true });
  assert.equal(body.contents[0].parts[0].text, "a cat");
  assert.ok(
    calls.some(call => call.url.includes("operations/abc")),
    "operation poll runs",
  );
});

test("AI05 Doubao video posts roles/audio/duration and polls the task", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-doubao-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        d: {
          tag: "d",
          url: "https://ark.example.com",
          key: "ark-key",
          type: "doubao",
          stream: false,
          responses: false,
          models: { video: "doubao-seedance-1-0" },
        },
      },
      currentVideoTag: "d",
      currentVideoModel: "doubao-seedance-1-0",
      videoAudio: false,
      videoDuration: 8,
      videoPreview: true,
    }),
  );
  const calls = [];
  const reply = {
    id: 2,
    chatId: "chat",
    text: "",
    raw: { groupedId: 7n, media: { className: "MessageMediaPhoto" }, chatId: "chat", peerId: "chat" },
  };
  const album = [
    { id: 2, groupedId: 7n, media: { className: "MessageMediaPhoto" } },
    { id: 3, groupedId: 7n, media: { className: "MessageMediaPhoto" } },
  ];
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? String(init.body) : undefined,
        });
        if (String(url).endsWith("/tasks"))
          return new Response(JSON.stringify({ task_id: "task-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (String(url).endsWith("/tasks/task-1"))
          return new Response(
            JSON.stringify({ status: "succeeded", content: { video_url: "https://cdn.example.com/v.mp4" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        if (String(url) === "https://cdn.example.com/v.mp4")
          return new Response(Buffer.from("video-bytes"), { status: 200, headers: { "content-type": "video/mp4" } });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async message => (message.id === 1 ? reply : undefined),
      withClient: async (operation, signal) =>
        operation(
          {
            sendFile: async () => ({ id: 1 }),
            deleteMessages: async () => {},
            async *iterMessages() {
              for (const item of album) yield item;
            },
            downloadMedia: async () => Buffer.from([1, 2, 3]),
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({
    id: 1,
    chatId: "chat",
    senderId: "1",
    outgoing: true,
    text: "!p video firstlast two frames",
  });
  const createCall = calls.find(call => call.url.endsWith("/tasks"));
  assert.ok(createCall, "Doubao task endpoint is used");
  assert.equal(createCall.url, "https://ark.example.com/api/v3/contents/generations/tasks");
  const body = JSON.parse(createCall.body);
  assert.equal(body.model, "doubao-seedance-1-0");
  assert.equal(body.generateAudio, false);
  assert.equal(body.duration, 8);
  const roles = body.content.filter(item => item.type === "image_url").map(item => item.role);
  assert.deepEqual(roles, ["first_frame", "last_frame"], "firstlast maps to first/last roles");
  assert.ok(
    calls.some(call => call.url.endsWith("/tasks/task-1")),
    "task poll runs",
  );
});

test("AI05 Gemini operation failure surfaces as an error without sending media", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-veo-fail-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        v: {
          tag: "v",
          url: "https://generativelanguage.googleapis.com",
          key: "veo-key",
          type: "gemini",
          stream: false,
          responses: false,
          models: { video: "veo-2.0-generate-001" },
        },
      },
      currentVideoTag: "v",
      currentVideoModel: "veo-2.0-generate-001",
      videoAudio: false,
      videoDuration: 5,
      videoPreview: true,
    }),
  );
  let sentFiles = 0;
  const edits = [];
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: {
      fetch: async url => {
        if (String(url).includes(":generateVideos"))
          return new Response(JSON.stringify({ name: "operations/bad" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ done: true, error: { message: "boom" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    telegram: {
      edit: async (_m, text) => {
        edits.push(text);
      },
      reply: async () => {},
      invoke: async () => ({}),
      getReply: async () => undefined,
      withClient: async (operation, signal) =>
        operation(
          {
            sendFile: async () => {
              sentFiles += 1;
              return { id: 1 };
            },
            deleteMessages: async () => {},
          },
          signal,
        ),
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text: "!p video a cat" });
  assert.equal(sentFiles, 0, "failed operation sends no media");
  assert.match(edits.at(-1), /AI 操作失败/, `error feedback: ${edits.at(-1)}`);
});

// ---------------------------------------------------------------------------
// AI01 unified merge budget (reply 3 + own 2) and video mode normalization
// ---------------------------------------------------------------------------
function mediaHost(root, client, fetchImpl, replies) {
  return new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["!"],
    aliases: { p: "ai" },
    logger: { info() {}, error() {} },
    http: { fetch: fetchImpl },
    telegram: {
      edit: async () => {},
      reply: async (_m, text) => {
        replies.push(text);
      },
      invoke: async () => ({}),
      getReply: async () => client.reply,
      withClient: async (operation, signal) => operation(client, signal),
    },
  });
}

async function chatCase({ replyGroup, ownGroup, downloads }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-merge-")));
  await fs.mkdir(path.join(root, "ai"));
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.example.com/v1",
          key: "k",
          stream: false,
          responses: false,
          models: { chat: "gpt-4o" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o",
    }),
  );
  const album = [...replyGroup, ...ownGroup];
  const bodies = [],
    replies = [];
  const client = {
    async *iterMessages() {
      for (const item of album) yield item;
    },
    downloadMedia: async _raw => downloads(),
    sendMessage: async () => ({ id: 1 }),
    deleteMessages: async () => {},
    reply: {
      id: 5,
      chatId: "chat",
      text: "",
      raw: { groupedId: 1n, media: { className: "MessageMediaPhoto" }, chatId: "chat", peerId: "chat" },
    },
  };
  const host = mediaHost(
    root,
    client,
    async (_url, init) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    replies,
  );
  await host.load(create());
  const envelope = {
    id: 1,
    chatId: "chat",
    senderId: "1",
    outgoing: true,
    text: "!p describe",
    raw: ownGroup.length
      ? { groupedId: ownGroup[0].groupedId, media: { className: "MessageMediaPhoto" }, chatId: "chat", peerId: "chat" }
      : undefined,
  };
  await host.dispatchPrimary(envelope);
  return {
    bodies,
    replies,
    cleanup: async () => {
      await host.shutdown(1000);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("AI01 reply 3 + own 2 merges to four images with a Chinese disclosure", async t => {
  const replyGroup = [0, 1, 2].map(index => ({
    id: 10 + index,
    groupedId: 1n,
    media: { className: "MessageMediaPhoto" },
  }));
  const ownGroup = [0, 1].map(index => ({ id: 20 + index, groupedId: 2n, media: { className: "MessageMediaPhoto" } }));
  const f = await chatCase({ replyGroup, ownGroup, downloads: () => Buffer.from([1, 2, 3]) });
  t.after(() => f.cleanup());
  const count = (f.bodies[0].match(/data:image\/jpeg;base64/g) ?? []).length;
  assert.equal(count, 4, "only the first four merged images are sent");
  assert.ok(
    f.replies.some(text => text.includes("部分图片")),
    "the merge drop is disclosed in Chinese",
  );
});

test("AI01 merged byte budget over 20MiB is disclosed even when each side is under", async t => {
  const six = () => Buffer.alloc(6 * 1024 * 1024, 1);
  const replyGroup = [0, 1].map(index => ({
    id: 10 + index,
    groupedId: 1n,
    media: { className: "MessageMediaPhoto" },
  }));
  const ownGroup = [0, 1].map(index => ({ id: 20 + index, groupedId: 2n, media: { className: "MessageMediaPhoto" } }));
  const f = await chatCase({ replyGroup, ownGroup, downloads: six });
  t.after(() => f.cleanup());
  const count = (f.bodies[0].match(/data:image\/jpeg;base64/g) ?? []).length;
  assert.equal(count, 3, "the merged byte budget keeps only three 6MiB images");
  assert.ok(
    f.replies.some(text => text.includes("部分图片")),
    "the byte-budget drop is disclosed",
  );
});

test("AI05 default video with images uses reference roles; explicit firstlast falls back like the original", async t => {
  const photo = (id, groupedId) => ({ id, groupedId, media: { className: "MessageMediaPhoto" } });
  const runVideo = async (text, album) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/ai-vmode-")));
    await fs.mkdir(path.join(root, "ai"));
    await fs.writeFile(
      path.join(root, "ai/config.json"),
      JSON.stringify({
        configs: {
          d: {
            tag: "d",
            url: "https://ark.example.com",
            key: "ark",
            type: "doubao",
            stream: false,
            responses: false,
            models: { video: "doubao-seedance" },
          },
        },
        currentVideoTag: "d",
        currentVideoModel: "doubao-seedance",
        videoAudio: false,
        videoDuration: 5,
        videoPreview: true,
      }),
    );
    const calls = [],
      replies = [];
    const client = {
      async *iterMessages() {
        for (const item of album) yield item;
      },
      downloadMedia: async () => Buffer.from([1, 2, 3]),
      sendMessage: async () => ({ id: 1 }),
      deleteMessages: async () => {},
      sendFile: async () => ({}),
      reply: album.length
        ? {
            id: 5,
            chatId: "chat",
            text: "",
            raw: {
              groupedId: album[0].groupedId,
              media: { className: "MessageMediaPhoto" },
              chatId: "chat",
              peerId: "chat",
            },
          }
        : undefined,
    };
    const host = mediaHost(
      root,
      client,
      async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
        if (String(url).endsWith("/tasks"))
          return new Response(JSON.stringify({ task_id: "t" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (String(url).endsWith("/tasks/t"))
          return new Response(JSON.stringify({ status: "succeeded", content: { video_url: "https://cdn/v.mp4" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (String(url) === "https://cdn/v.mp4")
          return new Response(Buffer.from("v"), { status: 200, headers: { "content-type": "video/mp4" } });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
      replies,
    );
    await host.load(create());
    t.after(async () => {
      await host.shutdown(1000);
      await fs.rm(root, { recursive: true, force: true });
    });
    await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text });
    const createCall = calls.find(call => call.url.endsWith("/tasks"));
    return JSON.parse(createCall.body);
  };
  const two = [photo(10, 1n), photo(11, 1n)];
  const rolesOf = body => body.content.filter(item => item.type === "image_url").map(item => item.role);
  assert.deepEqual(
    rolesOf(await runVideo("!p video a clip", two)),
    ["reference_image", "reference_image"],
    "default auto+2 images => reference",
  );
  assert.deepEqual(
    rolesOf(await runVideo("!p video firstlast a clip", [photo(10, 1n)])),
    ["first_frame"],
    "firstlast with one image falls back to first",
  );
  assert.equal(
    rolesOf(await runVideo("!p video firstlast a clip", [])).length,
    0,
    "firstlast with no image falls back to text-only",
  );
  assert.deepEqual(
    rolesOf(await runVideo("!p video firstlast a clip", two)),
    ["first_frame", "last_frame"],
    "explicit firstlast with two images keeps both roles",
  );
});

test("AI04 del targets the displayed record when dirty rows are interleaved", async t => {
  const dirty = { title: "dirty-no-url" }; // filtered out by the read-time snapshot
  const valid = { url: "https://telegra.ph/b", title: "B", createdAt: "2026-01-02" };
  const f = await fixture({ ...CONFIG, telegraph: { enabled: true, limit: 5, list: [dirty, valid] } });
  t.after(() => f.cleanup());
  await f.send("!p telegraph", 1);
  assert.match(f.edits.at(-1).text, /1\. <a href="https:\/\/telegra\.ph\/b">🔗 B<\/a>/);
  assert.ok(!f.edits.at(-1).text.includes("dirty-no-url"), "dirty row is not displayed");

  await f.send("!p telegraph del 1", 2);
  assert.match(f.edits.at(-1).text, /已删除第 1 项/);
  const data = JSON.parse(await f.read());
  assert.deepEqual(data.telegraph.list, [dirty], "the displayed valid record is removed, the dirty row is preserved");
});

test("AI04 telegraph status paginates every record without dropping history", async t => {
  const list = Array.from({ length: 40 }, (_, index) => ({
    url: `https://telegra.ph/post-${index + 1}-with-a-long-slug`,
    title: `R${index + 1}# `.repeat(12).trim(),
    createdAt: "2026-01-01",
  }));
  const f = await fixture({ ...CONFIG, telegraph: { enabled: true, limit: 100, list } });
  t.after(() => f.cleanup());
  const before = await f.read();
  await f.send("!p telegraph", 1);
  const all = f.edits.map(edit => edit.text).join("\n");
  for (let index = 1; index <= 40; index++) assert.ok(all.includes(`R${index}#`), `R${index} visible`);
  assert.ok(f.edits.length > 1, "status paginates");
  for (const edit of f.edits)
    assert.ok(edit.text.length > 0 && edit.text.length <= 3500, `bounded page (${edit.text.length})`);
  assert.equal(await f.read(), before, "status never rewrites config");
});
