"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { returnBigInt, resolveId } = {
  ...require(path.join(core, "node_modules/teleproto/Helpers.js")),
  ...require(path.join(core, "node_modules/teleproto/Utils.js")),
};

function createPlugin() {
  const { artifactDir } = buildPlugin({ id: "bs", packageRoot: path.resolve(__dirname, "../bs"), entry: "v2.ts" });
  const entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}

// bs keeps no state: it forwards to the first channel in its fixed list that
// accepts the messages, so the fixture only fakes the Telegram client.
async function floodFixture(t, invoke, hooks = {}) {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-bs-flood-")));
  const edits = [];
  const client = {
    async getMessages(peer, { ids }) {
      return hooks.getMessages ? hooks.getMessages(peer, ids[0]) : [{ id: ids[0] }];
    },
    async getEntity(value) {
      return hooks.getEntity ? hooks.getEntity(value) : { id: returnBigInt(9), title: String(value) };
    },
    async getInputEntity(value) {
      return value;
    },
    invoke,
    async sendMessage(...args) {
      return hooks.sendMessage?.(...args);
    },
  };
  const host = new PluginHost({
    storageRoot,
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 41, raw: { id: 41 } };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(createPlugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  return {
    host,
    edits,
    run: () =>
      host.dispatchPrimary({
        id: 42,
        chatId: "-1009",
        senderId: "7",
        outgoing: true,
        replyToId: 41,
        text: ".bs",
        raw: { peerId: returnBigInt("-1009") },
      }),
  };
}

test("bs cancellation during target resolution prevents later native side effects", async t => {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-bs-cancel-")));
  let resolving;
  let releaseResolution;
  const started = new Promise(resolve => {
    resolving = resolve;
  });
  const release = new Promise(resolve => {
    releaseResolution = resolve;
  });
  let inputLookups = 0;
  let invokes = 0;
  let sends = 0;
  const client = {
    async getMessages(_peer, { ids }) {
      return [{ id: ids[0] }];
    },
    async getEntity() {
      resolving();
      await release;
      return { id: returnBigInt(9), title: "Target" };
    },
    async getInputEntity() {
      inputLookups += 1;
    },
    async invoke() {
      invokes += 1;
    },
    async sendMessage() {
      sends += 1;
    },
  };
  const edits = [];
  const host = new PluginHost({
    storageRoot,
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 41, raw: { id: 41 } };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(createPlugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  const dispatch = host.dispatchPrimary({
    id: 42,
    chatId: "-1009",
    senderId: "7",
    outgoing: true,
    replyToId: 41,
    text: ".bs",
    raw: {},
  });
  await started;
  const unloading = host.unload("bs", 2000);
  releaseResolution();
  assert.equal((await unloading).completed, true);
  await dispatch;
  assert.equal(inputLookups, 0);
  assert.equal(invokes, 0);
  assert.equal(sends, 0);
  assert.doesNotMatch(edits.join("\n"), /保送失败/);
});

test("bs waits once for FLOOD_WAIT and then retries successfully", async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("private detail"), { errorMessage: "FLOOD_WAIT_0" });
    return { updates: [{ message: { className: "Message", id: 501 } }] };
  });
  await fixture.run();
  assert.equal(calls, 2);
  assert.match(fixture.edits.at(-1), /已被保送到频道/);
  assert.doesNotMatch(fixture.edits.join("\n"), /private detail|FLOOD_WAIT/);
});

test("bs unload during FLOOD_WAIT aborts the wait without another request", async t => {
  let calls = 0;
  let firstCall;
  const started = new Promise(resolve => {
    firstCall = resolve;
  });
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    firstCall();
    throw Object.assign(new Error("private detail"), { errorMessage: "FLOOD_WAIT_30" });
  });
  const dispatch = fixture.run();
  await started;
  assert.equal((await fixture.host.unload("bs", 2000)).completed, true);
  await dispatch;
  assert.equal(calls, 1);
  assert.doesNotMatch(fixture.edits.join("\n"), /保送失败|private detail|FLOOD_WAIT/);
});

test("bs rejects FLOOD_WAIT beyond its retry budget with fixed feedback", async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    throw Object.assign(new Error("private detail"), { errorMessage: "FLOOD_WAIT_60" });
  });
  await fixture.run();
  assert.equal(calls, 1);
  assert.match(fixture.edits.at(-1), /^操作频繁，请稍后重试/);
  assert.doesNotMatch(fixture.edits.join("\n"), /private detail|FLOOD_WAIT/);
});

test("bs cancellation while forwarding prevents source resolution and feedback", async t => {
  let forwardStarted;
  let releaseForward;
  const started = new Promise(resolve => {
    forwardStarted = resolve;
  });
  const release = new Promise(resolve => {
    releaseForward = resolve;
  });
  let entityCalls = 0;
  let feedback = 0;
  const fixture = await floodFixture(
    t,
    async () => {
      forwardStarted();
      await release;
      return { updates: [{ message: { className: "Message", id: 501 } }] };
    },
    {
      getEntity(value) {
        entityCalls += 1;
        return { id: returnBigInt(9), title: String(value) };
      },
      sendMessage() {
        feedback += 1;
      },
    },
  );
  const dispatch = fixture.run();
  await started;
  const unloading = fixture.host.unload("bs", 2000);
  releaseForward();
  assert.equal((await unloading).completed, true);
  await dispatch;
  assert.equal(entityCalls, 1);
  assert.equal(feedback, 0);
  assert.doesNotMatch(fixture.edits.join("\n"), /保送失败/);
});

test("bs reports forwards-restricted sources with the original fixed message", async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    throw Object.assign(new Error("private detail"), { errorMessage: "CHAT_FORWARDS_RESTRICTED" });
  });
  await fixture.run();
  assert.equal(calls, 1);
  assert.match(fixture.edits.at(-1), /^该消息不允许被转发$/);
  assert.doesNotMatch(fixture.edits.join("\n"), /private detail|CHAT_FORWARDS_RESTRICTED|保送失败/);
});

test("bs skips deleted messages while collecting and still forwards", async t => {
  const scanned = [];
  let requested;
  const fixture = await floodFixture(
    t,
    async request => {
      requested = request.id;
      return {
        updates: [
          { message: { className: "Message", id: 501 } },
          { message: { className: "Message", id: 502 } },
          { message: { className: "Message", id: 503 } },
        ],
      };
    },
    {
      getMessages(_peer, id) {
        scanned.push(id);
        if (id === 42 || id === 44) throw new Error("MESSAGE_ID_INVALID");
        return [{ id }];
      },
    },
  );
  const items = [
    {
      id: 42,
      chatId: "-1009",
      senderId: "7",
      outgoing: true,
      replyToId: 41,
      text: ".bs 3",
      raw: { peerId: returnBigInt("-1009") },
    },
  ];
  await fixture.host.dispatchPrimary(items[0]);
  assert.deepEqual(scanned, [41, 42, 43, 44, 45]);
  assert.deepEqual(requested, [41, 43, 45]);
  assert.match(fixture.edits.at(-1), /已被保送到频道/);
  assert.match(fixture.edits.at(-1), /3 条消息/);
  assert.doesNotMatch(fixture.edits.join("\n"), /保送失败|MESSAGE_ID_INVALID/);
});

test("bs bounds its source scan by the search limit", async t => {
  let scanned = 0;
  const fixture = await floodFixture(t, async () => ({ updates: [] }), {
    getMessages() {
      scanned += 1;
      throw new Error("MESSAGE_ID_INVALID");
    },
  });
  await fixture.host.dispatchPrimary({
    id: 42,
    chatId: "-1009",
    senderId: "7",
    outgoing: true,
    replyToId: 41,
    text: ".bs 100000",
    raw: { peerId: returnBigInt("-1009") },
  });
  assert.equal(scanned, 500);
  assert.match(fixture.edits.at(-1), /未找到可转发的消息/);
});

test("bs skips channels it cannot post in and never shows the raw error", async t => {
  const fixture = await floodFixture(t, async () => ({ updates: [] }), {
    getEntity() {
      throw Object.assign(new Error("private detail"), { errorMessage: "CHAT_WRITE_FORBIDDEN" });
    },
  });
  await fixture.run();
  assert.equal(fixture.edits.at(-1), "没有找到有发送权限的频道");
  assert.doesNotMatch(fixture.edits.join("\n"), /private detail|CHAT_WRITE_FORBIDDEN/);
});

test("bs reports the collected count when the target name is unavailable", async t => {
  const fixture = await floodFixture(
    t,
    async () => ({
      updates: [
        { message: { className: "Message", id: 501 } },
        { message: { className: "Message", id: 502 } },
        { message: { className: "Message", id: 503 } },
      ],
    }),
    {
      getEntity(value) {
        return { id: returnBigInt(9) };
      },
    },
  );
  await fixture.host.dispatchPrimary({
    id: 42,
    chatId: "-1009",
    senderId: "7",
    outgoing: true,
    replyToId: 41,
    text: ".bs 3",
    raw: { peerId: returnBigInt("-1009") },
  });
  const text = fixture.edits.at(-1);
  assert.match(text, /3 条消息已被保送到频道/);
  assert.doesNotMatch(text, /来源对话/);
});
