"use strict";
// Behavioral compatibility tests for the autorepeat V2 parity fixes against autorepeat/autorepeat.ts:
//   1) The original stored each daily-limit entry under `contentKey` (text <=50 chars, else
//      text.slice(0,50)+length). Migrated entries must still suppress the same content.
//   2) The original counted forwarded messages (it only checked out/sender/bot/date); the V2
//      rewrite skipped them, so two distinct forwarders no longer triggered a repeat.
//   3) A send failure must log a fixed event and non-sensitive ids, never the raw error text.
//   4) `.autorepeat list` keeps the original `(N):` header and next-page hint.
//   5) An unresolvable group falls back to the original full help text.
//   6) `.autorepeat on/off` receipts auto-delete after the original three seconds.
// Tests use the real factory / PluginHost, a simulated Telegram client and a deterministic clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const timers = require("node:timers/promises");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "autorepeat",
  packageRoot: path.resolve(__dirname, "../autorepeat"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

const CHAT = "-1009007199254740993";
const shanghaiDay = (now = Date.now()) => Math.floor((now + 8 * 3600_000) / 86400_000);
const live = () => ({
  raw: { className: "Message", sender: { className: "User", bot: false }, date: Math.floor(Date.now() / 1000) },
});
const enabledState = (patch = {}) => ({
  schemaVersion: 1,
  enabledGroups: [CHAT],
  dailyHistory: {},
  lastDay: shanghaiDay(),
  trigger: { timeWindow: 300, minUsers: 2 },
  ...patch,
});

async function hostFixture(t, { state, legacy, sendError, getEntity } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autorepeat-compat-")));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "autorepeat"), { recursive: true });
  const document = legacy ?? state;
  if (document) await fs.writeFile(path.join(root, "autorepeat/autorepeat.json"), JSON.stringify(document));
  const sent = [],
    edits = [],
    logs = [];
  const client = {
    async sendMessage(chat, options) {
      if (sendError !== undefined) throw new Error(sendError);
      sent.push({ chat: String(chat), text: options.message });
    },
    async getEntity(target) {
      return getEntity ? getEntity(target) : { className: "Channel", megagroup: true, title: `<G ${target}>` };
    },
    async deleteMessages() {},
    async getMe() {
      return { id: 1n };
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
      async edit(_m, text) {
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
  let sequence = 0;
  return {
    root,
    host,
    sent,
    edits,
    logs,
    config: async () => JSON.parse(await fs.readFile(path.join(root, "autorepeat/autorepeat.json"), "utf8")),
    say: (senderId, text, patch = {}, id = ++sequence) =>
      host.dispatchListeners({
        id,
        chatId: CHAT,
        senderId: String(senderId),
        outgoing: false,
        text,
        ...live(),
        ...patch,
      }),
    run: (chatId, text) =>
      host.dispatchPrimary({ id: ++sequence, chatId, senderId: "1", outgoing: true, text: `.autorepeat ${text}` }),
  };
}

test("AUTOREPEAT-01 migrated legacy daily_history keys still suppress the same content", async t => {
  const f = await hostFixture(t, {
    legacy: {
      cache: { autorepeat_settings: [CHAT] },
      daily_history: { [CHAT]: ["old", "x".repeat(50) + "60"] },
      last_day_check: shanghaiDay(),
      trigger_config: { timeWindow: 300, minUsers: 2 },
    },
  });
  await f.say(5, "old");
  await f.say(6, "old");
  assert.deepEqual(f.sent, [], "content migrated from the legacy daily history must not repeat");
  await f.say(5, "fresh");
  await f.say(6, "fresh");
  assert.deepEqual(f.sent, [{ chat: CHAT, text: "fresh" }], "new content still repeats exactly once");
});

test("AUTOREPEAT-02 forwarded messages count toward the trigger like the original", async t => {
  const f = await hostFixture(t, { state: enabledState() });
  await f.say(7, "forwarded text", { forwarded: true });
  await f.say(8, "forwarded text", { forwarded: true });
  assert.deepEqual(f.sent, [{ chat: CHAT, text: "forwarded text" }], "two distinct forwarders must trigger");
});

test("AUTOREPEAT-03 a send failure logs a fixed event without the raw error text", async t => {
  const secret = "sk-live-DEADBEEF /etc/telebox/secret.json";
  const f = await hostFixture(t, { state: enabledState(), sendError: secret });
  await f.say(5, "boom");
  await f.say(6, "boom");
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].event, "autorepeat:listener_failed");
  assert.deepEqual(f.logs[0].fields, { chatId: CHAT, messageId: 2 });
  assert.equal(JSON.stringify(f.logs[0]).includes("sk-live"), false, "credentials must not reach the log");
  assert.equal(JSON.stringify(f.logs[0]).includes("/etc/telebox"), false, "paths must not reach the log");
});

test("AUTOREPEAT-04 the unresolvable-group fallback shows the original full help", async t => {
  const f = await hostFixture(t, {
    state: enabledState({ enabledGroups: [] }),
    getEntity: () => ({ className: "User" }),
  });
  await f.host.dispatchPrimary({ id: 90, chatId: "12345", senderId: "1", outgoing: true, text: ".autorepeat" });
  const text = f.edits.at(-1);
  assert.match(text, /自动复读插件使用说明/);
  assert.match(text, /指令列表/);
  assert.match(text, /复读规则/);
});

test("AUTOREPEAT-05 list keeps the original colon and next-page hint", async t => {
  const groups = Array.from({ length: 21 }, (_, index) => `-100${index + 1}`);
  const f = await hostFixture(t, {
    state: enabledState({ enabledGroups: groups }),
    getEntity: target => ({ className: "Channel", megagroup: true, title: `G${String(target)}` }),
  });
  await f.run(CHAT, "list");
  const text = f.edits.at(-1);
  assert.match(text, /已开启自动复读群组 \(21\):/);
  assert.match(text, /使用 <code>\.autorepeat list 2<\/code> 查看下一页/);
});

test("AUTOREPEAT-06 on/off receipts auto-delete after the original three seconds", async t => {
  const waits = [];
  t.mock.method(timers, "setTimeout", (delay, _value, options = {}) => {
    waits.push(delay);
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      resolve();
    });
  });
  const f = await hostFixture(t, { state: enabledState({ enabledGroups: [] }) });
  await f.run(CHAT, "on");
  for (let turn = 0; turn < 20 && waits.length === 0; turn++) await new Promise(setImmediate);
  assert.deepEqual(waits, [3_000], "the on receipt expires after the original three seconds");
});

test("AUTOREPEAT-07 counts distinct users once per day and ignores self/bots/media/old messages", async t => {
  const f = await hostFixture(t, { state: enabledState() });
  await f.say(5, "same");
  await f.say(5, "same");
  assert.deepEqual(f.sent, [], "the same user twice is not enough");
  await f.say(6, "same");
  assert.deepEqual(f.sent, [{ chat: CHAT, text: "same" }]);
  await f.say(7, "same");
  assert.equal(f.sent.length, 1, "the same content repeats only once per Shanghai day");
  await f.say(8, "other");
  await f.say(9, "other");
  assert.deepEqual(f.sent.at(-1), { chat: CHAT, text: "other" });
  const before = f.sent.length;
  await f.host.dispatchListeners({ id: 200, chatId: CHAT, senderId: "1", outgoing: true, text: "own" });
  await f.host.dispatchListeners({ id: 201, chatId: CHAT, senderId: "4", outgoing: true, text: "own" });
  await f.host.dispatchListeners({
    id: 202,
    chatId: CHAT,
    senderId: "4",
    outgoing: false,
    text: "",
    ...live(),
    raw: { sender: { className: "User", bot: false }, date: Math.floor(Date.now() / 1000) },
  });
  await f.host.dispatchListeners({
    id: 203,
    chatId: CHAT,
    senderId: "4",
    outgoing: false,
    text: "bot",
    ...live(),
    raw: { sender: { className: "User", bot: true }, date: Math.floor(Date.now() / 1000) },
  });
  await f.host.dispatchListeners({
    id: 204,
    chatId: CHAT,
    senderId: "4",
    outgoing: false,
    text: "old",
    ...live(),
    raw: { sender: { className: "User", bot: false }, date: Math.floor(Date.now() / 1000) - 3600 },
  });
  assert.equal(f.sent.length, before, "self, media, bot and stale messages are ignored");
});

test("AUTOREPEAT-08 manages scope and trigger configuration without touching other state", async t => {
  const f = await hostFixture(t, { state: enabledState({ enabledGroups: [] }) });
  await f.run(CHAT, "on");
  assert.deepEqual((await f.config()).enabledGroups, [CHAT]);
  await f.run(CHAT, "on");
  assert.deepEqual((await f.config()).enabledGroups, [CHAT], "enabling is idempotent");
  await f.run(CHAT, "off");
  assert.deepEqual((await f.config()).enabledGroups, []);
  await f.run(CHAT, "set 0 1");
  assert.match(f.edits.at(-1), /参数错误/);
  await f.run(CHAT, "set 60 3");
  assert.deepEqual((await f.config()).trigger, { timeWindow: 60, minUsers: 3 });
  await f.run(CHAT, "alloff");
  assert.deepEqual((await f.config()).enabledGroups, []);
});

test("AUTOREPEAT-09 messages with missing, invalid or non-positive dates are ignored uniformly", async t => {
  const f = await hostFixture(t, { state: enabledState() });
  const invalidDates = [undefined, "not-a-date", 0, -1];
  for (const [index, date] of invalidDates.entries()) {
    await f.say(index + 20, "invalid date", { raw: { sender: { className: "User", bot: false }, date } });
  }
  assert.deepEqual(f.sent, [], "invalid timestamps must never count toward a real-time repeat");
});

test("AUTOREPEAT-10 command failures never echo unknown error details to chat", async t => {
  const secret = "tg-secret-DEADBEEF /etc/telebox/account.session";
  const f = await hostFixture(t, {
    state: enabledState(),
    getEntity: () => {
      throw new Error(secret);
    },
  });
  await f.run(CHAT, "on @private_group");
  assert.equal(f.edits.at(-1), "❌ 操作失败，请稍后重试");
  assert.equal(
    f.edits.some(text => text.includes("tg-secret") || text.includes("/etc/telebox")),
    false,
  );
});
