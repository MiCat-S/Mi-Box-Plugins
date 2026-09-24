"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));

function loadBiko() {
  const { artifactDir } = buildPlugin({ id: "biko", packageRoot: path.resolve(__dirname, "../biko"), entry: "v2.ts" });
  return require(path.join(artifactDir, "index.cjs")).default;
}

async function fixture(t, client) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mibot-biko-compat-")));
  const edits = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke(request) {
        return client.invoke(request);
      },
      async getReply() {
        return undefined;
      },
      async withClient(operation, signal) {
        return operation(client, client.operationSignal ?? signal);
      },
    },
  });
  await host.load(loadBiko()());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    run: text => host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text }),
  };
}

function channel(id, title, username) {
  return new Api.Channel({ id, accessHash: id + 1, title, username, photo: new Api.ChatPhotoEmpty(), date: 0 });
}

test("reports the legacy capped-count detail in progress and completion", async t => {
  const source = channel(1, "Source", "source");
  const target = channel(3, "Target", "target");
  const user = new Api.User({ id: 5, firstName: "Alice" });
  const sent = [];
  const client = {
    async getEntity(value) {
      if (value === "@source") return source;
      if (value === "@target") return target;
      return user;
    },
    async *iterMessages() {
      yield new Api.Message({
        id: 10,
        peerId: new Api.PeerChannel({ channelId: 1 }),
        fromId: new Api.PeerUser({ userId: 5 }),
        date: 1788700000,
        message: "old",
      });
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  };
  const f = await fixture(t, client);
  await f.run(".biko @source @alice 201 @target");
  assert.equal(sent.length, 1);
  assert.ok(f.edits.some(edit => /正在整理消息/.test(edit.text) && /消息数:<\/b> 200/.test(edit.text)));
  assert.match(f.edits.at(-1).text, /发送条数:<\/b> 1/);
  assert.match(f.edits.at(-1).text, /请求数量已限制为 200/);
});

test("manual username fallback resolves message senders and retries with a deep scan", async t => {
  const source = channel(1, "Source", "source");
  const target = channel(3, "Target", "target");
  let userResolution = 0;
  const limits = [];
  let senderLookups = 0;
  const sent = [];
  const client = {
    async getEntity(value) {
      if (value === "@source") return source;
      if (value === "@target") return target;
      userResolution++;
      throw new Error("username cache miss");
    },
    async *iterMessages(_peer, options) {
      limits.push(options.limit);
      if (options.limit !== 3000) return;
      yield {
        id: 12,
        date: 1788700000,
        document: { attributes: [new Api.DocumentAttributeAnimated()] },
        async getSender() {
          senderLookups++;
          return { username: "Alice" };
        },
      };
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  };
  const f = await fixture(t, client);
  await f.run(".biko @source @alice 1 @target");
  assert.equal(userResolution, 2);
  assert.deepEqual(limits, [51, 3000]);
  assert.equal(senderLookups, 1);
  assert.match(sent[0].value.message, /\[动图\]/);
  assert.match(sent[0].value.message, /过滤模式:<\/b> 手动过滤/);
});

test("manual IDs preserve precision and legacy service, location, and Date rendering", async t => {
  const source = channel(1, "Source", "source");
  const target = channel(3, "Target", "target");
  const id = "9007199254740993";
  const sent = [];
  const client = {
    async getEntity(value) {
      if (value === "@source") return source;
      if (value === "@target") return target;
      throw new Error("user unavailable");
    },
    async *iterMessages() {
      yield {
        id: 2,
        senderId: new Api.PeerUser({ userId: BigInt(id) }),
        date: new Date("2026-09-13T01:02:00Z"),
        className: "MessageService",
        action: { className: "MessageActionChatAddUser" },
      };
      yield {
        id: 1,
        senderId: new Api.PeerUser({ userId: BigInt(id) }),
        date: new Date("2026-09-12T01:02:00Z"),
        location: {},
      };
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  };
  const f = await fixture(t, client);
  await f.run(`.biko @source ${id} 2 @target`);
  assert.equal(sent.length, 1);
  assert.match(sent[0].value.message, /\[位置\]/);
  assert.match(sent[0].value.message, /\[服务消息:ChatAddUser\]/);
  assert.match(sent[0].value.message, /2026/);
});

test("cancellation during getSender stops iteration, retry, and sending", async t => {
  const source = channel(1, "Source", "source");
  const target = channel(3, "Target", "target");
  const controller = new AbortController();
  let userResolution = 0;
  let iterations = 0;
  let sent = 0;
  const client = {
    operationSignal: controller.signal,
    async getEntity(value) {
      if (value === "@source") return source;
      if (value === "@target") return target;
      userResolution++;
      throw new Error("username cache miss");
    },
    async *iterMessages() {
      iterations++;
      yield {
        id: 1,
        date: 1788700000,
        async getSender() {
          controller.abort(new DOMException("cancelled", "AbortError"));
          throw new Error("lookup interrupted");
        },
      };
      iterations++;
      yield { id: 2, date: 1788700000 };
    },
    async sendMessage() {
      sent++;
    },
  };
  const f = await fixture(t, client);
  await assert.rejects(f.run(".biko @source @alice 2 @target"), { name: "AbortError" });
  assert.equal(iterations, 1);
  assert.equal(userResolution, 1);
  assert.equal(sent, 0);
});

test("cancellation during selector retry does not enter the deep scan", async t => {
  const source = channel(1, "Source", "source");
  const target = channel(3, "Target", "target");
  const controller = new AbortController();
  let userResolution = 0;
  const limits = [];
  let sent = 0;
  const client = {
    operationSignal: controller.signal,
    async getEntity(value) {
      if (value === "@source") return source;
      if (value === "@target") return target;
      userResolution++;
      if (userResolution === 2) controller.abort(new DOMException("cancelled", "AbortError"));
      throw new Error("username cache miss");
    },
    async *iterMessages(_peer, options) {
      limits.push(options.limit);
    },
    async sendMessage() {
      sent++;
    },
  };
  const f = await fixture(t, client);
  await assert.rejects(f.run(".biko @source @alice 1 @target"), { name: "AbortError" });
  assert.equal(userResolution, 2);
  assert.deepEqual(limits, [51]);
  assert.equal(sent, 0);
});
