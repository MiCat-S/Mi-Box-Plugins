"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api, utils } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
function plugin() {
  const { artifactDir } = buildPlugin({
      id: "manage_admin",
      packageRoot: path.resolve(__dirname, "../manage_admin"),
      entry: "v2.ts",
    }),
    entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-manage-admin-"))),
    edits = [],
    replies = [],
    logs = [],
    requests = [];
  const chat =
      options.chat ??
      new Api.Channel({
        id: returnBigInt(10),
        accessHash: returnBigInt(4),
        title: "G",
        megagroup: true,
        photo: new Api.ChatPhotoEmpty(),
        date: 0,
      }),
    user =
      options.user ??
      new Api.User({
        id: returnBigInt("9007199254740993"),
        accessHash: returnBigInt(3),
        firstName: "A<&",
        username: "alice",
      }),
    self = options.self ?? new Api.ChannelParticipantCreator({ userId: returnBigInt(1) });
  let reply = options.reply;
  const client = {
    async getEntity(value) {
      if (options.getEntity) return options.getEntity(value, { chat, user });
      return String(value).includes("peer") ? chat : user;
    },
    async getInputEntity(value) {
      if (value instanceof Api.Channel)
        return new Api.InputChannel({ channelId: value.id, accessHash: value.accessHash });
      if (value instanceof Api.User) return new Api.InputPeerUser({ userId: value.id, accessHash: value.accessHash });
      return value;
    },
    async invoke(request) {
      await request.resolve(client, utils);
      request.getBytes();
      requests.push(request);
      if (options.invoke) return options.invoke(request, { chat, user, self });
      if (request instanceof Api.channels.GetParticipant)
        return {
          participant:
            request.participant instanceof Api.InputPeerSelf
              ? self
              : new Api.ChannelParticipantAdmin({
                  userId: user.id,
                  adminRights: new Api.ChatAdminRights({ banUsers: true }),
                  date: 0,
                  rank: options.rank ?? "",
                }),
        };
      if (request instanceof Api.channels.GetParticipants) return { participants: [], users: [] };
      return {};
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    telegram: {
      async edit(_m, text, sendOptions) {
        edits.push({ text, options: sendOptions });
        if (options.failReceipt && /^已/.test(text)) throw new Error("receipt secret");
      },
      async reply(_m, text) {
        replies.push(text);
      },
      async invoke() {
        assert.fail("port invoke");
      },
      async getReply() {
        return reply;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(plugin());
  t.after(async () => {
    await host.shutdown(3000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    chat,
    user,
    edits,
    replies,
    logs,
    requests,
    setReply: v => (reply = v),
    run: (text, extra = {}) =>
      host.dispatchPrimary({
        id: 1,
        chatId: "-10010",
        senderId: "1",
        outgoing: true,
        text,
        raw: { peerId: "peer", isChannel: true },
        ...extra,
      }),
  };
}

test("manage_admin rejects private, unknown and unauthorized operations without mutation RPC", async t => {
  const privateFixture = await fixture(t);
  await privateFixture.run(".manage_admin add @alice", { chatId: "1", raw: { isPrivate: true } });
  assert.match(privateFixture.edits.at(-1).text, /群组/);
  assert.equal(privateFixture.requests.length, 0);
  const denied = await fixture(t, {
    self: new Api.ChannelParticipantAdmin({
      userId: returnBigInt(1),
      adminRights: new Api.ChatAdminRights({ banUsers: true }),
      date: 0,
    }),
  });
  await denied.run(".manage_admin add @alice");
  assert.match(denied.edits.at(-1).text, /权限不足/);
  assert.ok(!denied.requests.some(value => value instanceof Api.channels.EditAdmin));
  await denied.run(".manage_admin typo");
  assert.match(denied.edits.at(-1).text, /manage_admin add/);
  assert.equal(
    (await denied.host.listSettings()).some(value => value.pluginId === "manage_admin"),
    false,
  );
});

test("manage_admin remove resolves and serializes real TL with exact user id", async t => {
  const f = await fixture(t);
  await f.run(".manage_admin rm 9007199254740993");
  const edit = f.requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.ok(edit);
  assert.equal(String(edit.userId.userId), "9007199254740993");
  assert.equal(edit.adminRights.banUsers, undefined);
  assert.equal(edit.rank, "");
  assert.match(f.edits.at(-1).text, /已移除管理员/);
  assert.match(f.edits.at(-1).text, /A&lt;&amp;/);
});

test("manage_admin reply add preserves spaced title and uses only ban right", async t => {
  const f = await fixture(t, { reply: { id: 8, senderId: "9007199254740993" }, rank: "值班 管理员" });
  await f.run(".manage_admin add 值班 管理员", { replyToId: 8 });
  const edit = f.requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.equal(edit.rank, "值班 管理员");
  assert.equal(edit.adminRights.banUsers, true);
  assert.equal(edit.adminRights.addAdmins, undefined);
  assert.match(f.edits.at(-1).text, /头衔：/);
});

test("manage_admin lists real participant output with precision and safe pagination", async t => {
  const users = Array.from(
      { length: 200 },
      (_, index) =>
        new Api.User({
          id: returnBigInt(String(9007199254741000n + BigInt(index))),
          accessHash: returnBigInt(2),
          firstName: `长名字<&${index}`.repeat(10),
        }),
    ),
    participants = users.map(
      (user, index) =>
        new Api.ChannelParticipantAdmin({
          userId: user.id,
          adminRights: new Api.ChatAdminRights({ banUsers: true }),
          date: 0,
          rank: `R<&${index}`,
        }),
    );
  const f = await fixture(t, {
    invoke(request, { self }) {
      if (request instanceof Api.channels.GetParticipants) return { participants, users };
      if (request instanceof Api.channels.GetParticipant) return { participant: self };
      return {};
    },
  });
  await f.run(".manage_admin list");
  assert.ok(f.replies.length > 0);
  const output = [f.edits.at(-1).text, ...f.replies].join("\n");
  assert.match(output, /9007199254741000/);
  assert.match(output, /长名字&lt;&amp;0/);
  assert.match(output, /R&lt;&amp;0/);
  assert.match(f.edits.at(-1).text, /\n1\/\d+ 页$/);
});

test("manage_admin mutation error is fixed and successful mutation is not reported failed when receipt edit fails", async t => {
  const bad = await fixture(t, {
    invoke(request, { self }) {
      if (request instanceof Api.channels.GetParticipant) return { participant: self };
      if (request instanceof Api.channels.EditAdmin)
        throw Object.assign(new Error("token=secret"), { name: "EVIL_SECRET" });
      return {};
    },
  });
  await bad.run(".manage_admin rm @alice");
  assert.match(bad.edits.at(-1).text, /移除管理员失败，请确认/);
  assert.doesNotMatch(JSON.stringify({ edits: bad.edits, logs: bad.logs }), /token=secret|EVIL_SECRET/);
  const done = await fixture(t, { failReceipt: true });
  await done.run(".manage_admin rm @alice");
  assert.equal(done.requests.filter(value => value instanceof Api.channels.EditAdmin).length, 1);
  assert.ok(done.logs.some(value => value.event === "manage_admin_receipt_failed"));
  assert.ok(!done.edits.some(value => /管理员失败/.test(value.text)));
});

test("manage_admin unload during native resolution prevents permission and mutation RPC", async t => {
  let started, release;
  const ready = new Promise(resolve => (started = resolve)),
    gate = new Promise(resolve => (release = resolve));
  const f = await fixture(t, {
    async getEntity(value, { chat, user }) {
      if (String(value).includes("peer")) {
        started();
        await gate;
        return chat;
      }
      return user;
    },
  });
  const pending = f.run(".manage_admin add @alice", { chatId: "scan" });
  await ready;
  const unloading = f.host.unload("manage_admin", 3000);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(pending, /aborted/i);
  assert.equal(f.requests.length, 0);
  assert.equal(f.edits.filter(value => /权限不足|已设置|设置管理员失败/.test(value.text)).length, 0);
});

test("manage_admin scans channel participants for an uncached numeric target without losing precision", async t => {
  let direct = true;
  const f = await fixture(t, {
    async getEntity(value, { chat, user }) {
      if (String(value).includes("peer")) return chat;
      if (direct) {
        direct = false;
        throw new Error("uncached");
      }
      return user;
    },
    invoke(request, { user, self }) {
      if (request instanceof Api.channels.GetParticipant) return { participant: self };
      if (request instanceof Api.channels.GetParticipants)
        return { participants: [new Api.ChannelParticipant({ userId: user.id, date: 0 })], users: [user] };
      return {};
    },
  });
  await f.run(".manage_admin rm 9007199254740993");
  assert.ok(f.requests.some(value => value instanceof Api.channels.GetParticipants));
  const edit = f.requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.equal(String(edit.userId.userId), "9007199254740993");
});

test("manage_admin uses basic-group EditChatAdmin and truncates titles by code point", async t => {
  const chat = new Api.Chat({
      id: returnBigInt(10),
      title: "Basic",
      photo: new Api.ChatPhotoEmpty(),
      participantsCount: 2,
      date: 0,
      version: 1,
      creator: true,
    }),
    title = "😀".repeat(20);
  const f = await fixture(t, { chat });
  await f.run(`.manage_admin add @alice ${title}`, { raw: { peerId: "peer", isGroup: true } });
  const edit = f.requests.find(value => value instanceof Api.messages.EditChatAdmin);
  assert.ok(edit);
  assert.equal(edit.isAdmin, true);
  assert.ok(!f.requests.some(value => value instanceof Api.channels.EditAdmin));
  assert.equal(f.edits.at(-1).text.isWellFormed(), true);
});

test("manage_admin converts rawless oversized numeric peers and targets with teleproto integers", async t => {
  const chatId = "-1009007199254740993123",
    targetId = "9007199254740993124",
    seen = [],
    user = new Api.User({ id: returnBigInt(targetId), accessHash: returnBigInt(3), firstName: "Exact" });
  const f = await fixture(t, {
    user,
    getEntity(value, { chat, user: resolved }) {
      seen.push(value);
      return String(value) === chatId ? chat : resolved;
    },
  });
  await f.run(`.manage_admin rm ${targetId}`, { chatId, raw: undefined });
  assert.deepEqual(seen.map(String), [chatId, targetId]);
  assert.ok(seen.every(value => typeof value !== "string"));
  const edit = f.requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.equal(String(edit.userId.userId), targetId);
});

test("manage_admin root and unknown paths share the complete plugin guide", async t => {
  const f = await fixture(t);
  await f.run(".manage_admin");
  const root = f.edits.at(-1).text;
  await f.run(".manage_admin unknown");
  const fallback = f.edits.at(-1).text;
  for (const text of [root, fallback]) {
    assert.match(text, /权限与头衔/);
    assert.match(text, /常见提示/);
    assert.match(text, /manage_admin add @username 值班管理员/);
  }
});
