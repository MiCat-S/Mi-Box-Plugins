"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const sharp = require(path.join(core, "node_modules/sharp"));
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { artifactDir } = buildPlugin({ id: "quote", packageRoot: path.resolve(__dirname, "../quote"), entry: "v2.ts" });
const built = require(path.join(artifactDir, "index.cjs"));

async function seed(root) {
  const dir = path.join(root, "quote");
  await fs.mkdir(path.join(dir, "emoji"), { recursive: true });
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#405060" } })
    .png()
    .toBuffer();
  for (const name of ["pattern_02.png", "pattern_ny.png"]) await fs.writeFile(path.join(dir, name), png);
  for (const [index, brand] of ["apple", "google", "twitter", "joypixels", "blob"].entries()) {
    const icon = await sharp({
      create: { width: 16, height: 16, channels: 4, background: ["red", "blue", "green", "yellow", "purple"][index] },
    })
      .png()
      .toBuffer();
    await fs.writeFile(
      path.join(dir, "emoji", `emoji-${brand}-image.json`),
      JSON.stringify({ "😀": icon.toString("base64") }),
    );
  }
  // Unit fixtures exercise resource reuse; real Noto glyph rendering is checked separately.
  for (const name of ["NotoSansCJK-Regular.ttc", "NotoSansCJK-Bold.ttc"])
    await fs.writeFile(path.join(dir, name), "unit-font-placeholder");
}
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quote-host-v2-")));
  await seed(root);
  const sent = [],
    edits = [],
    logs = [],
    queries = [];
  let deleted = 0;
  const peer = new Api.PeerChannel({ channelId: 123n });
  const author = { id: "9007199254740993", firstName: "Alice" };
  const raw = { className: "Message", id: 7, peerId: peer, message: "Original quote", sender: author, ...options.raw };
  const native = {
    async getMessages(p, q) {
      queries.push(q);
      return options.history ?? [];
    },
    async sendFile(p, o) {
      if (options.sendFile) return options.sendFile(p, o);
      const buffer = await fs.readFile(o.file);
      sent.push({ peer: p, options: o, buffer, metadata: await sharp(buffer).metadata() });
    },
    async deleteMessages() {
      deleted++;
      if (options.deleteFails) throw new Error("SECRET_DELETE");
    },
    async downloadProfilePhoto() {
      return undefined;
    },
    async *iterDownload() {
      if (options.media) yield options.media;
    },
    ...options.native,
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: [options.prefix ?? "."],
    logger: {
      info(event) {
        logs.push(event);
      },
      error(event) {
        logs.push(event);
      },
    },
    http: {
      async fetch() {
        throw new Error("unexpected network");
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply(_m, text) {
        edits.push(text);
      },
      async invoke() {
        throw new Error("unexpected invoke");
      },
      async getReply() {
        if (options.getReply) return options.getReply();
        if (options.noReply) return;
        return {
          id: 7,
          chatId: "-100123",
          senderId: author.id,
          text: raw.message,
          raw: options.rawlessReply ? undefined : raw,
        };
      },
      async withClient(operation, signal) {
        return operation(native, signal);
      },
    },
  });
  await host.load(built.default());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const run = (args = "", extra = {}) =>
    host.dispatchPrimary({
      id: 9,
      chatId: "-100123",
      senderId: "1",
      outgoing: true,
      text: `${options.prefix ?? "."}q ${args}`,
      replyToId: options.noReply ? undefined : 7,
      raw: { id: 9, peerId: peer, message: `.q ${args}`, sender: { id: "1", firstName: "Me" } },
      ...extra,
    });
  return {
    host,
    run,
    sent,
    edits,
    queries,
    logs,
    root,
    get deleted() {
      return deleted;
    },
  };
}

test("quote parser retains original defaults, clamp, permissive tokens and color syntax", () => {
  const p = built.parseOptions([]);
  assert.equal(p.scale, 2);
  assert.equal(p.media, false);
  assert.equal(p.count, 1);
  assert.equal(p.background, "#231d2b/#372e44");
  assert.equal(built.parseOptions(["stories", "image"]).format, "story");
  assert.equal(built.parseOptions(["image", "webp"]).imagePreview, true);
  assert.equal(built.parseOptions(["51"]).count, 50);
  assert.equal(built.parseOptions(["0"]).count, 1);
  assert.equal(built.parseOptions(["-999"]).count, -50);
  assert.equal(built.parseOptions(["nonsense"]).format, "webp");
  assert.equal(built.parseOptions(["scale=20"]).scale, 20);
  assert.equal(built.parseOptions(["s=5", "s=0"]).scale, 5);
  assert.equal(built.parseOptions(["abc/def"]).background, "#abc/#def");
  assert.equal(built.parseOptions(["//#123"]).background, "//#123");
  assert.equal(built.parseOptions(["brand=google"]).emojiBrand, "google");
  assert.ok(built.wantsHelp(["image", "帮助"]));
  assert.equal(built.default().commands.q.subcommands?.fake, undefined);
});
test("help uses the active prefix and performs no native work", async t => {
  const f = await fixture(t, {
    prefix: "!!",
    native: {
      async getMessages() {
        assert.fail("help reads no history");
      },
    },
  });
  await f.run("image help");
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /!!quote/);
  assert.match(f.edits.at(-1), /720×1280/);
});
test("default quote uses vendor WebP output and deletes only after delivery", async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.sent.length, 1, JSON.stringify(f.edits));
  assert.equal(f.sent[0].metadata.format, "webp");
  assert.ok(f.sent[0].metadata.width <= 512 && f.sent[0].metadata.height <= 512);
  assert.equal(f.sent[0].options.replyTo, 7);
  assert.equal(f.deleted, 1);
  assert.ok(f.sent[0].options.attributes[0].getBytes().length);
});
test("image and stories use the original background renderer and story dimensions", async t => {
  const a = await fixture(t),
    b = await fixture(t);
  await a.run("image bg=#123456");
  await b.run("stories bg=#654321");
  assert.equal(a.sent[0].metadata.format, "png");
  assert.deepEqual([b.sent[0].metadata.width, b.sent[0].metadata.height], [720, 1280]);
  assert.equal(a.sent[0].options.attributes, undefined);
  assert.equal(b.sent[0].options.attributes, undefined);
});
test("direct positive count queries older messages without including the command", async t => {
  const f = await fixture(t, {
    noReply: true,
    history: [{ id: 6, message: "Earlier", sender: { id: "2", firstName: "B" } }],
  });
  await f.run("3");
  assert.deepEqual(f.queries[0], { offsetId: 9, limit: 3 });
  assert.equal(f.sent[0].options.replyTo, 9);
});
test("signed reply ranges retain original offsets and exact reply anchor", async t => {
  for (const [arg, expected] of [
    ["3", { offsetId: 6, limit: 3, reverse: true }],
    ["-3", { offsetId: 8, limit: 3 }],
  ]) {
    const f = await fixture(t);
    await f.run(arg);
    assert.deepEqual(f.queries[0], expected);
    assert.equal(f.sent[0].options.replyTo, 7);
  }
});
test("rawless reply and rawless command keep their envelope data and precise peer", async t => {
  const f = await fixture(t, { rawlessReply: true });
  await f.run("", { raw: undefined, chatId: "-1009007199254740993" });
  assert.equal(f.sent.length, 1);
  assert.equal(String(f.sent[0].peer), "-1009007199254740993");
  assert.equal(f.sent[0].options.replyTo, 7);
});
test("command cleanup failure cannot turn delivered media into a generation failure", async t => {
  const f = await fixture(t, { deleteFails: true });
  await f.run();
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.includes("quote_command_cleanup_failed"));
  assert.doesNotMatch(f.edits.join(""), /引用生成失败|SECRET_DELETE/);
});
test("formatting entities change vendor output rather than being discarded", async t => {
  const plain = await fixture(t, { raw: { message: "formatted text" } }),
    bold = await fixture(t, {
      raw: { message: "formatted text", entities: [new Api.MessageEntityBold({ offset: 0, length: 9 })] },
    });
  await plain.run();
  await bold.run();
  assert.equal(plain.sent.length, 1);
  assert.equal(bold.sent.length, 1);
  assert.equal(plain.sent[0].buffer.equals(bold.sent[0].buffer), false);
});
test("high scale is accepted syntactically and fails before an over-budget canvas is allocated", async t => {
  const f = await fixture(t, { raw: { message: "large ".repeat(100) } });
  await f.run("scale=20");
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /引用生成失败/);
});
test("native failures have fixed public feedback", async t => {
  const f = await fixture(t, {
    sendFile: async () => {
      throw new Error("token=PRIVATE/path");
    },
  });
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /引用生成失败/);
  assert.doesNotMatch(JSON.stringify([f.edits, f.logs]), /PRIVATE|token=/);
});
test("unload cancels pending reply retrieval without late send or cleanup", async t => {
  let release, entered;
  const gate = new Promise(r => (release = r)),
    ready = new Promise(r => (entered = r));
  const f = await fixture(t, {
    getReply: async () => {
      entered();
      await gate;
      return;
    },
  });
  const work = f.run();
  await ready;
  const unloading = f.host.unload("quote", 1000);
  release();
  await work;
  assert.equal((await unloading).completed, true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted, 0);
});

test("renderer cannot swallow a canvas-budget violation and publish an incomplete quote", async () => {
  const artifact = buildPlugin({
    id: "quote-canvas-check",
    packageRoot: path.resolve(__dirname, "../quote"),
    entry: "vendor/canvas.js",
  });
  const canvas = require(path.join(artifact.artifactDir, "index.cjs"));
  await assert.rejects(
    canvas.withCanvasBudget(new AbortController().signal, async () => {
      try {
        canvas.createCanvas(5000, 5000);
      } catch {}
      return Buffer.from("partial");
    }),
    /QUOTE_CANVAS_BUDGET/,
  );
});
