"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({ id: "epic", packageRoot: path.resolve(__dirname, "../epic"), entry: "v2.ts" });
const createEpic = require(path.join(artifactDir, "index.cjs")).default;

function payload(elements) {
  return { data: { Catalog: { searchStore: { elements } } } };
}

function game(overrides = {}) {
  return {
    title: "Control <Ultimate>",
    description: "desc & details",
    categories: [{ path: "freegames" }],
    offerMappings: [{ pageSlug: "control" }],
    price: { totalPrice: { discountPrice: 0, fmtPrice: { originalPrice: "¥198" } } },
    promotions: {
      promotionalOffers: [
        { promotionalOffers: [{ startDate: "2026-09-10T03:00:00Z", endDate: "2026-09-17T03:00:00Z" }] },
      ],
    },
    ...overrides,
  };
}

async function fixture(t, { data = payload([game()]), fetch, prefixes = ["."], onReply } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-epic-v2-")));
  const edits = [],
    replies = [],
    logs = [];
  const host = new PluginHost({
    storageRoot: root,
    prefixes,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event, fields) {
        logs.push({ level: "error", event, fields });
      },
    },
    http: {
      fetch:
        fetch ??
        (async () =>
          new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })),
    },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply(message, text, options) {
        replies.push({ message, text, options });
        await onReply?.(replies.length, text);
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {},
      async withClient() {
        assert.fail("unexpected native client");
      },
    },
  });
  await host.load(createEpic());
  let closed = false;
  t.after(async () => {
    if (!closed) assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    edits,
    replies,
    logs,
    close: async timeout => {
      const result = await host.shutdown(timeout);
      closed = result.completed;
      return result;
    },
    run: text => host.dispatchPrimary({ id: 1, chatId: "123", senderId: "123", outgoing: true, text }),
  };
}

test("epic preserves original current-free-game selection, fallbacks and presentation", async t => {
  const long = "x".repeat(101);
  const current = game({
    description: long,
    offerMappings: [],
    catalogNs: { mappings: [{ pageSlug: "fallback-game" }] },
  });
  const upcoming = game({
    title: "Upcoming",
    price: { totalPrice: { discountPrice: 1999 } },
    promotions: {
      upcomingPromotionalOffers: [
        {
          promotionalOffers: [
            { startDate: "2026-10-01", endDate: "2026-10-08", discountSetting: { discountPercentage: 0 } },
          ],
        },
      ],
    },
  });
  const unrelated = game({ title: "Not free category", categories: [{ path: "games" }] });
  const f = await fixture(t, { data: payload([current, upcoming, unrelated]) });
  await f.run(".epic");
  assert.equal(f.edits[0].text, "🎮 获取 Epic 限免游戏中...");
  const result = f.edits.at(-1);
  assert.match(result.text, /^🎮 <b>Epic Games 限免游戏<\/b>\n\n📢 <b>当前限免:<\/b>/);
  assert.match(result.text, /Control &lt;Ultimate&gt;/);
  assert.match(result.text, /💰 原价: <code>¥198<\/code> → <b>免费<\/b>/);
  assert.match(result.text, /x{100}\.\.\./);
  assert.match(result.text, /https:\/\/store\.epicgames\.com\/zh-CN\/p\/fallback-game/);
  assert.doesNotMatch(result.text, /Upcoming|Not free category/);
  assert.deepEqual(result.options, { parseMode: "html", linkPreview: false });
});

test("epic shows original empty result and escaped dynamic help", async t => {
  const f = await fixture(t, { data: payload([]), prefixes: ["<&"] });
  await f.run("<&epic help");
  assert.match(f.edits[0].text, /Epic 限免游戏/);
  assert.match(f.edits[0].text, /&lt;&amp;epic/);
  await f.run("<&epic");
  assert.match(f.edits.at(-1).text, /📢 <b>当前限免:<\/b> 暂无/);
});

test("epic retains every game using complete valid HTML pagination", async t => {
  const items = Array.from({ length: 45 }, (_, index) =>
    game({
      title: `game-${index}`,
      description: `<&😀-${index}-`.repeat(20),
      offerMappings: [{ pageSlug: `game-${index}` }],
    }),
  );
  const f = await fixture(t, { data: payload(items) });
  await f.run(".epic");
  const pages = [f.edits.at(-1).text, ...f.replies.map(item => item.text)];
  assert.ok(pages.length > 1);
  const combined = pages.join("\n");
  for (let index = 0; index < items.length; index++) assert.match(combined, new RegExp(`game-${index}(?:<|\\b)`));
  for (const page of pages) {
    assert.ok(page.length <= 3500, `page exceeds limit: ${page.length}`);
    for (const tag of ["a", "b", "code"])
      assert.equal(
        (page.match(new RegExp(`<${tag}(?:\\s[^>]+)?>`, "g")) || []).length,
        (page.match(new RegExp(`</${tag}>`, "g")) || []).length,
      );
  }
});

test("epic reports partial pagination safely and does not overwrite published pages", async t => {
  const secret = "sk-secret /Users/private/token";
  const items = Array.from({ length: 45 }, (_, index) =>
    game({ title: `game-${index}`, description: "z".repeat(100) }),
  );
  const f = await fixture(t, {
    data: payload(items),
    onReply(count) {
      if (count === 1) throw new Error(secret);
    },
  });
  await f.run(".epic");
  assert.match(f.edits.at(-1).text, /game-0/);
  assert.doesNotMatch(f.edits.at(-1).text, /获取失败/);
  assert.equal(JSON.stringify({ edits: f.edits, replies: f.replies, logs: f.logs }).includes(secret), false);
  assert.ok(f.logs.some(item => item.event === "pagination_delivery_interrupted"));
});

test("epic cancellation aborts managed HTTP and emits no failure receipt", async t => {
  let requested = false,
    aborted = false;
  const f = await fixture(t, {
    fetch: async (_url, init) => {
      requested = true;
      return new Promise((_, reject) =>
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        ),
      );
    },
  });
  const running = f.run(".epic");
  while (!requested) await new Promise(resolve => setImmediate(resolve));
  const shutdown = f.close(1000);
  await Promise.allSettled([running, shutdown]);
  assert.equal(aborted, true);
  assert.equal(f.edits.length, 1);
  assert.doesNotMatch(f.edits[0].text, /失败/);
});

test("epic consumes a real Host-scoped HTTP response and keeps errors private", async t => {
  let pulls = 0;
  const body = JSON.stringify(payload([game()]));
  const f = await fixture(t, {
    fetch: async (url, init) => {
      assert.equal(
        url.toString(),
        "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN",
      );
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  await f.run(".epic");
  assert.ok(pulls > 0);
  const secret = "https://private.example/?token=secret /Users/private/config";
  const failed = await fixture(t, {
    fetch: async () => {
      throw new Error(secret);
    },
  });
  await failed.run(".epic");
  assert.match(failed.edits.at(-1).text, /获取失败/);
  assert.equal(JSON.stringify({ edits: failed.edits, logs: failed.logs }).includes(secret), false);
});

test("epic truncates descriptions by Unicode code point without splitting emoji", async t => {
  const f = await fixture(t, { data: payload([game({ description: "😀".repeat(101) })]) });
  await f.run(".epic");
  const result = f.edits.at(-1).text;
  assert.equal(result.split("😀").length - 1, 100);
  assert.match(result, /😀\.\.\./);
  assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("epic rejects responses above the SDK JSON body limit", async t => {
  const oversized = JSON.stringify({ ...payload([game()]), padding: "x".repeat(2 * 1024 * 1024) });
  const f = await fixture(t, { fetch: async () => new Response(oversized, { status: 200 }) });
  await f.run(".epic");
  assert.equal(f.edits.at(-1).text, "❌ <b>获取失败:</b> 网络错误");
});

test("epic cancellation stops a hanging response body read", async t => {
  let requested = false,
    cancelStarted = false,
    releaseCancel;
  const cancelGate = new Promise(resolve => {
    releaseCancel = resolve;
  });
  const f = await fixture(t, {
    fetch: async () => {
      requested = true;
      return new Response(
        new ReadableStream({
          pull() {},
          async cancel() {
            cancelStarted = true;
            await cancelGate;
          },
        }),
        { status: 200 },
      );
    },
  });
  const running = f.run(".epic");
  while (!requested) await new Promise(resolve => setImmediate(resolve));
  let shutdownFinished = false;
  const shutdown = f.close(1000).then(result => {
    shutdownFinished = true;
    return result;
  });
  while (!cancelStarted) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownFinished, false, "unload must await the response body cancel promise");
  assert.equal(f.edits.length, 1);
  releaseCancel();
  const [, result] = await Promise.all([running, shutdown]);
  assert.equal(result.completed, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.edits.length, 1, "cancellation must not emit a late failure message");
});

test("epic handles malformed and non-success API responses without exposing details", async t => {
  for (const response of [
    new Response('{"unexpected":true}', { status: 200 }),
    new Response(JSON.stringify(payload([game()])), { status: 503 }),
  ]) {
    const f = await fixture(t, { fetch: async () => response });
    await f.run(".epic");
    assert.equal(f.edits.at(-1).text, "❌ <b>获取失败:</b> 网络错误");
    assert.equal(JSON.stringify({ edits: f.edits, logs: f.logs }).includes("private upstream diagnostic"), false);
  }
});
