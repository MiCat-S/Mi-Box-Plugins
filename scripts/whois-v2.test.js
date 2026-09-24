"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { SqliteStore } = require(path.join(core, "dist/v2/sqlite.js"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({ id: "whois", packageRoot: path.resolve(__dirname, "../whois"), entry: "v2.ts" });
const create = require(path.join(artifactDir, "index.cjs")).default;

async function fixture(t, initial, legacy, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-whois-v2-")));
  if (initial) {
    await fs.mkdir(path.join(root, "whois"));
    await fs.writeFile(path.join(root, "whois/data.json"), JSON.stringify(initial));
  }
  if (legacy) {
    await fs.mkdir(path.join(root, "whois"), { recursive: true });
    await fs.writeFile(path.join(root, "whois/whois_data.json"), JSON.stringify(legacy));
  }
  const edits = [],
    requests = [],
    logs = [];
  let reply,
    replyAttempts = 0;
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    http: {
      fetch: async (url, init) => {
        requests.push(String(url));
        if (options.fetch) return options.fetch(url, init);
        return new Response(
          options.responseText ?? 'data: {"type":"check","data":{"whois":{"whois":"Registrar: Example"}}}\n\n',
          { status: 200 },
        );
      },
    },
    telegram: {
      async edit(message, text, settings) {
        if (options.editFailsOn && String(text).includes(options.editFailsOn)) throw new Error("secret receipt");
        edits.push({ text, options: settings, kind: "edit" });
      },
      async reply(message, text, settings) {
        replyAttempts++;
        if (replyAttempts === options.replyFailsAt) throw new Error("secret delivery");
        edits.push({ text, options: settings, kind: "reply" });
      },
      async invoke() {},
      async getReply() {
        return reply;
      },
      async withClient() {},
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const sql = new SqliteStore(path.join(root, "whois/records.sqlite"));
  t.after(() => sql.close());
  return {
    root,
    sql,
    edits,
    requests,
    logs,
    host,
    setReply(value) {
      reply = value;
    },
    read: () =>
      sql.read(db => ({
        ...JSON.parse(db.prepare("SELECT value FROM metadata WHERE id = 1").get().value),
        history: db
          .prepare("SELECT value FROM history ORDER BY id DESC")
          .all()
          .map(row => JSON.parse(row.value)),
        cache: Object.fromEntries(
          db
            .prepare("SELECT domain, value FROM cache")
            .all()
            .map(row => [row.domain, JSON.parse(row.value)]),
        ),
      })),
    readLegacy: async () => JSON.parse(await fs.readFile(path.join(root, "whois/whois_data.json"), "utf8")),
    reload: async () => {
      await host.unload("whois");
      await host.load(create());
    },
    run: text => host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "owner", outgoing: true, text }),
  };
}

test("whois help and validation stay local", async t => {
  const f = await fixture(t);
  await f.run(".whois help");
  await f.run(".whois bad_input");
  assert.match(f.edits[0].text, /WHOIS/);
  assert.match(f.edits.at(-1).text, /有效域名/);
});

test("whois parses bounded SSE response", async t => {
  const f = await fixture(t);
  await f.run(".whois example.com");
  assert.match(f.edits.at(-1).text, /Registrar: Example/);
  assert.equal(f.edits.at(-1).options.parseMode, "html");
});

test("whois caches results and supports history and clear", async t => {
  const f = await fixture(t);
  await f.run(".whois example.com");
  await f.run(".whois example.com");
  assert.equal(f.edits.filter(item => /WHOIS 结果/.test(item.text)).length, 2);
  await f.run(".whois history");
  assert.match(f.edits.at(-1).text, /example\.com/);
  await f.run(".whois clear");
  assert.match(f.edits.at(-1).text, /历史 1 条/);
});

test("whois batch validates each domain and returns bounded summary", async t => {
  const f = await fixture(t);
  await f.run(".whois batch example.com bad_input example.org");
  assert.match(f.edits.at(-1).text, /批量查询/);
  assert.match(f.edits.at(-1).text, /格式无效/);
  assert.match(f.edits.at(-1).text, /example\.org/);
});

test("whois reply and batch share cached results without duplicate requests", async t => {
  const f = await fixture(t);
  f.setReply({ id: 2, text: "查询 https://www.example.com/path", chatId: "chat" });
  await f.run(".whois");
  assert.equal(f.requests.length, 1);
  await f.run(".whois batch example.com EXAMPLE.COM example.org");
  assert.equal(f.requests.length, 2);
  assert.match(f.edits.at(-1).text, /example\.org/);
  await f.run(".whois clear");
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 3);
});

test("whois expired and future-dated caches are refreshed", async t => {
  for (const queryTime of ["2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z", "invalid"]) {
    const f = await fixture(t, {
      history: [],
      cache: { "example.com": { domain: "example.com", rawData: "stale", queryTime } },
    });
    await f.run(".whois batch example.com");
    assert.equal(f.requests.length, 1);
    await f.run(".whois example.com");
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(f.edits.at(-1).text, /stale/);
  }
});

test("whois imports legacy records once and preserves current data and settings", async t => {
  const item = { domain: "example.com", rawData: "legacy", queryTime: new Date().toISOString() };
  const legacy = {
    history: [item],
    cache: { "example.com": item },
    settings: { cacheHours: 48, maxHistory: 2, enableNotifications: false },
    marker: "keep",
  };
  const current = { ...item, rawData: "current" };
  const f = await fixture(t, { history: [current], cache: { "example.com": current } }, legacy);
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1).text, /current/);
  assert.deepEqual(await f.readLegacy(), legacy);
  assert.equal((await f.read()).history.length, 2);
  assert.equal((await f.read()).marker, "keep");
  await f.run(".whois clear");
  await f.reload();
  assert.equal((await f.read()).history.length, 0);
  assert.equal((await f.read()).settings.cacheHours, 48);
});

test("whois retains legacy cache duration and history limit", async t => {
  const item = {
    domain: "example.com",
    rawData: "cached",
    queryTime: new Date(Date.now() - 25 * 3600000).toISOString(),
  };
  const f = await fixture(t, undefined, {
    history: [item],
    cache: { "example.com": item },
    settings: { cacheHours: 48, maxHistory: 2 },
  });
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 0);
  await f.run(".whois batch example.org example.net example.io");
  assert.equal((await f.read()).history.length, 2);
  assert.equal(f.requests.length, 3);
});

test("whois migration preserves all records, extension fields, order and source snapshots", async t => {
  const history = Array.from({ length: 25 }, (_, i) => ({
    domain: `d${i}.com`,
    queryTime: "2026-09-01T12:34:56Z",
    rawData: `full body ${i}`,
    extra: { index: i },
  }));
  const initial = {
    history,
    cache: Object.fromEntries(history.map(item => [item.domain, item])),
    settings: { maxHistory: 2 },
    extension: ["kept"],
  };
  const f = await fixture(t, initial);
  assert.deepEqual(await f.read(), initial);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "whois/data.json"), "utf8")), initial);
  await f.run(".whois history");
  const output = f.edits.at(-1).text;
  assert.match(output, /共 25 条，缓存 25 个/);
  assert.ok(output.indexOf("d0.com") < output.indexOf("d19.com"));
  assert.doesNotMatch(output, /d20\.com|full body/);
  await f.reload();
  assert.deepEqual(await f.read(), initial);
});

test("whois legacy import deduplicates by complete record and keeps current cache precedence", async t => {
  const a = { domain: "a.com", queryTime: "same", rawData: "a", extra: "first" };
  const b = { ...a, rawData: "b" };
  const f = await fixture(
    t,
    { history: [a, { ...a }], cache: { "a.com": a }, settings: { maxHistory: 1 } },
    { history: [{ ...a, extra: "legacy" }, b], cache: { "a.com": b }, settings: { cacheHours: 48 } },
  );
  const value = await f.read();
  assert.deepEqual(value.history, [a, b]);
  assert.deepEqual(value.cache, { "a.com": a });
  assert.deepEqual(value.settings, { maxHistory: 1, cacheHours: 48 });
});

test("whois can import a legacy file added after initialization exactly once", async t => {
  const f = await fixture(t);
  await f.run(".whois example.com");
  const item = { domain: "legacy.com", rawData: "kept", queryTime: "2000-01-01T00:00:00Z" };
  await fs.writeFile(
    path.join(f.root, "whois/whois_data.json"),
    JSON.stringify({ history: [item], cache: { "legacy.com": item } }),
  );
  await f.reload();
  assert.deepEqual(
    (await f.read()).history.map(row => row.domain),
    ["example.com", "legacy.com"],
  );
  await f.run(".whois clear");
  await f.reload();
  assert.deepEqual((await f.read()).history, []);
  assert.deepEqual((await f.read()).cache, {});
});

test("whois history and cache writes roll back together on a database failure", async t => {
  const f = await fixture(t);
  await f.run(".whois example.com");
  const before = await f.read();
  await f.sql.transaction(db =>
    db.exec(
      "CREATE TRIGGER reject_cache BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
    ),
  );
  await f.run(".whois example.org");
  assert.deepEqual(await f.read(), before);
  assert.match(f.edits.at(-1).text, /未取得 WHOIS 数据/);
  await f.sql.transaction(db => db.exec("DROP TRIGGER reject_cache"));
  await f.run(".whois example.org");
  assert.deepEqual(
    (await f.read()).history.map(row => row.domain),
    ["example.org", "example.com"],
  );
});

test("whois fractional history limit preserves zero-history behavior and complete cache", async t => {
  const f = await fixture(t, { history: [], cache: {}, settings: { maxHistory: 0.5 } });
  await f.run(".whois example.com");
  const data = await f.read();
  assert.deepEqual(data.history, []);
  assert.equal(data.cache["example.com"].rawData, "Registrar: Example");
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 1);
});

test("whois normal commands and reload do not read migrated JSON snapshots", async t => {
  const f = await fixture(t, { history: [], cache: {}, legacyImported: true });
  await fs.writeFile(path.join(f.root, "whois/data.json"), "not json");
  await fs.writeFile(path.join(f.root, "whois/whois_data.json"), "not json");
  await f.run(".whois example.com");
  await f.run(".whois history");
  await f.reload();
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 1);
  assert.equal((await f.read()).history.length, 1);
});

test("whois ordinary lookup prefers the replied message domain over command text", async t => {
  const f = await fixture(t);
  f.setReply({ id: 2, chatId: "chat", text: "source https://www.replied-example.com/path" });
  await f.run(".whois argument-example.com");
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /replied-example\.com/);
  assert.doesNotMatch(f.requests[0], /argument-example/);
});

test("whois preserves published raw pages and emits a fixed interruption notice", async t => {
  const raw = "Registrar: Example\n" + "<secret&😀>".repeat(1600);
  const responseText = `data: ${JSON.stringify({ type: "check", data: { whois: { whois: raw } } })}\n\n`;
  const f = await fixture(t, undefined, undefined, { responseText, replyFailsAt: 1 });
  await f.run(".whois example.com");
  assert.equal(f.requests.length, 1);
  assert.ok(f.edits.some(item => item.kind === "edit" && item.text.includes("WHOIS 结果")));
  assert.match(f.edits.at(-1).text, /已发送 \d+\/\d+ 页/);
  assert.doesNotMatch(f.edits.at(-1).text, /查询失败/);
  assert.ok(f.logs.some(item => item.event === "whois:output-failed"));
  assert.doesNotMatch(JSON.stringify(f.logs), /secret delivery/);
});

test("whois paginates a complete long history", async t => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    domain: `${"a".repeat(220)}${i}.com`,
    rawData: "body",
    queryTime: "2026-09-01T12:34:56Z",
  }));
  const f = await fixture(t, { history, cache: {} });
  await f.run(".whois history");
  assert.ok(f.edits.some(item => item.kind === "reply"));
  const output = f.edits.map(item => item.text).join("");
  assert.match(output, new RegExp(`${"a".repeat(220)}0\\.com`));
  assert.match(output, new RegExp(`${"a".repeat(220)}19\\.com`));
  assert.ok(f.edits.every(item => item.text.length < 4096));
});

test("whois cancellation aborts an in-flight managed HTTP request without an error reply", async t => {
  let startedResolve;
  const started = new Promise(resolve => {
    startedResolve = resolve;
  });
  const f = await fixture(t, undefined, undefined, {
    fetch: async (_url, init) => {
      startedResolve();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    },
  });
  const pending = f.run(".whois example.com");
  await started;
  await f.host.unload("whois", 1000);
  await pending;
  assert.equal(
    f.edits.some(item => String(item.text).includes("WHOIS 查询失败")),
    false,
  );
});

test("whois HELP and H with extra arguments render complete dynamic-prefix help", async t => {
  const f = await fixture(t);
  f.host.replacePrefixes(["<>"]);
  await f.run("<>whois HELP ignored");
  await f.run("<>whois H extra");
  for (const output of f.edits.slice(-2).map(item => item.text)) {
    assert.match(output, /批量查询多个域名/);
    assert.match(output, /&lt;&gt;whois batch/);
    assert.doesNotMatch(output, /<code>whois example\.com<\/code>/);
  }
});

test("whois keeps a completed clear successful when its receipt edit fails", async t => {
  const f = await fixture(t, undefined, undefined, { editFailsOn: "已清除历史" });
  await f.run(".whois example.com");
  await f.run(".whois clear");
  const state = await f.read();
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.cache, {});
  assert.ok(f.logs.some(item => item.event === "whois:receipt-failed"));
  assert.doesNotMatch(JSON.stringify(f.logs), /secret receipt/);
  assert.equal(
    f.edits.some(item => String(item.text).includes("记录清除失败")),
    false,
  );
});
