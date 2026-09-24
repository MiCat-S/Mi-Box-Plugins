"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({ id: "bizhi", packageRoot: path.resolve(__dirname, "../bizhi"), entry: "v2.ts" });
const createBizhi = require(path.join(artifactDir, "index.cjs")).default;

async function fixture(t, fetch, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-bizhi-v2-")));
  const edits = [],
    files = [],
    requests = [],
    errors = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event) {
        errors.push(event);
      },
    },
    http: {
      fetch: async (url, init) => {
        requests.push(new URL(url));
        return fetch(new URL(url), init);
      },
    },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {
        return undefined;
      },
      async withClient(operation, signal) {
        return operation(
          {
            async sendFile(peer, value) {
              files.push({ peer, value });
              await options.sendFile?.(peer, value);
            },
          },
          signal,
        );
      },
    },
  });
  await host.load(createBizhi());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    errors,
    files,
    host,
    requests,
    run: (text, message = {}) =>
      host.dispatchPrimary({
        id: 1,
        chatId: "1",
        senderId: "1",
        outgoing: true,
        text,
        raw: { peerId: {} },
        ...message,
      }),
  };
}

test("bizhi downloads and sends a qualified Wallhaven image", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc")
      return Response.json({
        data: [
          {
            id: "abc",
            path: "https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg",
            dimension_x: 2560,
            dimension_y: 1440,
            file_size: 4 * 1024 * 1024,
            file_type: "image/jpeg",
          },
        ],
      });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi dongman");
  assert.equal(f.files.length, 1);
  const search = f.requests.find(url => url.hostname === "wallhaven.cc");
  assert.equal(search.searchParams.get("categories"), "010");
  assert.equal(search.searchParams.get("purity"), "100");
  assert.equal(search.searchParams.get("per_page"), "24");
  assert.equal(search.searchParams.get("atleast"), "1920x1080");
  assert.equal(search.searchParams.get("ratios"), "16x9");
  const tags = search.searchParams.get("q").split("+");
  assert.ok(tags.length === 1 || tags.length === 2);
  assert.equal(
    tags.every(tag => ["anime", "illustration", "digital painting", "Studio Ghibli", "anime screenshot"].includes(tag)),
    true,
  );
  if (search.searchParams.has("page"))
    assert.ok(Number(search.searchParams.get("page")) >= 1 && Number(search.searchParams.get("page")) <= 3);
  assert.match(f.files[0].value.caption, /2560×1440/);
  assert.equal(f.files[0].value.forceDocument, false);
  assert.equal(
    f.requests.some(url => url.hostname === "w.wallhaven.cc"),
    true,
  );
});

test("bizhi falls back to btstu when Wallhaven is unavailable", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc") return new Response("down", { status: 503 });
    if (url.hostname === "api.btstu.cn")
      return Response.json({ code: "200", imgurl: "https://img.btstu.cn/example.jpg" });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi -f");
  assert.equal(f.files.length, 1);
  assert.match(f.files[0].value.caption, /btstu\.cn/);
  assert.equal(f.files[0].value.forceDocument, true);
});

test("bizhi preserves legacy permissive arguments and fallback category spelling", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc") return new Response("down", { status: 503 });
    if (url.hostname === "api.btstu.cn")
      return Response.json({ code: "200", imgurl: "https://img.btstu.cn/example.jpg" });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi Custom -unknown");
  assert.equal(f.files.length, 1);
  const fallback = f.requests.find(url => url.hostname === "api.btstu.cn");
  assert.equal(fallback.searchParams.get("lx"), "Custom");
  assert.equal(f.files[0].value.forceDocument, false);
});

test("bizhi retries a low-quality Wallhaven result at 2560x1440", async t => {
  let searches = 0;
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc") {
      searches++;
      if (searches === 1)
        return Response.json({
          data: [
            {
              id: "low",
              path: "https://w.wallhaven.cc/full/lo/wallhaven-low.jpg",
              dimension_x: 1920,
              dimension_y: 1080,
              file_size: 1024,
              file_type: "image/jpeg",
            },
          ],
        });
      assert.equal(url.searchParams.get("atleast"), "2560x1440");
      return Response.json({
        data: [
          {
            id: "high",
            path: "https://w.wallhaven.cc/full/hi/wallhaven-high.jpg",
            dimension_x: 3840,
            dimension_y: 2160,
            file_size: 5 * 1024 * 1024,
            file_type: "image/jpeg",
          },
        ],
      });
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi");
  assert.equal(searches, 2);
  assert.match(f.files[0].value.file.name, /wallhaven_high_3840x2160/);
});

test("bizhi preserves legacy captions and replies to the forum topic root", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc")
      return Response.json({
        data: [
          {
            id: "abc",
            path: "https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg",
            dimension_x: 2560,
            dimension_y: 1440,
            file_size: 4 * 1024 * 1024,
            file_type: "image/jpeg",
          },
        ],
      });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi", { replyToId: 52, topicId: 40, raw: { peerId: {}, replyTo: { replyToTopId: 40 } } });
  assert.equal(f.files[0].value.replyTo, 40);
  assert.match(f.files[0].value.caption, /^📸 来源: https:\/\/w\.wallhaven\.cc\//);
  assert.match(f.files[0].value.caption, /\n📊 2560×1440, 4MB$/);
});

test("bizhi keeps transport failure details out of chat", async t => {
  const f = await fixture(t, async () => new Response("down", { status: 503 }));
  await f.run(".bizhi");
  assert.equal(f.edits.at(-1).text, "获取壁纸失败，请稍后重试");
});

test("bizhi treats command-message deletion as best effort after a successful send", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc")
      return Response.json({
        data: [
          {
            id: "abc",
            path: "https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg",
            dimension_x: 2560,
            dimension_y: 1440,
            file_size: 4 * 1024 * 1024,
            file_type: "image/jpeg",
          },
        ],
      });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi", {
    raw: {
      peerId: {},
      async delete() {
        throw new Error("private path");
      },
    },
  });
  assert.equal(f.files.length, 1);
  assert.deepEqual(
    f.edits.map(value => value.text),
    ["正在获取高品质壁纸..."],
  );
  assert.deepEqual(f.errors, ["bizhi_delete_failed"]);
});

test("bizhi does not delete or send late feedback when unloaded during upload", async t => {
  const uploadStarted = Promise.withResolvers();
  const uploadFinished = Promise.withResolvers();
  const f = await fixture(
    t,
    async url => {
      if (url.hostname === "wallhaven.cc")
        return Response.json({
          data: [
            {
              id: "abc",
              path: "https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg",
              dimension_x: 2560,
              dimension_y: 1440,
              file_size: 4 * 1024 * 1024,
              file_type: "image/jpeg",
            },
          ],
        });
      return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    },
    {
      sendFile: async () => {
        uploadStarted.resolve();
        await uploadFinished.promise;
      },
    },
  );
  let deleted = 0;
  const raw = {
    peerId: {},
    async delete() {
      deleted++;
    },
  };
  const operation = f.run(".bizhi", { raw });
  await uploadStarted.promise;
  const unloading = f.host.unload("bizhi");
  uploadFinished.resolve();
  assert.equal((await unloading).completed, true);
  await operation;
  assert.equal(deleted, 0);
  assert.deepEqual(
    f.edits.map(value => value.text),
    ["正在获取高品质壁纸..."],
  );
  assert.deepEqual(f.errors, []);
});

test("bizhi preserves a large chat id when raw peer metadata is unavailable", async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === "wallhaven.cc")
      return Response.json({
        data: [
          {
            id: "abc",
            path: "https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg",
            dimension_x: 2560,
            dimension_y: 1440,
            file_size: 4 * 1024 * 1024,
            file_type: "image/jpeg",
          },
        ],
      });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  await f.run(".bizhi", { chatId: "900719925474099312345", raw: undefined });
  assert.equal(f.files[0].peer.toString(), "900719925474099312345");
});
