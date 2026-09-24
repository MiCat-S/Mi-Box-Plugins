"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api } = require(path.join(core, "node_modules/teleproto"));
const Utils = require(path.join(core, "node_modules/teleproto/Utils"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "lottery",
  packageRoot: path.resolve(__dirname, "../lottery"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

function memory(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: () => tail.then(() => structuredClone(value)),
    update(operation) {
      const next = tail.then(async () => {
        value = await operation(structuredClone(value));
        return structuredClone(value);
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    value: () => structuredClone(value),
  };
}

function activity(chatId) {
  return {
    id: "activity",
    chatId,
    title: "event",
    keyword: "JOIN",
    maxParticipants: 2,
    winnerCount: 1,
    warehouse: "default",
    creatorId: "1",
    createdAt: 1,
    status: "active",
    deleteDelay: 0,
    claimTimeout: 60,
    requireAvatar: false,
    requireUsername: false,
    allowBots: false,
    participants: [],
    winners: [],
  };
}

function fixture(client, chatId = "-1009007199254740993", senderId = "9007199254740995") {
  const json = memory({
    schemaVersion: 1,
    activities: { activity: activity(chatId) },
    warehouses: { default: [] },
    settings: { minUsers: 2, maxUsers: 1000 },
    importedLegacy: true,
  });
  const edits = [],
    sent = [];
  client.sendMessage = async (peer, options) => {
    sent.push({ peer, options });
    return { id: sent.length };
  };
  client.deleteMessages = async () => {};
  const signal = new AbortController().signal;
  const context = {
    signal,
    storage: { json: () => json },
    tasks: { run: async (_label, operation) => operation(signal) },
    telegram: {
      edit: async (_message, text) => edits.push(text),
      reply: async () => {},
      withClient: operation => operation(client, signal),
    },
    log: { error() {} },
  };
  return {
    json,
    edits,
    sent,
    run: () =>
      create().commands.lottery.subcommands.draw.handle(
        {
          command: "lottery",
          subcommand: "draw",
          prefix: ".",
          args: [],
          message: { id: 1, chatId, senderId, outgoing: true, text: ".lottery draw" },
        },
        context,
      ),
  };
}

test("lottery channel admin check resolves and serializes the exact 64-bit participant ID", async () => {
  const channelId = 9007199254740993n;
  const userId = 9007199254740995n;
  const channel = new Api.Channel({
    id: channelId,
    accessHash: 77n,
    title: "group",
    photo: new Api.ChatPhotoEmpty(),
    date: 1,
    megagroup: true,
  });
  const serialized = [];
  const client = {
    async getEntity(value) {
      assert.equal(value, "-1009007199254740993");
      return channel;
    },
    async getInputEntity(value) {
      if (value === channel) return new Api.InputPeerChannel({ channelId, accessHash: 77n });
      assert.equal(value, userId.toString());
      return new Api.InputPeerUser({ userId, accessHash: 88n });
    },
    async invoke(request) {
      await request.resolve(client, Utils);
      serialized.push(request.getBytes());
      assert.ok(request instanceof Api.channels.GetParticipant);
      assert.equal(request.channel.channelId.toString(), channelId.toString());
      assert.equal(request.participant.userId.toString(), userId.toString());
      return {
        participant: new Api.ChannelParticipantAdmin({ userId, adminRights: new Api.ChatAdminRights({ other: true }) }),
      };
    },
  };
  const f = fixture(client);
  await f.run();
  assert.equal(serialized.length, 1);
  assert.ok(serialized[0].byteLength > 12);
  assert.equal(f.json.value().activities.activity.status, "completed");
});

test("lottery basic-group admin check uses messages.GetFullChat and serializes its exact chat ID", async () => {
  const chatId = 9007199254740993n;
  const userId = "9007199254740995";
  const chat = new Api.Chat({
    id: chatId,
    title: "basic",
    photo: new Api.ChatPhotoEmpty(),
    participantsCount: 2,
    date: 1,
    version: 1,
  });
  const serialized = [];
  const client = {
    async getEntity(value) {
      assert.equal(value, `-${chatId}`);
      return chat;
    },
    async invoke(request) {
      await request.resolve(client, Utils);
      serialized.push(request.getBytes());
      assert.ok(request instanceof Api.messages.GetFullChat);
      assert.equal(request.chatId.toString(), chatId.toString());
      return { fullChat: { participants: { participants: [{ className: "ChatParticipantAdmin", userId }] } } };
    },
  };
  const f = fixture(client, `-${chatId}`, userId);
  await f.run();
  assert.equal(serialized.length, 1);
  assert.ok(serialized[0].byteLength > 8);
  assert.equal(f.json.value().activities.activity.status, "completed");
});

test("lottery concurrent create reserves atomically and sends only one announcement", async () => {
  const json = memory({
    schemaVersion: 1,
    activities: {},
    warehouses: { default: [{ text: "prize", stock: 2, order: 0 }] },
    settings: { minUsers: 2, maxUsers: 1000 },
    importedLegacy: true,
  });
  const edits = [],
    sends = [];
  const signal = new AbortController().signal;
  const client = {
    async sendMessage(peer, options) {
      sends.push({ peer, options });
      return { id: 9 };
    },
    async pinMessage() {},
  };
  const context = {
    signal,
    storage: { json: () => json },
    telegram: {
      edit: async (_message, text) => edits.push(text),
      reply: async () => {},
      withClient: operation => operation(client, signal),
    },
    log: { error() {} },
  };
  const command = create().commands.lottery.subcommands.create;
  const invoke = id =>
    command.handle(
      {
        command: "lottery",
        subcommand: "create",
        prefix: ".",
        args: ["event", "JOIN", "2", "1", "default"],
        message: { id, chatId: "-1001", senderId: "7", outgoing: true, text: ".lottery create" },
      },
      context,
    );
  await Promise.all([invoke(1), invoke(2)]);
  assert.equal(sends.length, 1);
  assert.equal(Object.values(json.value().activities).filter(item => item.status === "active").length, 1);
  assert.ok(edits.some(text => /已有进行中的抽奖/.test(text)));
});

test("lottery concurrent joins are atomic and reaching capacity draws exactly once", async () => {
  const active = activity("-1001");
  active.participants = [];
  active.maxParticipants = 2;
  const json = memory({
    schemaVersion: 1,
    activities: { activity: active },
    warehouses: { default: [{ text: "gift", stock: 1, order: 0 }] },
    settings: { minUsers: 2, maxUsers: 1000 },
    importedLegacy: true,
  });
  const replies = [],
    sends = [],
    deletes = [];
  const signal = new AbortController().signal;
  const client = {
    async sendMessage(peer, options) {
      sends.push({ peer, options });
      return { id: sends.length };
    },
    async deleteMessages(peer, ids) {
      deletes.push({ peer, ids });
    },
  };
  const context = {
    signal,
    storage: { json: () => json },
    tasks: { run: async () => {} },
    telegram: {
      edit: async () => {},
      reply: async (_message, text) => replies.push(text),
      withClient: operation => operation(client, signal),
    },
    log: { error() {} },
  };
  const listener = create().listeners[0];
  const join = senderId =>
    listener.handle(
      {
        id: Number(senderId.slice(-2)),
        chatId: "-1001",
        senderId,
        outgoing: false,
        direction: "incoming",
        text: "JOIN",
        raw: { sender: { id: senderId, firstName: senderId } },
      },
      context,
    );
  await Promise.all([join("9007199254740993"), join("9007199254740993"), join("9007199254740995")]);
  const state = json.value(),
    resultMessages = sends.filter(item => item.options.message.includes("开奖结果"));
  assert.deepEqual(state.activities.activity.participants.map(item => item.userId).sort(), [
    "9007199254740993",
    "9007199254740995",
  ]);
  assert.equal(replies.length, 2);
  assert.equal(resultMessages.length, 1);
  assert.equal(state.activities.activity.status, "completed");
  assert.equal(state.activities.activity.winners.length, 1);
  assert.equal(state.warehouses.default[0].stock, 0);
});

test("lottery admits only one concurrent contender for the final participant slot", async () => {
  const active = activity("-1001");
  active.maxParticipants = 2;
  active.participants = [{ userId: "1", joinedAt: 1 }];
  const json = memory({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: { default: [] },
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    replies = [],
    signal = new AbortController().signal;
  const client = {
    async sendMessage() {
      return { id: 1 };
    },
    async deleteMessages() {},
  };
  const context = {
    signal,
    storage: { json: () => json },
    tasks: { run: async () => {} },
    telegram: {
      edit: async () => {},
      reply: async (_message, text) => replies.push(text),
      withClient: operation => operation(client, signal),
    },
    log: { error() {} },
  };
  const listener = create().listeners[0],
    join = senderId =>
      listener.handle(
        {
          id: Number(senderId),
          chatId: "-1001",
          senderId,
          outgoing: false,
          direction: "incoming",
          text: "JOIN",
          raw: { sender: { firstName: senderId } },
        },
        context,
      );
  await Promise.all([join("2"), join("3")]);
  assert.equal(json.value().activities.activity.participants.length, 2);
  assert.equal(replies.length, 1);
});

test("lottery cancellation during winner notification performs no later RPC or winner status write", async () => {
  const active = activity("-1001");
  active.participants = [{ userId: "9007199254740993", firstName: "winner", joinedAt: 1 }];
  active.messageId = 77;
  const json = memory({
    schemaVersion: 1,
    activities: { activity: active },
    warehouses: { default: [{ text: "gift", stock: 1, order: 0 }] },
    settings: { minUsers: 2, maxUsers: 1000 },
    importedLegacy: true,
  });
  const controller = new AbortController();
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    release = new Promise(resolve => {
      releaseResolve = resolve;
    });
  const calls = [],
    edits = [];
  const client = {
    async sendMessage(peer) {
      calls.push(["send", peer.toString()]);
      enteredResolve();
      await release;
      return { id: 9 };
    },
    async deleteMessages() {
      calls.push(["delete"]);
    },
  };
  const context = {
    signal: controller.signal,
    storage: { json: () => json },
    telegram: {
      edit: async (_message, text) => edits.push(text),
      reply: async () => {},
      withClient: operation => operation(client, controller.signal),
    },
    log: { error() {} },
  };
  const running = create().commands.lottery.subcommands.draw.handle(
    {
      command: "lottery",
      subcommand: "draw",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery draw" },
    },
    context,
  );
  await entered;
  controller.abort();
  releaseResolve();
  await running;
  assert.deepEqual(calls, [["send", "9007199254740993"]]);
  assert.deepEqual(edits, ["正在开奖…"]);
  assert.equal(json.value().activities.activity.winners[0].status, "prepared");
});

test("lottery records partial winner delivery for recovery without claiming full delivery", async () => {
  const active = activity("-1001");
  active.title = "活动".repeat(2200);
  active.participants = [{ userId: "9", firstName: "winner", joinedAt: 1 }];
  const json = memory({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: { default: [{ text: "gift", stock: 1, order: 0 }] },
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    logs = [],
    counts = new Map(),
    messages = [],
    signal = new AbortController().signal;
  const client = {
    async sendMessage(peer, options) {
      const key = peer.toString(),
        count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (key === "9" && count === 2) throw Object.assign(new Error("transport-secret"), { code: "TIMEOUT" });
      messages.push({ key, text: options.message });
      return { id: count };
    },
    async deleteMessages() {},
  };
  const context = {
    signal,
    storage: { json: () => json },
    telegram: { edit: async () => {}, reply: async () => {}, withClient: operation => operation(client, signal) },
    log: {
      info(event, fields) {
        logs.push({ event, fields });
      },
      error() {},
    },
  };
  await create().commands.lottery.subcommands.draw.handle(
    {
      command: "lottery",
      subcommand: "draw",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery draw" },
    },
    context,
  );
  const winner = json.value().activities.activity.winners[0];
  assert.deepEqual(
    {
      status: winner.status,
      prize: winner.prize,
      messageId: winner.messageId,
      deliveredPages: winner.deliveredPages,
      totalPages: winner.totalPages,
    },
    { status: "prepared", prize: "gift", messageId: 1, deliveredPages: 1, totalPages: 3 },
  );
  assert.equal(counts.get("9"), 2);
  const summary = messages
    .filter(item => item.key === "-1001")
    .map(item => item.text)
    .join("\n");
  assert.match(summary, /部分发送 1\/3 页，需补发/);
  assert.doesNotMatch(summary, /已私聊发放/);
  assert.equal(logs[0].event, "lottery:send-pages-interrupted");
  assert.deepEqual(
    { published: logs[0].fields.published, category: logs[0].fields.category },
    { published: 1, category: "TIMEOUT" },
  );
  assert.ok(logs[0].fields.total > 1);
  assert.doesNotMatch(JSON.stringify(logs), /transport-secret/);
});

test("lottery management persists cancel, claim and expire transitions without stale overwrite", async () => {
  const completed = {
    ...activity("-1001"),
    status: "completed",
    winners: [
      { userId: "10", username: "alice", joinedAt: 1, status: "prepared", assignedAt: 1, expiresAt: 1 },
      { userId: "11", joinedAt: 1, status: "prepared", assignedAt: 1, expiresAt: Date.now() + 100000 },
    ],
  };
  const json = memory({
    schemaVersion: 1,
    activities: { activity: completed },
    warehouses: {},
    settings: { minUsers: 2, maxUsers: 1000 },
    importedLegacy: true,
  });
  const edits = [],
    signal = new AbortController().signal,
    context = {
      signal,
      storage: { json: () => json },
      telegram: {
        edit: async (_message, text) => edits.push(text),
        reply: async () => {},
        withClient: async () => assert.fail("creator operations need no native client"),
      },
      log: { error() {} },
    };
  const base = {
    command: "lottery",
    prefix: ".",
    message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: "" },
  };
  await create().commands.lottery.subcommands.claim.handle({ ...base, subcommand: "claim", args: ["@alice"] }, context);
  await create().commands.lottery.subcommands.expire.handle({ ...base, subcommand: "expire", args: [] }, context);
  assert.deepEqual(
    json.value().activities.activity.winners.map(item => item.status),
    ["claimed", "prepared"],
  );
  assert.deepEqual(edits, ["已标记为已领奖。", "已处理 0 个过期奖品。"]);
});

test("lottery cancel races safely with participation and preserves any committed participant", async () => {
  const active = activity("-1001"),
    json = memory({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    });
  const edits = [],
    replies = [],
    signal = new AbortController().signal,
    context = {
      signal,
      storage: { json: () => json },
      tasks: { run: async () => {} },
      telegram: {
        edit: async (_message, text) => edits.push(text),
        reply: async (_message, text) => replies.push(text),
        withClient: operation => operation({}, signal),
      },
      log: { error() {} },
    };
  const cancel = create().commands.lottery.subcommands.delete.handle(
    {
      command: "lottery",
      subcommand: "delete",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery cancel" },
    },
    context,
  );
  const join = create().listeners[0].handle(
    {
      id: 2,
      chatId: "-1001",
      senderId: "9007199254740993",
      outgoing: false,
      direction: "incoming",
      text: "JOIN",
      raw: { sender: { firstName: "joined" } },
    },
    context,
  );
  await Promise.all([cancel, join]);
  const saved = json.value().activities.activity;
  assert.equal(saved.status, "cancelled");
  assert.ok(saved.participants.length <= 1);
  if (replies.length) assert.equal(saved.participants[0].userId, "9007199254740993");
  assert.deepEqual(edits, ["抽奖已取消。"]);
});

test("lottery prize warehouse create, add, list and clear remain persistent and escaped", async () => {
  const json = memory({
      schemaVersion: 1,
      activities: {},
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    edits = [],
    signal = new AbortController().signal;
  const context = {
      signal,
      storage: { json: () => json },
      telegram: { edit: async (_message, text) => edits.push(text), reply: async () => {} },
      log: { error() {} },
    },
    message = { id: 1, chatId: "1", senderId: "1", outgoing: true, saved: true, text: "" };
  const prize = create().commands.lottery.subcommands.prize.subcommands;
  await prize.create.handle(
    { command: "lottery", subcommands: ["prize", "create"], prefix: ".", args: ["vip"], message },
    context,
  );
  await prize.add.handle(
    { command: "lottery", subcommands: ["prize", "add"], prefix: ".", args: ["vip", "<年度会员>", "2"], message },
    context,
  );
  await prize.list.handle(
    { command: "lottery", subcommands: ["prize", "list"], prefix: ".", args: ["vip"], message },
    context,
  );
  assert.deepEqual(json.value().warehouses.vip, [{ text: "<年度会员>", stock: 2, order: 0 }]);
  assert.match(edits.at(-1), /&lt;年度会员&gt;（2）/);
  await prize.clear.handle(
    { command: "lottery", subcommands: ["prize", "clear"], prefix: ".", args: ["vip"], message },
    context,
  );
  assert.deepEqual(json.value().warehouses.vip, []);
});

test("lottery participant list uses complete SDK pagination with bounded pages", async () => {
  const active = activity("-1001");
  active.maxParticipants = 1000;
  active.participants = Array.from({ length: 600 }, (_, index) => ({
    userId: String(9007199254740000n + BigInt(index)),
    firstName: `<用户&${index}>`,
    joinedAt: index,
  }));
  const json = memory({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    pages = [],
    signal = new AbortController().signal;
  const context = {
    signal,
    storage: { json: () => json },
    telegram: { edit: async (_message, text) => pages.push(text), reply: async (_message, text) => pages.push(text) },
    log: { error() {} },
  };
  await create().commands.lottery.subcommands.list.handle(
    {
      command: "lottery",
      subcommand: "list",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery list" },
    },
    context,
  );
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  const joined = pages.join("\n");
  for (let index = 0; index < 600; index++) assert.ok(joined.includes(`&lt;用户&amp;${index}&gt;`));
  assert.ok(pages.every((page, index) => page.endsWith(`${index + 1}/${pages.length} 页`)));
});

test("lottery list keeps its first page and emits only fixed metadata after a later transport failure", async () => {
  const active = activity("-1001");
  active.maxParticipants = 1000;
  active.participants = Array.from({ length: 600 }, (_, index) => ({
    userId: String(index),
    firstName: `user-${index}`,
    joinedAt: index,
  }));
  const json = memory({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    edits = [],
    replies = [],
    logs = [],
    signal = new AbortController().signal;
  const context = {
    signal,
    storage: { json: () => json },
    telegram: {
      edit: async (_message, text) => edits.push(text),
      reply: async (_message, text) => {
        replies.push(text);
        throw new Error("evil-transport");
      },
    },
    log: {
      info(event, fields) {
        logs.push({ event, fields });
      },
      error() {},
    },
  };
  await create().commands.lottery.subcommands.list.handle(
    {
      command: "lottery",
      subcommand: "list",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery list" },
    },
    context,
  );
  assert.equal(edits.length, 1);
  assert.ok(replies.length >= 1);
  assert.equal(logs[0].event, "lottery:pages-interrupted");
  assert.equal(logs[0].fields.published, 1);
  assert.doesNotMatch(JSON.stringify({ edits, replies, logs }), /evil-transport/);
});

test("lottery sanitizes unknown failures and keeps a successful create when pin and receipt fail", async () => {
  const json = memory({
      schemaVersion: 1,
      activities: {},
      warehouses: { default: [{ text: "gift", stock: 1, order: 0 }] },
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
    edits = [],
    logs = [],
    signal = new AbortController().signal;
  const client = {
    async sendMessage() {
      return { id: 44 };
    },
    async pinMessage() {
      throw new Error("pin-secret");
    },
  };
  const context = {
    signal,
    storage: { json: () => json },
    telegram: {
      edit: async () => {
        throw Object.assign(new Error("receipt-secret"), { name: "EvilName" });
      },
      reply: async () => {},
      withClient: operation => operation(client, signal),
    },
    log: {
      info(event) {
        logs.push(event);
      },
      error() {},
    },
  };
  await create().commands.lottery.subcommands.create.handle(
    {
      command: "lottery",
      subcommand: "create",
      prefix: ".",
      args: ["event", "JOIN", "2", "1", "default"],
      message: { id: 1, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery create" },
    },
    context,
  );
  const saved = Object.values(json.value().activities);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].messageId, 44);
  assert.deepEqual(logs, ["lottery:create-pin-failed", "lottery:create-receipt-failed"]);
  const failing = {
    ...context,
    telegram: { ...context.telegram, edit: async (_message, text) => edits.push(text) },
    storage: {
      json: () => ({
        read: async () => {
          throw new Error("db-secret");
        },
      }),
    },
  };
  await create().commands.lottery.subcommands.status.handle(
    {
      command: "lottery",
      subcommand: "status",
      prefix: ".",
      args: [],
      message: { id: 2, chatId: "-1001", senderId: "1", outgoing: true, text: ".lottery status" },
    },
    failing,
  );
  assert.equal(edits.at(-1), "操作失败：<code>操作失败，请稍后重试</code>");
  assert.doesNotMatch(JSON.stringify(edits), /db-secret|EvilName|receipt-secret/);
});

test("real Host unload cancels delayed cleanup without a later delete RPC", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lottery-timer-")));
  await fs.mkdir(path.join(root, "lottery"));
  const active = activity("-1001");
  active.deleteDelay = 60;
  await fs.writeFile(
    path.join(root, "lottery", "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      activities: { activity: active },
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
  );
  const deletes = [],
    client = {
      async deleteMessages(...args) {
        deletes.push(args);
      },
    },
    host = new PluginHost({
      storageRoot: root,
      logger: { info() {}, error() {} },
      telegram: {
        async edit() {},
        async reply() {},
        async invoke() {},
        async getReply() {},
        async withClient(operation, signal) {
          return operation(client, signal);
        },
      },
    });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  await host.dispatchListeners({
    id: 9,
    chatId: "-1001",
    senderId: "9007199254740993",
    outgoing: false,
    direction: "incoming",
    text: "JOIN",
    raw: { sender: { firstName: "user" } },
  });
  assert.equal((await host.unload("lottery", 1000)).completed, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deletes, []);
});

test("lottery loads, unloads and restores drawing state through the real PluginHost", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lottery-host-")));
  await fs.mkdir(path.join(root, "lottery"));
  const recovering = activity("-1001");
  recovering.status = "drawing";
  await fs.writeFile(
    path.join(root, "lottery", "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      activities: { activity: recovering },
      warehouses: {},
      settings: { minUsers: 2, maxUsers: 1000 },
      importedLegacy: true,
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(operation, signal) {
        return operation({}, signal);
      },
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "lottery", "state.json"))).activities.activity.status,
    "active",
  );
  assert.equal((await host.unload("lottery", 1000)).completed, true);
  await host.load(create());
  assert.equal((await host.unload("lottery", 1000)).completed, true);
});
