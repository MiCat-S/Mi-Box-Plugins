"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { HTMLParser } = require(path.join(core, "node_modules/teleproto/extensions/html.js"));
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { artifactDir } = buildPlugin({
  id: "mode",
  packageRoot: process.env.MODE_TEST_SOURCE || path.resolve(__dirname, "../mode"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mode-v2-")));
  await fs.mkdir(path.join(root, "mode"), { recursive: true });
  if (options.legacy) await fs.writeFile(path.join(root, "mode/config.json"), JSON.stringify(options.legacy));
  if (options.current) await fs.writeFile(path.join(root, "mode/state-v2.json"), JSON.stringify(options.current));
  const edits = [],
    replies = [],
    parseModes = [],
    logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info(event) {
        logs.push(event);
      },
      error(event) {
        logs.push(event);
      },
    },
    telegram: {
      async edit(message, text, settings) {
        if (options.editError) throw new Error("private edit failure");
        edits.push(text);
        parseModes.push(settings?.parseMode);
      },
      async reply(_message, text) {
        if (options.replyError) throw new Error("private page failure");
        replies.push(text);
      },
      async withClient() {
        assert.fail("unexpected client");
      },
    },
  });
  let loadError;
  try {
    await host.load(create());
  } catch (error) {
    loadError = error;
    if (!options.loadError) throw error;
  }
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    replies,
    parseModes,
    logs,
    root,
    host,
    loadError,
    listen: patch =>
      host.dispatchListeners({
        id: 2,
        chatId: "1",
        senderId: "1",
        outgoing: true,
        text: "text",
        ...patch,
      }),
    run: (args, chatId = "1") =>
      host.dispatchPrimary({
        id: 1,
        chatId,
        senderId: "1",
        outgoing: true,
        text: `.mode ${args}`,
      }),
  };
}
test("mode reports local and global configuration", async t => {
  const f = await fixture(t);
  await f.run("bold");
  await f.run("global italic");
  await f.run("");
  assert.match(f.edits.at(-1), /当前会话模式：<\/b> <code>bold/);
  assert.match(f.edits.at(-1), /全局模式：<\/b> <code>italic/);
  await f.run("global invalid");
  await f.run("global");
  assert.match(f.edits.at(-1), /italic/);
});
test("mode styles outgoing text, skips edited/incoming messages and dynamic commands", async t => {
  const f = await fixture(t);
  await f.run("bold");
  await f.listen({ text: "<hello & world>" });
  assert.equal(f.edits.at(-1), "<b>&lt;hello &amp; world&gt;</b>");
  const count = f.edits.length;
  await f.listen({ outgoing: false });
  await f.listen({ edited: true });
  f.host.replacePrefixes(["!!"]);
  await f.listen({ text: "!!anything" });
  await f.listen({ text: "/start" });
  assert.equal(f.edits.length, count);
  await f.listen({ text: ".ordinary" });
  assert.equal(f.edits.at(-1), "<b>.ordinary</b>");
});
test("mode enforces whitelist and blacklist before global formatting", async t => {
  const f = await fixture(t);
  await f.run("global italic");
  await f.run("whitelist add", "2");
  const count = f.edits.length;
  await f.listen({});
  assert.equal(f.edits.length, count);
  await f.listen({ chatId: "2" });
  assert.equal(f.edits.at(-1), "<i>text</i>");
  await f.run("blacklist add", "2");
  const blocked = f.edits.length;
  await f.listen({ chatId: "2" });
  assert.equal(f.edits.length, blocked);
});
test("mode preserves updates from different chats and deduplicates lists", async t => {
  const f = await fixture(t);
  await Promise.all([f.run("bold", "1"), f.run("italic", "2")]);
  await f.run("", "1");
  assert.match(f.edits.at(-1), /当前会话模式：<\/b> <code>bold/);
  await f.run("", "2");
  assert.match(f.edits.at(-1), /当前会话模式：<\/b> <code>italic/);
  await Promise.all([f.run("whitelist add", "1"), f.run("whitelist add", "2")]);
  await f.run("whitelist add", "1");
  await f.run("whitelist list");
  assert.equal((f.edits.at(-1).match(/<code>/g) || []).length, 1);
  assert.match(f.edits.at(-1), /<code>1\n2<\/code>/);
  await f.run("whitelist rm", "1");
  await f.run("whitelist list");
  assert.doesNotMatch(f.edits.at(-1), /<code>1<\/code>/);
  assert.match(f.edits.at(-1), /<code>2<\/code>/);
});
test("mode migrates legacy fields while explicit V2 fields, including off and empty lists, win", async t => {
  const f = await fixture(t, {
    legacy: {
      chats: { 1: "bold" },
      whitelist: ["legacy"],
      blacklist: ["blocked"],
      globalMode: "italic",
      legacyExtra: { keep: 1 },
    },
    current: { schemaVersion: 1, legacyImported: false, whitelist: [], globalMode: "off", currentExtra: { keep: 2 } },
  });
  const state = JSON.parse(await fs.readFile(path.join(f.root, "mode/state-v2.json"), "utf8"));
  assert.equal(state.globalMode, "off");
  assert.deepEqual(state.whitelist, []);
  assert.deepEqual(state.blacklist, ["blocked"]);
  assert.equal(state.chats["1"], "bold");
  assert.equal(state.legacyImported, true);
  assert.deepEqual(state.legacyExtra, { keep: 1 });
  assert.deepEqual(state.currentExtra, { keep: 2 });
  await f.run("");
  assert.match(f.edits.at(-1), /当前会话模式：<\/b> <code>bold/);
  assert.match(f.edits.at(-1), /白名单：<\/b> ✖ 否/);
  assert.match(f.edits.at(-1), /黑名单：<\/b> ✖ 否/);
});
test("mode emits a real spoiler entity and logs only a fixed event when editing fails", async t => {
  const f = await fixture(t);
  await f.run("mask");
  await f.listen({ text: "a_b!" });
  const [text, entities] = HTMLParser.parse(f.edits.at(-1));
  assert.equal(text, "a_b!");
  assert.equal(entities.length, 1);
  assert.ok(entities[0] instanceof Api.MessageEntitySpoiler);
  assert.equal(f.parseModes.at(-1), "html");
  const broken = await fixture(t, { editError: true });
  await broken.listen({ text: "plain" });
  assert.deepEqual(broken.logs, []);
  await fs.writeFile(
    path.join(broken.root, "mode/state-v2.json"),
    JSON.stringify({
      schemaVersion: 1,
      legacyImported: true,
      chats: { 1: "bold" },
      whitelist: [],
      blacklist: [],
      globalMode: "off",
    }),
  );
  await broken.listen({ text: "plain" });
  assert.deepEqual(broken.logs, ["mode_message_edit_failed"]);
});
test("mode paginates complete long lists and rejects non-object migration files", async t => {
  const values = Array.from({ length: 500 }, (_, i) => `-100900719925474${String(i).padStart(4, "0")}`);
  const f = await fixture(t, { legacy: { chats: {}, whitelist: values, blacklist: [], globalMode: "off" } });
  await f.run("whitelist list");
  assert.ok(f.replies.length > 0);
  const output = [f.edits.at(-1), ...f.replies].join("\n");
  assert.match(output, new RegExp(values[0]));
  assert.match(output, new RegExp(values.at(-1)));
  const interrupted = await fixture(t, {
    legacy: { chats: {}, whitelist: values, blacklist: [], globalMode: "off" },
    replyError: true,
  });
  await interrupted.run("whitelist list");
  assert.ok(interrupted.logs.includes("mode_list_pagination_interrupted"));
  assert.ok(!interrupted.logs.some(value => String(value).includes("private page failure")));
  const corrupt = await fixture(t, { current: [], loadError: true });
  assert.match(corrupt.loadError.message, /MODE_CONFIG_READ_FAILED/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(corrupt.root, "mode/state-v2.json"), "utf8")), []);
});
