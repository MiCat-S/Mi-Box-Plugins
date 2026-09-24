"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
function plugin() {
  const { artifactDir } = buildPlugin({
    id: "duckduckgo",
    packageRoot: path.resolve(__dirname, "../duckduckgo"),
    entry: "v2.ts",
  });
  const entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}
async function fixture(t, fetch) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-ddg-compat-"))),
    edits = [],
    replies = [],
    requests = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      maxResponseBytes: 2 * 1024 * 1024,
      fetch: async (url, init) => {
        requests.push(new URL(url));
        return fetch(new URL(url), init);
      },
    },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply(_message, text) {
        replies.push(text);
      },
      async invoke() {},
      async getReply() {},
      async withClient() {},
    },
  });
  await host.load(plugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    edits,
    replies,
    requests,
    run: text => host.dispatchPrimary({ id: 1, chatId: "7", senderId: "7", outgoing: true, text }),
  };
}

test("duckduckgo falls back after an ordinary primary failure and delivers every bounded page", async t => {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    url: `https://example.com/result-${index + 1}?q=${"a".repeat(700)}`,
    title: `Result ${index + 1} ${"&".repeat(80)}`,
    description: `Snippet ${index + 1} ${"<".repeat(180)}`,
  }));
  const f = await fixture(t, async url => {
    if (url.hostname === "html.duckduckgo.com") throw new Error("primary-secret");
    return Response.json({ data: { web: rows } });
  });
  await f.run(".ddg -n 15 query");
  const pages = [f.edits.at(-1), ...f.replies],
    output = pages.join("\n");
  assert.deepEqual(
    f.requests.map(url => url.hostname),
    ["html.duckduckgo.com", "api.firecrawl.dev"],
  );
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3600 && page.isWellFormed()));
  for (let index = 1; index <= 15; index++) assert.match(output, new RegExp(`<b>${index}\\.</b>`));
  assert.match(output, /15 条/);
  assert.match(output, /在 DuckDuckGo 打开/);
  assert.doesNotMatch(output, /primary-secret/);
});

test("duckduckgo unload cancels and closes an in-flight HTTP reader without an error edit", async t => {
  let readerStarted,
    cancelled = false;
  const started = new Promise(resolve => {
    readerStarted = resolve;
  });
  const f = await fixture(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>"));
            readerStarted();
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const running = f.run(".ddg query");
  await started;
  assert.equal((await f.host.unload("duckduckgo", 2000)).completed, true);
  await running;
  assert.equal(cancelled, true);
  assert.equal(f.edits.filter(text => /搜索失败/.test(text)).length, 0);
  assert.equal(f.replies.length, 0);
});

test("duckduckgo reports an oversized HTTP response with a fixed error", async t => {
  const body = "x".repeat(2 * 1024 * 1024 + 1);
  const f = await fixture(t, async () => new Response(body));
  await f.run(".ddg query");
  assert.equal(f.edits.at(-1), "❌ 搜索失败，请稍后重试");
  assert.doesNotMatch(f.edits.join("\n"), /byte limit|RESPONSE_TOO_LARGE/);
});
