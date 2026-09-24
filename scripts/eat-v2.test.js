"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs/promises"),
  os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  Api = require(path.join(core, "node_modules/teleproto")).Api;
const create = require(
  path.join(
    buildPlugin({ id: "eat", packageRoot: path.resolve(__dirname, "../eat"), entry: "v2.ts" }).artifactDir,
    "index.cjs",
  ),
).default;
const svg = (width = 64, height = 64, color = "red") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`,
  );
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eat-v2-")),
    edits = [],
    sends = [],
    errors = [],
    requests = [],
    downloads = [];
  const config = options.config || {
    resources: {
      stamp: { name: "盖章 &", url: "eat/stamp.svg", stamp: { size: 64, scale: 0.5, rotate: 0, opacity: 0.5 } },
    },
  };
  const fetch =
    options.fetch ||
    (async url => {
      requests.push(new URL(url));
      if (String(url).endsWith("/config.json")) return Response.json(config);
      return new Response(svg(), { headers: { "content-type": "image/svg+xml" } });
    });
  const replyRaw = new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    fromId: new Api.PeerUser({ userId: 900719925474099312345n }),
    message: "reply",
    media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: 1n }) }),
  });
  const reply = {
    id: 7,
    chatId: "-100123",
    senderId: "900719925474099312345",
    outgoing: false,
    text: "reply",
    raw: replyRaw,
  };
  const client = {
    async downloadProfilePhoto(target) {
      downloads.push({ kind: "profile", target });
      return svg();
    },
    async downloadMedia(target, value) {
      downloads.push({ kind: "media", target, value });
      return svg(64, 64, "blue");
    },
    async sendFile(peer, value) {
      sends.push({ peer, value });
      await options.sendFile?.();
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: options.prefixes,
    logger: {
      info() {},
      error(event) {
        errors.push(event);
      },
    },
    http: { fetch },
    telegram: {
      async edit(message, text) {
        edits.push(text);
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {
        return reply;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    downloads,
    edits,
    errors,
    host,
    requests,
    sends,
    run: (text, message = {}) =>
      host.dispatchPrimary({
        id: 10,
        chatId: "-100900719925474099312345",
        senderId: "42",
        outgoing: true,
        text,
        replyToId: 7,
        raw: null,
        ...message,
      }),
  };
}

test("eat and eat2 expose help with the active prefix", async t => {
  const f = await fixture(t, { prefixes: ["!"] });
  await f.run("!eat --help", { replyToId: undefined });
  await f.run("!eat2 --help", { replyToId: undefined });
  assert.equal(f.edits.length, 2);
  for (const text of f.edits) {
    assert.match(text, /<code>!eat<\/code>/);
    assert.match(text, /<code>!eat2<\/code>/);
  }
});

test("eat preserves list, forced config refresh, unknown-name, and random selection flows", async t => {
  const f = await fixture(t);
  await f.run(".eat", { replyToId: undefined });
  assert.match(f.edits.at(-1), /^当前表情包：\nstamp - 盖章 &$/);
  await f.run(".eat set https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/config.json", {
    replyToId: undefined,
  });
  assert.match(f.edits.at(-1), /^✅ 已强制更新表情包配置/);
  await f.run(".eat missing");
  assert.match(f.edits.at(-1), /^找不到 missing 该表情包/);
  await f.run(".eat");
  assert.equal(f.sends.length, 1);
});

test("eat uses an exact reply sender id and sends real sticker TL attributes", async t => {
  const f = await fixture(t);
  await f.run(".eat stamp");
  assert.equal(f.downloads[0].kind, "profile");
  assert.equal(f.downloads[0].target.toString(), "900719925474099312345");
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].peer.toString(), "-100900719925474099312345");
  assert.equal(f.sends[0].value.replyTo, 7);
  assert.ok(f.sends[0].value.attributes[0] instanceof Api.DocumentAttributeSticker);
  for (const attribute of f.sends[0].value.attributes) assert.ok(attribute.getBytes().length > 4);
});

test("eat2 consumes replied media and keeps image thumbnail selection", async t => {
  const f = await fixture(t);
  await f.run(".eat2 stamp");
  assert.equal(f.downloads[0].kind, "media");
  assert.equal(f.downloads[0].value.thumb, 1);
  assert.equal(f.sends.length, 1);
});

test("stamp templates keep the original direct image path and ignore role overlays", async t => {
  const config = {
    resources: {
      stamp: {
        name: "Stamp",
        url: "eat/stamp.svg",
        me: { x: 0, y: 0, mask: "eat/missing-me.svg" },
        you: { x: 0, y: 0, mask: "eat/missing-you.svg" },
        stamp: { size: 64 },
      },
    },
  };
  const f = await fixture(t, { config });
  await f.run(".eat2 stamp");
  assert.equal(f.sends.length, 1);
  assert.deepEqual(
    f.downloads.map(item => item.kind),
    ["media"],
  );
  assert.equal(
    f.requests.some(url => url.pathname.includes("missing-")),
    false,
  );
});

test("overlay templates preserve exact reply and command sender ids", async t => {
  const config = {
    resources: {
      pair: {
        name: "Pair",
        url: "eat/base.svg",
        me: { x: 0, y: 0, mask: "eat/mask.svg" },
        you: { x: 0, y: 0, mask: "eat/mask.svg" },
      },
    },
  };
  const f = await fixture(t, { config });
  await f.run(".eat pair", { senderId: "900719925474099399999" });
  assert.equal(f.sends.length, 1);
  assert.deepEqual(
    f.downloads.map(item => item.target.toString()),
    ["900719925474099312345", "900719925474099399999"],
  );
});

test("bounded HTTP reads accept short chunks without truncating configuration", async t => {
  const body = JSON.stringify({ resources: { stamp: { name: "Chunked", url: "eat/stamp.svg", stamp: { size: 64 } } } });
  const chunks = [...body].map(character => new TextEncoder().encode(character));
  const f = await fixture(t, {
    fetch: async url =>
      String(url).endsWith("/config.json")
        ? new Response(
            new ReadableStream({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk) controller.enqueue(chunk);
                else controller.close();
              },
            }),
          )
        : new Response(svg()),
  });
  await f.run(".eat", { replyToId: undefined });
  assert.equal(f.edits.at(-1), "当前表情包：\nstamp - Chunked");
});

test("eat rejects an oversized decoded mask before sending", async t => {
  const config = {
    resources: { huge: { name: "Huge", url: "eat/base.svg", you: { x: 0, y: 0, mask: "eat/huge.svg" } } },
  };
  const f = await fixture(t, {
    config,
    fetch: async url =>
      String(url).endsWith("/config.json")
        ? Response.json(config)
        : new Response(String(url).endsWith("/huge.svg") ? svg(100000, 100000) : svg()),
  });
  await f.run(".eat huge");
  assert.equal(f.sends.length, 0);
  assert.equal(f.edits.at(-1), "表情包生成失败，请确认回复内容和远程素材可用");
  assert.deepEqual(f.errors, ["eat_failed"]);
});

test("eat cancels and releases a pending HTTP reader on unload without late feedback", async t => {
  let cancelled = false;
  const started = Promise.withResolvers();
  const stream = new ReadableStream({
    pull() {
      started.resolve();
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = await fixture(t, { fetch: async () => new Response(stream) });
  const running = f.run(".eat stamp");
  await started.promise;
  while (!stream.locked) await new Promise(resolve => setImmediate(resolve));
  const unloading = f.host.unload("eat");
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.deepEqual(f.edits, []);
  assert.equal(f.sends.length, 0);
});

test("eat treats command deletion as best effort after a successful send", async t => {
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".eat stamp",
    out: true,
  });
  raw.delete = async () => {
    throw new Error("private deletion detail");
  };
  const f = await fixture(t);
  await f.run(".eat stamp", { raw });
  assert.equal(f.sends.length, 1);
  assert.equal(
    f.edits.some(text => /生成失败/.test(text)),
    false,
  );
  assert.deepEqual(f.errors, ["eat_delete_failed"]);
});

test("cancellation during upload never deletes the command or reports a late failure", async t => {
  const uploadStarted = Promise.withResolvers(),
    releaseUpload = Promise.withResolvers();
  let deletes = 0;
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".eat stamp",
    out: true,
  });
  raw.delete = async () => {
    deletes += 1;
  };
  const f = await fixture(t, {
    sendFile: async () => {
      uploadStarted.resolve();
      await releaseUpload.promise;
    },
  });
  const running = f.run(".eat stamp", { raw });
  await uploadStarted.promise;
  const unloading = f.host.unload("eat");
  releaseUpload.resolve();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(deletes, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.edits.some(text => /生成失败/.test(text)),
    false,
  );
});

test("business failures expose only fixed feedback and log events", async t => {
  const f = await fixture(t, {
    sendFile: async () => {
      const error = new Error("private message");
      error.name = "PrivateName";
      error.code = "PRIVATE_CODE";
      throw error;
    },
  });
  await f.run(".eat stamp");
  assert.equal(f.edits.at(-1), "表情包生成失败，请确认回复内容和远程素材可用");
  assert.deepEqual(f.errors, ["eat_failed"]);
  assert.equal(
    f.edits.some(text => /PrivateName|PRIVATE_CODE|private message/.test(text)),
    false,
  );
});
