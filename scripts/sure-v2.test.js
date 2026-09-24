"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const Database = require(path.join(core, "node_modules/better-sqlite3"));
const packageRoot = process.env.SURE_PACKAGE_ROOT || path.resolve(__dirname, "../sure");
const { artifactDir } = buildPlugin({ id: "sure", packageRoot, entry: "v2.ts" });
const createSure = require(path.join(artifactDir, "index.cjs")).default;

const message = (text, patch = {}) => ({
  id: 1,
  chatId: "-1009999999999999999",
  senderId: "123",
  text,
  outgoing: true,
  raw: { message: text, className: "Message", peerId: { channelId: 1n } },
  ...patch,
});

async function fixture(t, initial, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sure-v2-")));
  const dir = path.join(root, "sure");
  await fs.mkdir(dir);
  if (initial) await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(initial));
  const edits = [],
    replies = [],
    sent = [],
    deleted = [],
    dispatched = [];
  const telegram = {
    async edit(_m, text) {
      edits.push(text);
      if (extra.edit) return extra.edit(text);
    },
    async reply(_m, text) {
      replies.push(text);
    },
    async invoke() {},
    async getReply() {
      return extra.reply;
    },
    async withClient(operation, signal) {
      return operation(
        {
          async getMe() {
            return { id: 123n };
          },
          async getEntity(value) {
            return { id: 77n, username: String(value).replace("@", ""), className: "User" };
          },
          async sendMessage(_peer, options) {
            sent.push(options);
            if (extra.send) return extra.send(options, signal);
            return message(options.message, { id: 9, raw: { message: options.message } });
          },
        },
        signal,
      );
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram,
    selfId: "123",
    envelope: value => value,
    aliases: extra.aliases,
    prefixes: extra.prefixes,
  });
  await host.load({
    apiVersion: 1,
    id: "capture",
    description: "capture",
    commands: {
      ban: {
        description: "ban",
        handle(i) {
          dispatched.push([...i.args]);
        },
      },
    },
  });
  await host.load(createSure());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dir,
    host,
    edits,
    replies,
    sent,
    deleted,
    dispatched,
    read: async () => JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")),
  };
}

test("legacy/current command forms preserve large ids and raw message tails", async t => {
  const f = await fixture(t, { users: [], chats: [], messages: {}, legacyMigrated: true, retained: 1 });
  await f.host.dispatchPrimary(message(".sure user add 90071992547409931234"));
  await f.host.dispatchPrimary(message(".sure chat add -10090071992547409931234"));
  await f.host.dispatchPrimary(message(".sure msg add first line\nsecond\tline"));
  await f.host.dispatchPrimary(message(".sure msg redirect 1 .ban"));
  assert.equal((await f.read()).messages[0].redirect, ".ban");
  await f.host.dispatchPrimary(message(".sure msg redirect 1"));
  const state = await f.read();
  assert.deepEqual(state.users, ["90071992547409931234"]);
  assert.deepEqual(state.chats, ["-10090071992547409931234"]);
  assert.deepEqual(state.messages, [{ id: 1, msg: "first line\nsecond\tline" }]);
  assert.equal(Object.hasOwn(state.messages[0], "redirect"), false);
  assert.equal(state.retained, 1);
});

test("a failed success receipt does not turn a committed entity update into a lookup error", async t => {
  const f = await fixture(
    t,
    { users: [], chats: [], messages: [], legacyMigrated: true },
    {
      edit: async text => {
        if (text.startsWith("sure user 已添加")) throw new Error("receipt failed");
      },
    },
  );
  await f.host.dispatchPrimary(message(".sure add 456"));
  assert.deepEqual((await f.read()).users, ["456"]);
  assert.equal(f.edits.includes("无法获取用户信息"), false);
});

test("alias routing retains the canonical raw multiline tail", async t => {
  const f = await fixture(
    t,
    { users: [], chats: [], messages: [], legacyMigrated: true },
    { aliases: { grant: "sure msg add" } },
  );
  await f.host.dispatchPrimary(message(".grant first line\nsecond line"));
  assert.equal((await f.read()).messages[0].msg, "first line\nsecond line");
});

test("empty command renders complete help with the active non-default prefix", async t => {
  const f = await fixture(t, { users: [], chats: [], messages: [], legacyMigrated: true }, { prefixes: ["<&"] });
  await f.host.dispatchPrimary(
    message("<&sure", { raw: { message: "<&sure", className: "Message", peerId: { channelId: 1n } } }),
  );
  assert.match(f.edits[0], /<code>&lt;&amp;sure add 用户ID\/@用户名<\/code>/);
  assert.match(f.edits[0], /sure msg redirect ID 文本/);
});

test("relay preserves entities/reply and command suffix, dispatches then deletes trigger", async t => {
  const f = await fixture(t, {
    users: ["456"],
    chats: [message("").chatId.slice(4)],
    messages: [{ id: 1, msg: "_command:/sb", redirect: ".ban" }],
    legacyMigrated: true,
  });
  const deleted = [];
  await f.host.dispatchListeners(
    message("/sb 90071992547409931234", {
      outgoing: false,
      senderId: "456",
      replyToId: 66,
      topicId: 88,
      raw: {
        message: "/sb 90071992547409931234",
        peerId: { channelId: 1n },
        async delete(options) {
          deleted.push(options);
        },
      },
    }),
  );
  assert.equal(f.sent[0].message, ".ban 90071992547409931234");
  assert.equal(f.sent[0].replyTo, 66);
  assert.equal(f.sent[0].topMsgId, 88);
  assert.deepEqual(f.dispatched, [["90071992547409931234"]]);
  assert.deepEqual(deleted, [{ revoke: true }]);
  await f.host.dispatchListeners(message("/sb x", { outgoing: false, senderId: "456", forwarded: true }));
  assert.equal(f.sent.length, 1);
});

test("real legacy sqlite keeps explicitly empty JSON categories", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sure-migrate-"))),
    dir = path.join(root, "sure");
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ users: [], chats: [], messages: [], retained: true }),
  );
  const db = new Database(path.join(dir, "sure.db"));
  db.exec(
    "CREATE TABLE users(uid INTEGER PRIMARY KEY,username TEXT); CREATE TABLE chats(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE msgs(id INTEGER PRIMARY KEY,msg TEXT,redirect TEXT)",
  );
  db.prepare("INSERT INTO users VALUES (?,?)").run(123, "legacy");
  db.prepare("INSERT INTO chats VALUES (?,?)").run(-456, "group");
  db.prepare("INSERT INTO msgs VALUES (?,?,?)").run(7, "hello", null);
  db.close();
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(createSure());
  await host.shutdown(1000);
  const state = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(state.users, []);
  assert.deepEqual(state.chats, []);
  assert.deepEqual(state.messages, []);
  assert.equal(state.retained, true);
  assert.equal(state.legacyMigrated, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("legacy sqlite reads integers above 2^53 exactly when JSON fields are absent", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sure-bigint-"))),
    dir = path.join(root, "sure");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ retained: true }));
  const db = new Database(path.join(dir, "sure.db"));
  db.exec(
    "CREATE TABLE users(uid INTEGER PRIMARY KEY,username TEXT); CREATE TABLE chats(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE msgs(id INTEGER PRIMARY KEY,msg TEXT,redirect TEXT)",
  );
  db.prepare("INSERT INTO users VALUES (?,?)").run(9007199254740993n, "large");
  db.prepare("INSERT INTO chats VALUES (?,?)").run(9007199254740995n, "large chat");
  db.prepare("INSERT INTO msgs VALUES (?,?,?)").run(7, "hello", null);
  db.close();
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(createSure());
  await host.shutdown(1000);
  const state = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(state.users, ["9007199254740993"]);
  assert.deepEqual(state.chats, ["9007199254740995"]);
  assert.deepEqual(state.messages, [{ id: 7, msg: "hello" }]);
  await fs.rm(root, { recursive: true, force: true });
});

test("unload during an in-flight relay never dispatches or deletes afterward", async t => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const f = await fixture(
    t,
    { users: ["456"], chats: [], messages: [{ id: 1, msg: "hello" }], legacyMigrated: true },
    {
      send: async () => {
        await gate;
        return message("hello", { id: 10 });
      },
    },
  );
  let deleted = false;
  const running = f.host.dispatchListeners(
    message("hello", {
      outgoing: false,
      senderId: "456",
      raw: {
        message: "hello",
        peerId: { channelId: 1n },
        async delete() {
          deleted = true;
        },
      },
    }),
  );
  while (!f.sent.length) await new Promise(resolve => setImmediate(resolve));
  const unloading = f.host.unload("sure", 1000);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(running);
  assert.equal(deleted, false);
  assert.deepEqual(f.dispatched, []);
});
