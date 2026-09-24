"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  Api = require(path.join(core, "node_modules/teleproto")).Api;
const built = require(
    path.join(
      buildPlugin({
        id: "paolu",
        packageRoot: process.env.PAOLU_TEST_SOURCE || path.resolve(__dirname, "../paolu"),
        entry: "v2.ts",
      }).artifactDir,
      "index.cjs",
    ),
  ),
  create = built.default,
  { deleteBatch, cleanupReceipt } = built;
function fixture(rights = { banUsers: true, deleteMessages: true }) {
  const edits = [],
    deleted = [],
    rpc = [],
    tasks = [];
  const chat = { className: "Channel" },
    client = {
      getEntity: async () => chat,
      getMe: async () => ({ id: 1n }),
      invoke: async req => {
        rpc.push(req);
        if (req instanceof Api.channels.GetParticipant)
          return {
            participant: new Api.ChannelParticipantAdmin({ userId: 1n, adminRights: new Api.ChatAdminRights(rights) }),
          };
        return {};
      },
      async *iterMessages() {
        yield { id: 1 };
        yield { id: 2 };
      },
      deleteMessages: async (c, ids) => deleted.push(ids),
      sendMessage: async () => ({ id: 88 }),
    };
  const signal = new AbortController().signal,
    ctx = {
      signal,
      log: { error() {} },
      tasks: {
        run: (id, fn) => {
          tasks.push(id);
          return Promise.resolve();
        },
      },
      telegram: { edit: async (m, t) => edits.push(t), withClient: fn => fn(client, signal) },
    };
  return {
    edits,
    deleted,
    rpc,
    tasks,
    run: () =>
      create().commands.paolu.handle(
        {
          message: { id: 9, chatId: "-100", text: ".paolu", outgoing: true, raw: { peerId: "x" } },
          args: [],
          prefix: ".",
          command: "paolu",
        },
        ctx,
      ),
  };
}
test("paolu requires both destructive permissions", async () => {
  const f = fixture({ banUsers: true });
  await f.run();
  assert.match(f.edits[0], /需要封禁成员和删除消息权限/);
  assert.equal(f.deleted.length, 0);
});
test("paolu uses default banned rights, batches deletion and scoped cleanup", async () => {
  const f = fixture();
  await f.run();
  assert.ok(f.rpc.some(x => x instanceof Api.messages.EditChatDefaultBannedRights));
  assert.deepEqual(f.deleted[0], [1, 2]);
  assert.match(f.tasks[0], /^paolu:cleanup:/);
});

test("paolu retries FLOOD_WAIT three times, then counts individual fallback results", async () => {
  const waits = [],
    signal = new AbortController().signal;
  let calls = 0;
  const recovered = await deleteBatch(
    {
      async deleteMessages() {
        calls++;
        if (calls < 4) throw new Error("FLOOD_WAIT_2");
      },
    },
    "chat",
    [1, 2],
    signal,
    async ms => {
      waits.push(ms);
    },
  );
  assert.equal(recovered, 2);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [2000, 2000, 2000]);
  const attempted = [];
  calls = 0;
  const partial = await deleteBatch(
    {
      async deleteMessages(_chat, ids) {
        calls++;
        attempted.push(ids);
        if (ids.length > 1 || ids[0] === 2) throw new Error("denied");
      },
    },
    "chat",
    [1, 2, 3],
    signal,
    async () => {},
  );
  assert.equal(partial, 2);
  assert.deepEqual(attempted, [[1, 2, 3], [1], [2], [3]]);
  assert.equal(calls, 4);
});

test("paolu cancellation after a native batch stops every later mutation", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    deleteBatch(
      {
        async deleteMessages() {
          calls++;
          controller.abort();
        },
      },
      "chat",
      [1, 2],
      controller.signal,
      async () => {},
    ),
    error => error?.name === "AbortError",
  );
  assert.equal(calls, 1);
});
test("paolu receipt cleanup waits ten seconds and cancellation admits no delete", async () => {
  const signal = new AbortController().signal,
    waits = [],
    deletes = [];
  await cleanupReceipt(
    { telegram: { withClient: fn => fn({ deleteMessages: async (_chat, ids) => deletes.push(ids) }, signal) } },
    "chat",
    88,
    signal,
    async ms => waits.push(ms),
  );
  assert.deepEqual(waits, [10000]);
  assert.deepEqual(deletes, [[88]]);
  const controller = new AbortController();
  let released;
  const gate = new Promise(resolve => {
    released = resolve;
  });
  let effects = 0;
  const pending = cleanupReceipt(
    {
      telegram: {
        withClient: async () => {
          effects++;
        },
      },
    },
    "chat",
    88,
    controller.signal,
    async () => gate,
  );
  controller.abort();
  released();
  await assert.rejects(pending, error => error?.name === "AbortError");
  assert.equal(effects, 0);
});

test("paolu preserves a rawless large channel peer and serializes both TL requests", async () => {
  const { helpers, utils } = require(path.join(core, "node_modules/teleproto"));
  const id = helpers.returnBigInt("9007199254740993"),
    chat = new Api.Channel({ id, accessHash: helpers.returnBigInt("7"), title: "large" });
  const targets = [],
    requests = [],
    sent = [],
    deleted = [],
    signal = new AbortController().signal;
  const client = {
    async getEntity(target) {
      targets.push(target);
      return chat;
    },
    async getInputEntity() {
      return new Api.InputPeerChannel({ channelId: id, accessHash: helpers.returnBigInt("7") });
    },
    async invoke(request) {
      requests.push(request);
      await request.resolve(this, utils);
      assert.ok(request.getBytes().length > 0);
      if (request instanceof Api.channels.GetParticipant)
        return { participant: new Api.ChannelParticipantCreator({ userId: id }) };
      return {};
    },
    async *iterMessages() {},
    async deleteMessages(_chat, ids) {
      deleted.push(ids);
    },
    async sendMessage(target, value) {
      sent.push({ target, value });
      return { id: 88 };
    },
  };
  const edits = [];
  await create().commands.paolu.handle(
    {
      command: "paolu",
      prefix: ".",
      args: [],
      message: { id: 9, chatId: "-1009007199254740993", text: ".paolu", outgoing: true },
    },
    {
      signal,
      log: { error() {} },
      tasks: { run: () => Promise.resolve() },
      telegram: { edit: async (_m, t) => edits.push(t), withClient: fn => fn(client, signal) },
    },
  );
  assert.ok(targets[0] instanceof Api.PeerChannel);
  assert.equal(targets[0].channelId.toString(), id.toString());
  assert.ok(requests.some(x => x instanceof Api.channels.GetParticipant));
  assert.ok(requests.some(x => x instanceof Api.messages.EditChatDefaultBannedRights));
  assert.deepEqual(deleted, [[9]]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, chat);
  assert.match(sent[0].value.message, /全员禁言: 成功/);
});

test("paolu reports mute and partial deletion truthfully and never leaks native errors", async () => {
  const edits = [],
    logs = [],
    signal = new AbortController().signal,
    chat = { className: "Channel" };
  let batch = true;
  const client = {
    async getEntity() {
      return chat;
    },
    async invoke(request) {
      if (request instanceof Api.channels.GetParticipant)
        return {
          participant: new Api.ChannelParticipantAdmin({
            userId: 1n,
            adminRights: new Api.ChatAdminRights({ banUsers: true, deleteMessages: true }),
          }),
        };
      throw new Error("private mute failure");
    },
    async *iterMessages() {
      yield { id: 1 };
      yield { id: 2 };
    },
    async deleteMessages(_chat, ids) {
      if (ids.length > 1) throw new Error("batch");
      if (ids[0] === 2) throw new Error("single");
    },
    async sendMessage(_chat, value) {
      edits.push(value.message);
      return { id: 88 };
    },
  };
  await create().commands.paolu.handle(
    {
      command: "paolu",
      prefix: ".",
      args: [],
      message: { id: 9, chatId: "-100", text: ".paolu", outgoing: true, raw: { peerId: "peer" } },
    },
    {
      signal,
      log: { error: event => logs.push(event) },
      tasks: { run: () => Promise.resolve() },
      telegram: { edit: async (_m, t) => edits.push(t), withClient: fn => fn(client, signal) },
    },
  );
  assert.ok(logs.includes("paolu_mute_failed"));
  assert.match(edits.at(-1), /全员禁言: 失败/);
  assert.match(edits.at(-1), /已删除 1 条/);
  assert.match(edits.at(-1), /删除失败 1 条/);
  assert.doesNotMatch(edits.join("\n"), /private mute failure/);
  const failed = [],
    failureLogs = [];
  await create().commands.paolu.handle(
    {
      command: "paolu",
      prefix: ".",
      args: [],
      message: { id: 9, chatId: "-100", text: ".paolu", outgoing: true, raw: { peerId: "peer" } },
    },
    {
      signal,
      log: { error: event => failureLogs.push(event) },
      telegram: {
        edit: async (_m, t) => failed.push(t),
        withClient: async () => {
          throw new Error("secret native failure");
        },
      },
    },
  );
  assert.deepEqual(failureLogs, ["paolu_failed"]);
  assert.equal(failed.at(-1), "❌ 操作失败，请稍后重试");
});
test("paolu traverses the complete history without a hidden cap", async () => {
  const signal = new AbortController().signal,
    batches = [],
    edits = [],
    chat = { className: "Channel" };
  let completion = "";
  const client = {
    async getEntity() {
      return chat;
    },
    async invoke(request) {
      return request instanceof Api.channels.GetParticipant
        ? { participant: new Api.ChannelParticipantCreator({ userId: 1n }) }
        : {};
    },
    async *iterMessages() {
      for (let id = 1; id <= 205; id++) yield { id };
    },
    async deleteMessages(_chat, ids) {
      batches.push(ids);
    },
    async sendMessage(_chat, value) {
      completion = value.message;
      return { id: 88 };
    },
  };
  await create().commands.paolu.handle(
    {
      command: "paolu",
      prefix: ".",
      args: [],
      message: { id: 999, chatId: "-100", text: ".paolu", outgoing: true, raw: { peerId: "peer" } },
    },
    {
      signal,
      log: { error() {} },
      tasks: { run: () => Promise.resolve() },
      telegram: { edit: async (_m, t) => edits.push(t), withClient: fn => fn(client, signal) },
    },
  );
  assert.deepEqual(
    batches.map(x => x.length),
    [100, 100, 5, 1],
  );
  assert.match(completion, /已删除 205 条/);
});
test("paolu receipt cleanup failure logs a fixed event without reversing delivered completion", async () => {
  const signal = new AbortController().signal,
    logs = [],
    edits = [],
    sent = [],
    chat = { className: "Channel" };
  const client = {
    async getEntity() {
      return chat;
    },
    async invoke(request) {
      return request instanceof Api.channels.GetParticipant
        ? { participant: new Api.ChannelParticipantCreator({ userId: 1n }) }
        : {};
    },
    async *iterMessages() {},
    async deleteMessages() {},
    async sendMessage(_chat, value) {
      sent.push(value.message);
      return { id: 88 };
    },
  };
  await create().commands.paolu.handle(
    {
      command: "paolu",
      prefix: ".",
      args: [],
      message: { id: 9, chatId: "-100", text: ".paolu", outgoing: true, raw: { peerId: "peer" } },
    },
    {
      signal,
      log: { error: event => logs.push(event) },
      tasks: { run: () => Promise.reject(new Error("private cleanup failure")) },
      telegram: { edit: async (_m, t) => edits.push(t), withClient: fn => fn(client, signal) },
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.deepEqual(logs, ["paolu_receipt_cleanup_failed"]);
  assert.ok(!edits.some(x => x.includes("操作失败")));
});
