"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api, utils } = require(path.join(core, "node_modules/teleproto"));
const { returnBigInt: integer } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { messageEnvelope } = require(path.join(core, "dist/v2/telegram.js"));

const { artifactDir } = buildPlugin({
  id: "atall",
  packageRoot: path.resolve(__dirname, "../atall"),
  entry: "v2.ts",
});
const createAtAll = require(path.join(artifactDir, "index.cjs")).default;

function rawMessage(text, options = {}) {
  const raw = new Api.Message({
    id: options.id ?? 7,
    peerId: options.peerId ?? new Api.PeerChannel({ channelId: integer("9007199254740993") }),
    out: true,
    post: options.post ?? false,
    date: 1,
    message: text,
    replyTo: options.replyTo,
  });
  Object.defineProperty(raw, "delete", { configurable: true, value: options.deleteReceipt });
  return raw;
}

function envelope(text, options = {}) {
  return messageEnvelope(rawMessage(text, options), { selfId: "42" });
}

const participant = (id, fields = {}) => new Api.User({ id: integer(id), firstName: `成员 ${id}`, ...fields });

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "atall-v2-")));
  const edits = [];
  const replies = [];
  const sent = [];
  const wire = [];
  const logs = [];
  const sourceCalls = [];
  let nativeCalls = 0;
  const values = () =>
    typeof options.participants === "function" ? options.participants() : (options.participants ?? []);

  async function beforeSource() {
    await options.beforeParticipants?.();
    if (options.participantError) throw options.participantError();
  }

  const client = {
    async getParticipants(peer, parameters = {}) {
      sourceCalls.push({ method: "getParticipants", peer, parameters });
      await beforeSource();
      return values();
    },
    async *iterParticipants(peer, parameters = {}) {
      sourceCalls.push({ method: "iterParticipants", peer, parameters });
      await beforeSource();
      const request = new Api.channels.GetParticipants({
        channel: peer,
        filter: new Api.ChannelParticipantsSearch({ q: "" }),
        offset: 0,
        limit: Math.min(parameters.limit ?? 200, 200),
        hash: integer(0),
      });
      await request.resolve(
        {
          async getInputEntity(value) {
            assert.equal(value instanceof Api.PeerChannel, true);
            return new Api.InputPeerChannel({ channelId: value.channelId, accessHash: integer(99) });
          },
        },
        utils,
      );
      wire.push({ request, bytes: request.getBytes() });
      for (const value of values()) yield value;
    },
    async sendMessage(peer, parameters) {
      sent.push({ peer, parameters });
      await options.onSendMessage?.(peer, parameters);
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: options.prefixes ?? ["."],
    aliases: options.aliases ?? {},
    concurrency: 4,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event, fields) {
        logs.push({ level: "error", event, fields });
      },
    },
    telegram: {
      async edit(message, text, messageOptions) {
        edits.push({ message, text, options: messageOptions });
      },
      async reply(message, text, messageOptions) {
        replies.push({ message, text, options: messageOptions });
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {
        return undefined;
      },
      async withClient(operation, signal) {
        nativeCalls += 1;
        return operation(client, signal);
      },
    },
  });
  const definition = createAtAll();
  await host.load(definition);
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    definition,
    host,
    edits,
    replies,
    sent,
    wire,
    logs,
    sourceCalls,
    nativeCalls: () => nativeCalls,
    dispatch: message => host.dispatchPrimary(message),
  };
}

test("uses structured help and discloses the bounded execution policy", async t => {
  const f = await fixture(t, { prefixes: ["<&"] });
  assert.equal(f.definition.apiVersion, 2);
  await f.dispatch(envelope("<&atall help extra", { deleteReceipt: undefined }));
  assert.equal(f.nativeCalls(), 0);
  assert.match(f.edits.at(-1).text, /最多 250 人/);
  assert.match(f.edits.at(-1).text, /10 条消息/);
  assert.match(f.edits.at(-1).text, /同一时间只执行一个/);
  assert.match(f.edits.at(-1).text, /&lt;&amp;atall/);
});

test("rejects real private and broadcast messages before opening the native client", async t => {
  const f = await fixture(t, { participants: [participant(1)] });
  await f.dispatch(
    envelope(".atall", {
      peerId: new Api.PeerUser({ userId: integer(8) }),
      deleteReceipt: undefined,
    }),
  );
  await f.dispatch(
    envelope(".atall", {
      id: 8,
      peerId: new Api.PeerChannel({ channelId: integer(9) }),
      post: true,
      deleteReceipt: undefined,
    }),
  );
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.edits.filter(entry => /只能在群组中使用/.test(entry.text)).length, 2);
});

test("includes administrators, filters bot/deleted/nameless users and preserves topic replies", async t => {
  let deleted = 0;
  const admin = participant("9007199254740995", { firstName: "Admin <One>" });
  admin.participant = new Api.ChannelParticipantAdmin({
    userId: admin.id,
    date: 1,
    adminRights: new Api.ChatAdminRights({}),
  });
  const f = await fixture(t, {
    participants: [
      admin,
      participant(2, { username: "regular_user" }),
      participant(3, { bot: true }),
      participant(4, { deleted: true }),
      participant(5, { firstName: undefined, lastName: undefined }),
    ],
  });
  await f.dispatch(
    envelope(".atall ignored arguments", {
      replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 52, replyToTopId: 40 }),
      deleteReceipt: async () => {
        deleted += 1;
      },
    }),
  );

  assert.equal(f.sourceCalls.length, 1);
  assert.equal(f.sourceCalls[0].method, "iterParticipants");
  assert.deepEqual(f.sourceCalls[0].parameters, { limit: 251, showTotal: false });
  assert.equal(f.wire.length, 1);
  assert.ok(f.wire[0].bytes.length > 0);
  assert.equal(f.wire[0].request.channel instanceof Api.InputChannel, true);
  assert.match(f.edits[0].text, /正在获取群组成员列表/);
  assert.match(f.edits[1].text, /正在生成@列表.*2 个成员/);
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.sent[0].parameters.message,
    '<b>@所有人:</b>\n<a href="tg://user?id=9007199254740995">Admin &lt;One&gt;</a> @regular_user',
  );
  assert.equal(f.sent[0].parameters.replyTo, 7);
  assert.equal(f.sent[0].parameters.topMsgId, 40);
  assert.equal(deleted, 1);
});

test("distinguishes an empty group from members filtered out of the mention list", async t => {
  const empty = await fixture(t, { participants: [] });
  await empty.dispatch(envelope(".atall", { deleteReceipt: undefined }));
  assert.match(empty.edits.at(-1).text, /无法获取群组成员或群组为空/);

  const filtered = await fixture(t, {
    participants: [
      participant(1, { bot: true }),
      participant(2, { deleted: true }),
      participant(3, { firstName: undefined, lastName: undefined }),
    ],
  });
  await filtered.dispatch(envelope(".atall", { deleteReceipt: undefined }));
  assert.match(filtered.edits.at(-1).text, /没有可@的成员/);
});

test("stops at 250 participants and 10 pages and treats receipt cleanup as non-fatal", async t => {
  const members = Array.from({ length: 300 }, (_, index) => participant(1000 + index));
  const f = await fixture(t, { participants: members });
  await f.dispatch(
    envelope(".atall", {
      replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 52, replyToTopId: 40 }),
      deleteReceipt: async () => {
        throw new Error("delete denied");
      },
    }),
  );
  assert.equal(f.sent.length, 10);
  assert.equal(
    f.sent.reduce((total, page) => total + (page.parameters.message.match(/tg:\/\/user\?id=/g) ?? []).length, 0),
    250,
  );
  assert.equal(
    f.sent.every(page => page.parameters.message.length <= 3300),
    true,
  );
  assert.equal(
    f.sent.every(page => page.parameters.topMsgId === 40),
    true,
  );
  assert.deepEqual(
    f.sent.map(page => page.parameters.replyTo),
    [7, ...Array(9).fill(undefined)],
  );
  assert.match(f.sent.at(-1).parameters.message, /已达到单次 250 人 \/ 10 页上限/);
  assert.equal(
    f.logs.some(entry => entry.event === "atall_receipt_cleanup_failed" && entry.fields === undefined),
    true,
  );
  assert.equal(
    f.edits.some(entry => /提醒失败/.test(entry.text)),
    false,
  );
});

test("rejects a concurrent run without opening a second native operation", async t => {
  let enter;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const f = await fixture(t, {
    participants: [participant(1)],
    async beforeParticipants() {
      enter();
      await gate;
    },
  });
  const first = f.dispatch(envelope(".atall", { id: 10, deleteReceipt: undefined }));
  await entered;
  const second = f.dispatch(
    envelope(".atall", {
      id: 11,
      peerId: new Api.PeerChannel({ channelId: integer("9007199254740994") }),
      deleteReceipt: undefined,
    }),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);
  assert.equal(f.nativeCalls(), 1);
  assert.match(f.edits.find(entry => entry.message.id === 11).text, /已有 AtAll 任务正在执行/);
});

test("restores classified errors while keeping unknown details out of chat and logs", async t => {
  let current = new Error("CHAT_ADMIN_REQUIRED");
  const f = await fixture(t, { participantError: () => current });
  const cases = [
    [new Error("CHAT_ADMIN_REQUIRED"), /需要管理员权限来获取成员列表/],
    [new Error("USER_NOT_PARTICIPANT"), /不是群组成员/],
    [new Error("CHANNEL_PRIVATE"), /无法访问私有频道/],
  ];
  for (const [error, expected] of cases) {
    current = error;
    await f.dispatch(envelope(`.atall ${f.edits.length}`, { deleteReceipt: undefined }));
    assert.match(f.edits.at(-1).text, expected);
  }

  const secrets = [
    "/Users/operator/.config/telebox/private.json",
    "sk-live-private-api-key",
    "telegram-token-123456",
    "https://private.example.test/members?key=hidden",
  ];
  current = new Error(`request failed at ${secrets.join(" ")}`);
  await f.dispatch(envelope(".atall unknown", { deleteReceipt: undefined }));
  const output = f.edits.at(-1).text;
  assert.match(output, /暂时无法获取群组成员，请稍后重试/);
  const logged = JSON.stringify(f.logs);
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false);
    assert.equal(logged.includes(secret), false);
  }
  assert.deepEqual(
    f.logs.filter(entry => entry.level === "error").map(entry => entry.event),
    ["atall_failed", "atall_failed", "atall_failed", "atall_failed"],
  );
  assert.equal(
    f.logs.filter(entry => entry.level === "error").every(entry => entry.fields === undefined),
    true,
  );
});

test("unload cancels inter-page delay before more sends or receipt deletion", async t => {
  let deleted = 0;
  let firstSend;
  const sent = new Promise(resolve => {
    firstSend = resolve;
  });
  const f = await fixture(t, {
    participants: Array.from({ length: 26 }, (_, index) => participant(index + 1)),
    async onSendMessage() {
      firstSend();
    },
  });
  const running = f.dispatch(
    envelope(".atall", {
      deleteReceipt: async () => {
        deleted += 1;
      },
    }),
  );
  await sent;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deleted, 0);
  const report = await f.host.unload("atall", 1000);
  assert.equal(report.completed, true);
  assert.equal(await running, true);
  assert.equal(f.sent.length, 1);
  assert.equal(deleted, 0);
});
