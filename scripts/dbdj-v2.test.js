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
    buildPlugin({ id: "dbdj", packageRoot: path.resolve(__dirname, "../dbdj"), entry: "v2.ts" }).artifactDir,
    "index.cjs",
  ),
).default;
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-")),
    edits = [],
    replies = [],
    errors = [],
    peers = [],
    queries = [];
  const signalState = {};
  const client = {
    async getMessages(peer, value) {
      peers.push(peer);
      queries.push(value);
      if (options.getMessages) return options.getMessages(peer, value);
      return options.messages || [];
    },
    async getEntity(id) {
      await options.getEntity?.(id);
      return options.entities?.get(String(id)) || { id, firstName: `User${id}` };
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: options.prefixes,
    aliases: options.aliases,
    logger: {
      info() {},
      error(event) {
        errors.push(event);
      },
    },
    telegram: {
      async edit(message, text) {
        edits.push(text);
      },
      async reply(message, text) {
        replies.push(text);
        await options.reply?.();
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {},
      async withClient(operation, signal) {
        signalState.signal = signal;
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
    client,
    edits,
    errors,
    host,
    peers,
    queries,
    replies,
    run: (text, message = {}) => {
      const raw =
        message.raw === undefined
          ? new Api.Message({
              id: 10,
              peerId: new Api.PeerChannel({ channelId: 123456789012345678n }),
              message: text,
              out: true,
            })
          : message.raw;
      return host.dispatchPrimary({
        id: 10,
        chatId: "-100123456789012345678",
        senderId: "1",
        outgoing: true,
        text,
        raw,
        ...message,
      });
    },
  };
}
test("dbdj preserves legacy winner display, statistics, and botBusiness filtering", async t => {
  let deleted = 0;
  const entities = new Map([
    ["900719925474099312345", { id: 900719925474099312345n, firstName: "Alice", lastName: "W", username: "alice" }],
    ["3", { id: 3n, firstName: "Biz", botBusiness: true }],
  ]);
  const messages = [
    { fromId: new Api.PeerUser({ userId: 900719925474099312345n }) },
    { fromId: new Api.PeerUser({ userId: 3n }) },
  ];
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".dbdj 50 2 好运",
    out: true,
  });
  raw.delete = async () => {
    deleted++;
  };
  const f = await fixture(t, { entities, messages });
  await f.run(".dbdj 50 2 好运", { raw });
  assert.equal(f.replies.length, 1);
  assert.match(
    f.replies[0],
    /^点兵点将, 点到谁\.\.\. Alice W @alice <a href="tg:\/\/user\?id=900719925474099312345">900719925474099312345<\/a> 好运/,
  );
  assert.match(f.replies[0], /• 扫描消息数: 50\n• 有效用户数: 1\n• 选中人数: 1\n• 选中概率: 100%/);
  assert.equal(deleted, 1);
});
test("dbdj treats the known Teleproto missing-date history failure as an empty result", async t => {
  let deleted = 0;
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".dbdj 20 1",
    out: true,
  });
  raw.delete = async () => {
    deleted++;
  };
  const f = await fixture(t, {
    getMessages: async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'date')");
    },
  });
  await f.run(".dbdj 20 1", { raw });
  assert.match(f.replies[0], /未在最近的 <code>20<\/code> 条消息中找到可抽取的有效用户/);
  assert.equal(deleted, 1);
  assert.deepEqual(f.errors, []);
});
test("dbdj command deletion is best effort after a successful reply", async t => {
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".dbdj 20 1",
    out: true,
  });
  raw.delete = async () => {
    throw new Error("private delete detail");
  };
  const f = await fixture(t, { messages: [{ fromId: new Api.PeerUser({ userId: 2n }) }] });
  await f.run(".dbdj 20 1", { raw });
  assert.equal(f.replies.length, 1);
  assert.deepEqual(f.edits, ["点兵点将..."]);
  assert.deepEqual(f.errors, ["dbdj_delete_failed"]);
});
test("dbdj resolves an exact large chat id when raw peer metadata is absent", async t => {
  const f = await fixture(t, { messages: [] });
  await f.run(".dbdj 20 1", { raw: null, chatId: "-100900719925474099312345" });
  assert.equal(f.peers[0].toString(), "-100900719925474099312345");
  assert.notEqual(typeof f.peers[0], "number");
});
test("dbdj unload during the reply prevents deletion and late failure feedback", async t => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let deleted = 0;
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".dbdj 20 1",
    out: true,
  });
  raw.delete = async () => {
    deleted++;
  };
  const f = await fixture(t, {
    messages: [{ fromId: new Api.PeerUser({ userId: 2n }) }],
    reply: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const running = f.run(".dbdj 20 1", { raw });
  await entered.promise;
  const unloading = f.host.unload("dbdj");
  release.resolve();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(deleted, 0);
  assert.equal(
    f.edits.some(text => /失败/.test(text)),
    false,
  );
});
test("dbdj preserves legacy numeric coercion, first-line note parsing, and invalid-input cleanup", async t => {
  let deleted = 0;
  const raw = new Api.Message({
    id: 10,
    peerId: new Api.PeerChannel({ channelId: 123n }),
    message: ".dbdj 2.9 1.8 第一行\n第二行",
    out: true,
  });
  raw.delete = async () => {
    deleted++;
  };
  const f = await fixture(t, { messages: [{ fromId: new Api.PeerUser({ userId: 2n }) }] });
  await f.run(raw.message, { raw });
  assert.match(f.replies[0], /第一行\n\n📊/);
  assert.doesNotMatch(f.replies[0], /第二行/);
  assert.match(f.replies[0], /扫描消息数: 2/);
  await f.run(".dbdj nope 1", { raw });
  assert.match(f.replies.at(-1), /^用法:/);
  assert.equal(deleted, 2);
});
test("dbdj trusts routed arguments for non-default prefixes and multi-word aliases", async t => {
  const f = await fixture(t, {
    prefixes: ["!"],
    aliases: { "pick winners": "dbdj 12 2 injected" },
    messages: [{ fromId: new Api.PeerUser({ userId: 2n }) }, { fromId: new Api.PeerUser({ userId: 3n }) }],
  });
  assert.equal(await f.run("!pick winners user note"), true);
  assert.equal(f.queries[0].limit, 12);
  assert.match(f.replies[0], /injected user note/);
  await f.run("!dbdj nope 1");
  assert.match(f.replies.at(-1), /用法: <code>!dbdj/);
});
test("dbdj paginates 100 long escaped winners without dropping names or statistics", async t => {
  const messages = [],
    entities = new Map();
  for (let i = 1; i <= 100; i++) {
    const id = BigInt(i + 1000),
      name = `Winner_${i}_${"x".repeat(55)}&`;
    messages.push({ fromId: new Api.PeerUser({ userId: id }) });
    entities.set(String(id), { id, firstName: name });
  }
  const f = await fixture(t, { messages, entities });
  await f.run(".dbdj 100 100");
  assert.ok(f.replies.length > 1);
  assert.equal(
    f.replies.every(page => page.length <= 3500),
    true,
  );
  const output = f.replies.join("\n");
  for (let i = 1; i <= 100; i++) {
    assert.match(output, new RegExp(`Winner_${i}_`));
    assert.ok(output.includes(`href="tg://user?id=${i + 1000}"`));
  }
  assert.match(output, /Winner_1_[^\n]*&amp;/);
  assert.match(output, /• 有效用户数: 100/);
  assert.match(output, /• 选中人数: 100/);
});
