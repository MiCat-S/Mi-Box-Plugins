"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const artifact = buildPlugin({ id: "zpr", packageRoot: path.resolve(__dirname, "../zpr"), entry: "v2.ts" }).artifactDir,
  create = require(path.join(artifact, "index.cjs")).default;
const api = {
  data: [
    {
      pid: 123,
      title: "A < B",
      width: 1000,
      height: 800,
      urls: { regular: "https://i.pximg.net/image.jpg", original: "https://i.pximg.net/original.jpg" },
    },
  ],
};
async function fixture(t, fetchImpl, legacy, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-zpr-")));
  if (legacy || options.v2) {
    await fs.mkdir(path.join(root, "zpr"));
    if (legacy) await fs.writeFile(path.join(root, "zpr", "zpr_config.json"), JSON.stringify(legacy));
    if (options.v2) await fs.writeFile(path.join(root, "zpr", "v2-config.json"), options.v2);
  }
  const edits = [],
    replies = [],
    sent = [],
    requests = [];
  let deleted = 0;
  const raw = {
    peerId: "peer",
    async delete() {
      if (options.delete) return options.delete();
      deleted++;
    },
  };
  const client = {
    async sendFile(peer, sendOptions) {
      if (options.sendFile) await options.sendFile(peer, sendOptions);
      sent.push({ peer, options: sendOptions });
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async (u, i) => {
        requests.push(new URL(u));
        return fetchImpl(u, i);
      },
    },
    telegram: {
      async edit(m, text) {
        edits.push(text);
      },
      async reply(_m, text) {
        replies.push(text);
      },
      async invoke() {},
      async getReply() {},
      async withClient(fn, signal) {
        return fn(client, signal);
      },
    },
  });
  await host.load(options.plugin ?? create());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    root,
    edits,
    replies,
    sent,
    requests,
    deleted: () => deleted,
    run: (text, extra = {}) =>
      host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text, raw, ...extra }),
  };
}
test("zpr migrates legacy proxy idempotently and validates settings", async t => {
  const f = await fixture(t, async () => assert.fail("network"), { zpr_proxy_host: "i.pixiv.cat" });
  assert.equal((await f.host.readSettings("zpr")).values.proxyHost, "i.pixiv.cat");
  await assert.rejects(f.host.patchSettings("zpr", { proxyHost: "evil.test" }));
  await f.host.unload("zpr", 1000);
  await f.host.load(create());
  assert.equal((await f.host.readSettings("zpr")).values.proxyHost, "i.pixiv.cat");
});
test("zpr validates API data, bounds image download and sends escaped media", async t => {
  const f = await fixture(t, async u =>
    new URL(u).hostname === "api.lolicon.app"
      ? Response.json(api)
      : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  await f.run(".zpr 标签 1 r18");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.spoiler, true);
  assert.equal(f.sent[0].options.replyTo, undefined);
  assert.equal(f.sent[0].options.topMsgId, undefined);
  assert.match(f.sent[0].options.caption, /A &lt; B/);
  assert.deepEqual(
    f.requests.map(x => x.hostname),
    ["api.lolicon.app", "i.pximg.net"],
  );
});
test("zpr blocks redirect escapes and reports external failure", async t => {
  let calls = 0;
  const f = await fixture(t, async u => {
    calls++;
    if (new URL(u).hostname === "api.lolicon.app")
      return new Response(null, { status: 302, headers: { location: "https://evil.example/data" } });
    return new Response("x");
  });
  await f.run(".zpr");
  assert.equal(calls, 1);
  assert.match(f.edits.at(-1), /获取图片失败/);
  assert.equal(f.sent.length, 0);
});
test("zpr retries only allowlisted image hosts and reloads cleanly", async t => {
  const f = await fixture(t, async u => {
    const host = new URL(u).hostname;
    if (host === "api.lolicon.app") return Response.json(api);
    if (host === "i.pximg.net") throw Object.assign(new Error("secret"), { code: "ECONNRESET" });
    return new Response(Buffer.from("ok"), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".zpr");
  assert.deepEqual(f.requests.map(x => x.hostname).slice(0, 3), ["api.lolicon.app", "i.pximg.net", "i.pixiv.cat"]);
  assert.equal((await f.host.readSettings("zpr")).values.proxyHost, "i.pixiv.cat");
  await f.host.unload("zpr", 1000);
  await f.host.load(create());
  assert.equal(f.host.pluginState("zpr"), "active");
});
test("zpr cancels an in-flight API request on unload", async t => {
  let began;
  const started = new Promise(resolve => {
    began = resolve;
  });
  const f = await fixture(t, async (_url, init) => {
    began();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new Error("private network detail")), { once: true }),
    );
  });
  const running = f.run(".zpr");
  await started;
  assert.equal((await f.host.unload("zpr", 1000)).completed, true);
  await running;
  assert.equal(f.host.pluginState("zpr"), undefined);
  assert.doesNotMatch(f.edits.join("\n"), /private network detail/);
});

test("zpr unload waits for a hanging response-reader cancellation", async t => {
  let pullStarted,
    releaseCancel,
    rejectRead,
    locked = false;
  const pulled = new Promise(resolve => (pullStarted = resolve)),
    cancelled = new Promise(resolve => (releaseCancel = resolve));
  const reader = {
    read() {
      pullStarted();
      return new Promise((_resolve, reject) => (rejectRead = reject));
    },
    cancel() {
      rejectRead?.(new DOMException("aborted", "AbortError"));
      return cancelled;
    },
    releaseLock() {
      locked = false;
    },
  };
  const body = {
    get locked() {
      return locked;
    },
    getReader() {
      locked = true;
      return reader;
    },
    async cancel() {},
  };
  const response = { status: 200, headers: new Headers({ "content-type": "application/json" }), body };
  const f = await fixture(t, async () => response);
  let settled = false;
  const running = f.run(".zpr").then(() => {
    settled = true;
  });
  await pulled;
  const unloading = f.host.unload("zpr", 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseCancel();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(f.host.pluginState("zpr"), undefined);
});

test("zpr cancellation after sendFile performs no command deletion", async t => {
  let sendStarted, releaseSend;
  const started = new Promise(resolve => (sendStarted = resolve)),
    gate = new Promise(resolve => (releaseSend = resolve));
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(api)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    {
      sendFile: async () => {
        sendStarted();
        await gate;
      },
    },
  );
  const running = f.run(".zpr");
  await started;
  const unloading = f.host.unload("zpr", 1000);
  releaseSend();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(f.deleted(), 0);
});

test("zpr command deletion failure does not report delivered media as failed", async t => {
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(api)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    {
      delete: async () => {
        throw new Error("raw delete secret");
      },
    },
  );
  await f.run(".zpr");
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.edits.at(-1), /获取图片失败/);
});

test("zpr preserves delivered media when a later upload fails", async t => {
  const many = { data: [api.data[0], { ...api.data[0], pid: 124, title: "second" }] };
  let uploads = 0;
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(many)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    {
      sendFile: async () => {
        if (++uploads === 2) throw new Error("upload secret");
      },
    },
  );
  await f.run(".zpr 2");
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.edits.at(-1), /获取图片失败/);
  assert.match(f.replies.at(-1), /已发送 1 张/);
  assert.match(f.replies.at(-1), /后续图片投递失败/);
  assert.doesNotMatch(f.replies.at(-1), /secret|临时文件清理未完成/);
});

test("zpr releases a reader and late-opened handle when unload cancels open", async t => {
  let openStarted,
    releaseOpen,
    closed = false;
  const started = new Promise(resolve => (openStarted = resolve)),
    gate = new Promise(resolve => (releaseOpen = resolve));
  const plugin = create({
    openFile: async () => {
      openStarted();
      await gate;
      return {
        async write() {
          throw new Error("must not write after abort");
        },
        async close() {
          closed = true;
        },
      };
    },
  });
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(api)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    { plugin },
  );
  const running = f.run(".zpr");
  await started;
  const unloading = f.host.unload("zpr", 1000);
  releaseOpen();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(closed, true);
  assert.equal(f.sent.length, 0);
});

test("zpr loops through short file writes and preserves reply plus topic routing", async t => {
  let written = 0,
    calls = 0;
  const plugin = create({
    openFile: async () => ({
      async write(_value, _offset, length) {
        calls++;
        const bytesWritten = Math.min(2, length);
        written += bytesWritten;
        return { bytesWritten, buffer: Buffer.alloc(0) };
      },
      async close() {},
    }),
  });
  const payload = Buffer.from("1234567"),
    f = await fixture(
      t,
      async u =>
        new URL(u).hostname === "api.lolicon.app"
          ? Response.json(api)
          : new Response(payload, { status: 200, headers: { "content-type": "image/jpeg" } }),
      undefined,
      { plugin },
    );
  await f.run(".zpr", { replyToId: 41, topicId: 99 });
  assert.equal(written, payload.length);
  assert.ok(calls > 1);
  assert.equal(f.sent[0].options.replyTo, 41);
  assert.equal(f.sent[0].options.topMsgId, 99);
});

test("zpr reports temp cleanup failure after delivery as partial success", async t => {
  const plugin = create({
    withTemp: async (context, operation) => {
      await context.files.withTemp(operation);
      throw new Error("cleanup secret");
    },
  });
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(api)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    { plugin },
  );
  await f.run(".zpr");
  assert.equal(f.sent.length, 1);
  assert.match(f.replies.at(-1), /已发送 1 张/);
  assert.match(f.replies.at(-1), /临时文件清理未完成/);
  assert.doesNotMatch(f.replies.at(-1), /secret|后续图片投递失败/);
});

test("zpr treats an invalid later public URL as partial delivery", async t => {
  const many = {
    data: [
      api.data[0],
      {
        ...api.data[0],
        pid: 124,
        urls: { regular: "https://i.pximg.net/two.jpg", original: "https://evil.example/private" },
      },
    ],
  };
  const f = await fixture(t, async u =>
    new URL(u).hostname === "api.lolicon.app"
      ? Response.json(many)
      : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  await f.run(".zpr 2");
  assert.equal(f.sent.length, 1);
  assert.match(f.replies.at(-1), /已发送 1 张/);
  assert.doesNotMatch(f.edits.at(-1), /获取图片失败/);
});

test("zpr rejects a zero-byte file write instead of looping forever", async t => {
  let writes = 0;
  const plugin = create({
    openFile: async () => ({
      async write() {
        writes++;
        return { bytesWritten: 0, buffer: Buffer.alloc(0) };
      },
      async close() {},
    }),
  });
  const f = await fixture(
    t,
    async u =>
      new URL(u).hostname === "api.lolicon.app"
        ? Response.json(api)
        : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    undefined,
    { plugin },
  );
  await f.run(".zpr");
  assert.equal(writes, 4);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /获取图片失败/);
});

test("zpr explicit V2 proxy wins over legacy and an imported document is not rewritten", async t => {
  const explicit = JSON.stringify(
    { schemaVersion: 1, proxyHost: "i.pximg.net", legacyImported: false, future: { owner: "v2" } },
    null,
    2,
  );
  const f = await fixture(t, async () => assert.fail("network"), { zpr_proxy_host: "i.pixiv.cat" }, { v2: explicit });
  assert.equal((await f.host.readSettings("zpr")).values.proxyHost, "i.pximg.net");
  const migrated = JSON.parse(await fs.readFile(path.join(f.root, "zpr", "v2-config.json"), "utf8"));
  assert.deepEqual(migrated.future, { owner: "v2" });
  assert.equal(migrated.legacyImported, true);
  const stable =
    JSON.stringify(
      { schemaVersion: 1, proxyHost: "i.pixiv.re", legacyImported: true, future: { bytes: "unchanged" } },
      null,
      4,
    ) + "\n";
  const second = await fixture(
    t,
    async () => assert.fail("network"),
    { zpr_proxy_host: "i.pixiv.cat" },
    { v2: stable },
  );
  assert.equal(await fs.readFile(path.join(second.root, "zpr", "v2-config.json"), "utf8"), stable);
  assert.equal((await second.host.readSettings("zpr")).values.proxyHost, "i.pixiv.re");
});
