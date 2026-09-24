"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fsp = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api, utils } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
function load() {
  const { artifactDir } = buildPlugin({ id: "dme", packageRoot: path.resolve(__dirname, "../dme"), entry: "v2.ts" });
  delete require.cache[require.resolve(path.join(artifactDir, "index.cjs"))];
  return require(path.join(artifactDir, "index.cjs")).default();
}
const me = new Api.User({ id: returnBigInt("9007199254740993"), accessHash: returnBigInt(2), firstName: "Me" }),
  chat = new Api.Chat({
    id: returnBigInt(7),
    title: "Group",
    photo: new Api.ChatPhotoEmpty(),
    participantsCount: 2,
    date: 0,
    version: 1,
  });
function input(value) {
  if (value instanceof Api.InputPeerUser || value instanceof Api.InputPeerChat) return value;
  if (value instanceof Api.Chat || value instanceof Api.PeerChat)
    return new Api.InputPeerChat({ chatId: value.id ?? value.chatId });
  return new Api.InputPeerUser({ userId: value.id ?? value, accessHash: me.accessHash });
}
async function fixture(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mibot-dme-compat-")));
  if (options.setupRoot) await options.setupRoot(root);
  const edits = [],
    deleted = [],
    requests = [],
    sent = [],
    uploads = [],
    logs = [];
  let searchCalls = 0,
    historyCalls = 0,
    fetches = 0;
  const client = {
    async getMe() {
      return me;
    },
    async getEntity() {
      return chat;
    },
    async getInputEntity(value) {
      return input(value);
    },
    async *iterDialogs() {},
    async deleteMessages(_peer, ids) {
      deleted.push([...ids]);
      if (options.deleteError) throw options.deleteError;
    },
    async uploadFile(value) {
      uploads.push(value.file);
      return new Api.InputFile({ id: returnBigInt(1), parts: 1, name: "x", md5Checksum: "" });
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
      return { id: 1 };
    },
    async invoke(request) {
      requests.push(request);
      await request.resolve({ getInputEntity: async value => input(value) }, utils);
      request.getBytes();
      if (request instanceof Api.messages.Search) {
        searchCalls++;
        return options.search?.(searchCalls) ?? { messages: [] };
      }
      if (request instanceof Api.messages.GetHistory) {
        historyCalls++;
        return options.history?.(historyCalls) ?? { messages: [] };
      }
      if (request instanceof Api.updates.GetState) return {};
      if (request instanceof Api.messages.EditMessage) return {};
      return { peers: [] };
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event) {
        logs.push({ level: "error", event });
      },
    },
    http: {
      fetch: async () => {
        fetches++;
        return options.fetch ? options.fetch() : new Response("", { status: 404 });
      },
    },
    telegram: {
      async edit(message, text, settings) {
        edits.push({ message, text, settings });
      },
      async reply() {},
      async invoke(request) {
        return client.invoke(request);
      },
      async getReply() {},
      async withClient(fn, signal) {
        return fn(client, signal);
      },
    },
  });
  await host.load(load());
  t.after(async () => {
    await host.shutdown(2000);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    deleted,
    requests,
    sent,
    uploads,
    logs,
    fetches: () => fetches,
    searchCalls: () => searchCalls,
    historyCalls: () => historyCalls,
    run: (text, message = {}) =>
      host.dispatchPrimary({
        id: 10,
        chatId: "-7",
        senderId: me.id.toString(),
        outgoing: true,
        text,
        ...message,
        raw: { peerId: new Api.PeerChat({ chatId: chat.id }), ...message.raw },
      }),
  };
}

test("legacy missing-count and invalid-count errors retain distinct HTML guidance", async t => {
  const f = await fixture(t);
  await f.run(".dme -f");
  assert.match(f.edits.at(-1).text, /请指定删除数量/);
  assert.equal(f.edits.at(-1).settings.parseMode, "html");
  await f.run(".dme nope");
  assert.match(f.edits.at(-1).text, /删除数量必须为正整数/);
  assert.match(f.edits.at(-1).text, /dme -f/);
});

test("precise identity, topic and command cutoff delete only the eligible prior message", async t => {
  const own = id =>
    new Api.Message({
      id,
      peerId: new Api.PeerChat({ chatId: chat.id }),
      fromId: new Api.PeerUser({ userId: me.id }),
      out: true,
      date: 1,
      message: "mine",
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 55, replyToTopId: 55 }),
    });
  const f = await fixture(t, {
    search: n =>
      n === 1
        ? {
            messages: [
              own(11),
              own(9),
              new Api.Message({
                id: 8,
                peerId: new Api.PeerChat({ chatId: chat.id }),
                fromId: new Api.PeerUser({ userId: me.id }),
                out: true,
                date: 1,
                message: "other topic",
                replyTo: new Api.MessageReplyHeader({ replyToMsgId: 44, replyToTopId: 44 }),
              }),
            ],
          }
        : { messages: [] },
  });
  await f.run(".dme 1", {
    raw: {
      peerId: new Api.PeerChat({ chatId: chat.id }),
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 55, replyToTopId: 55 }),
    },
  });
  assert.deepEqual(
    f.deleted,
    [[10], [9]],
    JSON.stringify({ requests: f.requests.map(x => x.className), logs: f.logs, edits: f.edits, sent: f.sent }),
  );
  assert.equal(f.searchCalls(), 1);
  assert.ok(
    f.requests.every(request => {
      try {
        request.getBytes();
        return true;
      } catch {
        return false;
      }
    }),
  );
});

test("corrupt cache is replaced from bounded streamed PNG and reused", async t => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    png = Buffer.concat([signature, Buffer.from("payload")]);
  const mediaMessage = () =>
    new Api.Message({
      id: 9,
      peerId: new Api.PeerChat({ chatId: chat.id }),
      fromId: new Api.PeerUser({ userId: me.id }),
      out: true,
      date: Math.floor(Date.now() / 1000),
      message: "",
      media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: returnBigInt(1) }) }),
    });
  const f = await fixture(t, {
    setupRoot: async root => {
      await fsp.mkdir(path.join(root, "dme"), { recursive: true });
      await fsp.writeFile(path.join(root, "dme", "dme_troll_image.png"), "corrupt");
    },
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png.subarray(0, 5));
            controller.enqueue(png.subarray(5));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    search: () => ({ messages: [mediaMessage()] }),
  });
  await f.run(".dme -f 1");
  assert.equal(f.fetches(), 1);
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0].buffer, png);
  await f.run(".dme -f 1", { id: 20 });
  assert.equal(f.fetches(), 1);
  assert.deepEqual(await fsp.readFile(path.join(f.root, "dme", "dme_troll_image.png")), png);
});

test("oversized cached image is discarded before reading and replaced", async t => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    png = Buffer.concat([signature, Buffer.from("replacement")]);
  const media = new Api.Message({
    id: 9,
    peerId: new Api.PeerChat({ chatId: chat.id }),
    fromId: new Api.PeerUser({ userId: me.id }),
    out: true,
    date: Math.floor(Date.now() / 1000),
    message: "",
    media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: returnBigInt(1) }) }),
  });
  const f = await fixture(t, {
    setupRoot: async root => {
      const file = path.join(root, "dme", "dme_troll_image.png");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "x");
      await fsp.truncate(file, 10 * 1024 * 1024 + 1);
    },
    fetch: () => new Response(png, { status: 200 }),
    search: () => ({ messages: [media] }),
  });
  await f.run(".dme -f 1");
  assert.equal(f.fetches(), 1);
  assert.deepEqual(f.uploads[0].buffer, png);
  assert.deepEqual(await fsp.readFile(path.join(f.root, "dme", "dme_troll_image.png")), png);
});

test("oversized streamed image is rejected without upload while deletion continues", async t => {
  const media = new Api.Message({
    id: 9,
    peerId: new Api.PeerChat({ chatId: chat.id }),
    fromId: new Api.PeerUser({ userId: me.id }),
    out: true,
    date: Math.floor(Date.now() / 1000),
    message: "",
    media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: returnBigInt(1) }) }),
  });
  const chunk = new Uint8Array(6 * 1024 * 1024);
  chunk.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const f = await fixture(t, {
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(new Uint8Array(5 * 1024 * 1024));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    search: () => ({ messages: [media] }),
  });
  await f.run(".dme -f 1");
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.deleted, [[10], [9]]);
  assert.match(f.sent.at(-1).value.message, /防撤回编辑失败 1 条/);
});

test("host unload cancels and unlocks a response body blocked in read", async t => {
  let enteredResolve,
    cancels = 0;
  const entered = new Promise(resolve => {
    enteredResolve = resolve;
  });
  const body = new ReadableStream({
    pull() {
      enteredResolve();
      return new Promise(() => {});
    },
    cancel() {
      cancels++;
    },
  });
  const media = new Api.Message({
    id: 9,
    peerId: new Api.PeerChat({ chatId: chat.id }),
    fromId: new Api.PeerUser({ userId: me.id }),
    out: true,
    date: Math.floor(Date.now() / 1000),
    message: "",
    media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: returnBigInt(1) }) }),
  });
  const f = await fixture(t, {
    fetch: () => new Response(body, { status: 200 }),
    search: () => ({ messages: [media] }),
  });
  const running = f.run(".dme -f 1");
  await entered;
  while (!body.locked) await new Promise(resolve => setImmediate(resolve));
  const report = await f.host.unload("dme", 1000);
  assert.equal(report.completed, true);
  await Promise.allSettled([running]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancels, 1);
  assert.equal(body.locked, false);
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.deleted, [[10]]);
  assert.deepEqual(f.sent, []);
});

test("invalid stored batch configuration is normalized before deletion", async t => {
  const own = new Api.Message({
    id: 9,
    peerId: new Api.PeerChat({ chatId: chat.id }),
    fromId: new Api.PeerUser({ userId: me.id }),
    out: true,
    date: 1,
    message: "mine",
  });
  const f = await fixture(t, {
    setupRoot: async root => {
      await fsp.mkdir(path.join(root, "dme"), { recursive: true });
      await fsp.writeFile(
        path.join(root, "dme", "config.json"),
        JSON.stringify({ batchSize: 0, searchLimit: 0, retryAttempts: -1 }),
      );
    },
    search: () => ({ messages: [own] }),
  });
  await f.run(".dme 1");
  assert.deepEqual(f.deleted, [[10], [9]]);
});
