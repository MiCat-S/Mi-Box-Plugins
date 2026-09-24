"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const create = require(
  path.join(
    buildPlugin({ id: "crazy4", packageRoot: path.resolve(__dirname, "../crazy4"), entry: "v2.ts" }).artifactDir,
    "index.cjs",
  ),
).default;
const CHAT = "9007199254740993";
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(t, client) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "crazy4-compat-"))),
    edits = [],
    logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
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
  const run = (text = ".crazy4", extra = {}) =>
    host.dispatchPrimary({ id: 41, chatId: CHAT, senderId: CHAT, outgoing: true, text, ...extra });
  return { host, edits, logs, run };
}

test("CRAZY4-COMPAT-01 a raw receipt deletion failure never changes a successful send into failure", async t => {
  const sent = [];
  const f = await fixture(t, {
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  });
  await f.run(".crazy4", {
    replyToId: 12,
    raw: {
      peerId: "raw-peer",
      async delete() {
        throw new Error("private-delete-secret");
      },
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, "raw-peer");
  assert.equal(sent[0].value.replyTo, 12);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.logs, [{ event: "crazy4_receipt_cleanup_failed", fields: { chatId: CHAT, messageId: 41 } }]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-delete-secret/);
});

test("CRAZY4-COMPAT-02 missing raw peer uses the exact chat id and native receipt cleanup", async t => {
  const sent = [],
    deleted = [];
  const f = await fixture(t, {
    async sendMessage(peer, value) {
      sent.push({ peer: String(peer), value });
    },
    async deleteMessages(peer, ids, options) {
      deleted.push({ peer: String(peer), ids, options });
    },
  });
  await f.run();
  assert.equal(sent[0].peer, CHAT);
  assert.deepEqual(deleted, [{ peer: CHAT, ids: [41], options: { revoke: true } }]);
});

test("CRAZY4-COMPAT-03 cancellation after send performs no receipt deletion or failure feedback", async t => {
  const entered = deferred(),
    release = deferred();
  let deletes = 0;
  const client = {
    async sendMessage() {
      entered.resolve();
      await release.promise;
    },
    async deleteMessages() {
      deletes++;
    },
  };
  const f = await fixture(t, client),
    running = f.run();
  await entered.promise;
  const unloading = f.host.unload("crazy4", 1000);
  release.resolve();
  await running;
  assert.equal((await unloading).completed, true);
  assert.equal(deletes, 0);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.logs, []);
});

test("CRAZY4-COMPAT-04 send failures use fixed feedback and safe identifiers", async t => {
  const f = await fixture(t, {
    async sendMessage() {
      throw new Error("tg-secret /etc/telebox/session");
    },
  });
  await f.run(".crazy4", { raw: { peerId: "peer" } });
  assert.deepEqual(f.edits, ["文案发送失败，请稍后重试"]);
  assert.deepEqual(f.logs, [{ event: "crazy4_failed", fields: { chatId: CHAT, messageId: 41 } }]);
  assert.doesNotMatch(JSON.stringify({ edits: f.edits, logs: f.logs }), /tg-secret|\/etc\/telebox/);
});

test("CRAZY4-COMPAT-05 help arguments match exactly instead of legacy substring matching", async t => {
  const sent = [];
  const f = await fixture(t, {
    async sendMessage(_peer, value) {
      sent.push(value);
    },
    async deleteMessages() {},
  });
  await f.run(".crazy4 help");
  assert.match(f.edits.at(-1), /疯狂星期四/);
  assert.equal(sent.length, 0);
  f.edits.length = 0;
  await f.run(".crazy4 this");
  assert.equal(sent.length, 1, "an argument merely containing h still sends copy");
  assert.deepEqual(f.edits, []);
});
