"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "news",
  packageRoot: process.env.NEWS_PACKAGE_ROOT || path.resolve(__dirname, "../news"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

test("news parses bounded data and escapes rich text", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-news-v2-")));
  const edits = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              newsList: [{ title: "<headline>", url: "https://example.com/a" }],
              historyList: [{ event: "历史事件" }],
              phrase: { phrase: "成语", explain: "解释" },
              sentence: { sentence: "名言", author: "作者" },
            },
          }),
          { status: 200 },
        ),
    },
    telegram: {
      async edit(m, text, options) {
        edits.push({ text, options });
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
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "owner", outgoing: true, text: ".news" });
  assert.match(edits.at(-1).text, /&lt;headline&gt;/);
  assert.match(edits.at(-1).text, /历史事件/);
  assert.equal(edits.at(-1).options.parseMode, "html");
});

test("news retains all entries and poem across valid rich-text pages", async () => {
  const output = [];
  const data = {
    newsList: Array.from({ length: 20 }, (_, i) => ({ title: `headline-${i}`, url: `https://example.com/${i}` })),
    historyList: [{ event: "first-history" }, { event: "last-history" }],
    poem: { title: "poem-title", author: "poem-author", content: ["<&😀".repeat(2000), "poem-end"] },
  };
  const send = async (_, text) => output.push(text);
  await create().commands.news.handle(
    { args: [], message: {}, prefix: ".", command: "news" },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      telegram: { edit: send, reply: send },
      http: {
        withResponse: async (_url, _init, consume) => consume(Response.json({ data }), new AbortController().signal),
      },
    },
  );
  const pages = output.slice(1);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.ok(page.length <= 3500);
    for (const tag of ["a", "b", "i"]) {
      assert.equal(
        (page.match(new RegExp(`<${tag}(?:\\s[^>]+)?>`, "g")) || []).length,
        (page.match(new RegExp(`</${tag}>`, "g")) || []).length,
      );
    }
  }
  const combined = pages.join("\n");
  assert.match(combined, /headline-19/);
  assert.match(combined, /last-history/);
  assert.match(combined, /poem-end/);
  for (const token of ["&lt;", "&amp;", "😀"]) {
    assert.equal(combined.split(token).length - 1, 2000);
  }
});

test("news rejects unknown arguments without requesting content", async () => {
  const output = [];
  await create().commands.news.handle(
    { args: ["invalid"], message: {} },
    {
      telegram: { edit: async (_, text) => output.push(text) },
      http: { withResponse: () => assert.fail("unexpected HTTP") },
    },
  );
  assert.match(output[0], /未知参数/);
});

test("news actively cancels a hung reader and waits for its cleanup", async () => {
  const controller = new AbortController();
  let ready,
    release,
    cancelled = 0,
    settled = false;
  const started = new Promise(r => (ready = r)),
    gate = new Promise(r => (release = r)),
    edits = [];
  const context = {
    signal: controller.signal,
    log: { error() {} },
    telegram: { edit: async (_m, text) => edits.push(text), reply: async () => {} },
    http: {
      withResponse: async (_u, _i, consume) =>
        consume(
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
          controller.signal,
        ),
    },
  };
  const running = create()
    .commands.news.handle({ args: [], message: {}, prefix: ".", command: "news" }, context)
    .finally(() => (settled = true));
  await started;
  controller.abort();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(cancelled, 1);
  assert.equal(settled, false);
  release();
  await running;
  assert.deepEqual(edits, ["📰 正在获取今日资讯…"]);
});

test("news keeps its first page on later delivery failure and emits fixed events", async () => {
  const data = { poem: { title: "t", author: "a", content: ["字<&😀".repeat(1800)] } },
    controller = new AbortController(),
    edits = [],
    replies = [],
    logs = [];
  let failed = false;
  await create().commands.news.handle(
    { args: [], message: {}, prefix: ".", command: "news" },
    {
      signal: controller.signal,
      log: {
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
      http: { withResponse: async (_u, _i, consume) => consume(Response.json({ data }), controller.signal) },
      telegram: {
        edit: async (_m, text) => edits.push(text),
        reply: async (_m, text) => {
          if (!text.includes("已发送") && !failed++) throw new Error("PRIVATE");
          replies.push(text);
        },
      },
    },
  );
  assert.equal(edits.length, 2);
  assert.match(replies.at(-1), /已发送 1\/\d+ 页/);
  assert.deepEqual(logs, [{ event: "news_result_delivery_failed", fields: undefined }]);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});

test("news reports HTTP errors with fixed events and messages", async () => {
  const edits = [],
    logs = [],
    secret = "PRIVATE_SECRET";
  await create().commands.news.handle(
    { args: [], message: {}, prefix: ".", command: "news" },
    {
      signal: new AbortController().signal,
      log: {
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
      http: {
        withResponse: async () => {
          throw Object.assign(new Error(secret), { name: secret });
        },
      },
      telegram: { edit: async (_m, text) => edits.push(text) },
    },
  );
  assert.deepEqual(logs, [{ event: "news_request_failed", fields: undefined }]);
  assert.match(edits.at(-1), /今日资讯获取失败/);
  assert.doesNotMatch(JSON.stringify({ edits, logs }), new RegExp(secret));
});
