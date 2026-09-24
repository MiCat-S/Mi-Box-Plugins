"use strict";
// Behavioral compatibility tests for aff AFF01..03. Runs against the real
// PluginHost with simulated Telegram I/O; no live message is sent or stored.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));

let create;
test.before(() => {
  create = require(
    path.join(
      buildPlugin({ id: "aff", packageRoot: path.resolve(__dirname, "../aff"), entry: "v2.ts", rootDir: core })
        .artifactDir,
      "index.cjs",
    ),
  ).default;
});

async function hostOn(root, options = {}) {
  const edits = [],
    replies = new Map();
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: options.prefixes ?? ["."],
    aliases: options.aliases ?? {},
    logger: { info() {}, error() {} },
    telegram: {
      edit: async (message, text, opts, signal) => {
        signal.throwIfAborted();
        edits.push({ id: message.id, text, options: opts ?? {} });
      },
      reply: async () => {},
      invoke: async () => {},
      getReply: async message => replies.get(message.id),
      withClient: async (operation, signal) => operation({}, signal),
    },
  });
  await host.load(create());
  const send = (text, id = 1) => host.dispatchPrimary({ id, chatId: "chat", senderId: "1", outgoing: true, text });
  return { host, edits, replies, send };
}

async function fixture(options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/aff-compat-")));
  if (options.initial) {
    await fs.mkdir(path.join(root, "aff"));
    await fs.writeFile(path.join(root, "aff/data.json"), JSON.stringify(options.initial));
  }
  const hosts = [];
  const start = async () => {
    const current = await hostOn(root, options);
    hosts.push(current);
    return current;
  };
  let current = await start();
  const read = async () => JSON.parse(await fs.readFile(path.join(root, "aff/data.json"), "utf8"));
  const cleanup = async () => {
    for (const entry of hosts) await entry.host.shutdown(1000).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  };
  const reload = async () => {
    await current.host.shutdown(1000);
    current = await start();
    return current;
  };
  return {
    root,
    read,
    cleanup,
    reload,
    get edits() {
      return current.edits;
    },
    get send() {
      return current.send;
    },
    get replies() {
      return current.replies;
    },
  };
}

// ---------------------------------------------------------------------------
// AFF01: new saves keep HTML; legacy and historical V2 data keep their meaning
// ---------------------------------------------------------------------------
test("AFF01 new saves store format html and resend as HTML after reload", async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  f.replies.set(2, {
    id: 2,
    chatId: "chat",
    text: "<b>Aff</b> https://example.com",
    raw: { message: "<b>Aff</b> https://example.com" },
  });
  await f.send(".aff save", 2);
  const data = await f.read();
  assert.equal(data.affs[0].format, "html");
  assert.equal(data.affs[0].webPage, true);
  assert.equal(data.affs[0].web_page, undefined);

  const reloaded = await f.reload();
  await reloaded.send(".aff 1", 3);
  assert.equal(reloaded.edits.at(-1).text, "<b>Aff</b> https://example.com");
  assert.equal(reloaded.edits.at(-1).options.parseMode, "html", "new saves resend as HTML");
  assert.equal(reloaded.edits.at(-1).options.linkPreview, false, "URL entry keeps link preview off");
});

test("AFF01 legacy web_page entries send HTML while V2 webPage entries stay literal", async t => {
  const f = await fixture({
    initial: {
      affs: [
        { text: "<b>legacy</b>", web_page: true, created_at: 1 },
        { text: "<b>v2</b>", webPage: false },
      ],
    },
  });
  t.after(() => f.cleanup());
  await f.send(".aff 1", 1);
  assert.equal(f.edits.at(-1).text, "<b>legacy</b>");
  assert.equal(f.edits.at(-1).options.parseMode, "html");
  assert.equal(f.edits.at(-1).options.linkPreview, false);
  await f.send(".aff 2", 2);
  assert.equal(f.edits.at(-1).text, "<b>v2</b>");
  assert.equal(f.edits.at(-1).options.parseMode, undefined, "historical V2 entry is not reinterpreted");
  assert.equal(f.edits.at(-1).options.linkPreview, true);
});

// ---------------------------------------------------------------------------
// AFF02: real saved index and full-store writes
// ---------------------------------------------------------------------------
test("AFF02 concurrent saves report distinct indices matching stored content", async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  f.replies.set(10, { id: 10, text: "first", raw: { message: "first" } });
  f.replies.set(11, { id: 11, text: "second", raw: { message: "second" } });
  await Promise.all([f.send(".aff save", 10), f.send(".aff save", 11)]);
  const successes = f.edits.filter(edit => /当前序号/.test(edit.text));
  assert.equal(successes.length, 2);
  const ids = successes.map(edit => Number(edit.text.match(/当前序号：(\d+)/)[1])).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2]);
  const data = await f.read();
  assert.equal(data.affs.length, 2);
  for (const edit of successes) {
    const index = Number(edit.text.match(/当前序号：(\d+)/)[1]);
    const expected = edit.id === 10 ? "first" : "second";
    assert.equal(data.affs[index - 1].text, expected, "reported index matches storage");
  }
});

test("AFF02 a full store rejects the save with zero writes", async t => {
  const f = await fixture({
    initial: { affs: Array.from({ length: 32 }, (_, index) => ({ text: `entry-${index}`, webPage: false })) },
  });
  t.after(() => f.cleanup());
  f.replies.set(1, { id: 1, text: "extra", raw: { message: "extra" } });
  await f.send(".aff save", 1);
  assert.match(f.edits.at(-1).text, /已保存 32 条/);
  const data = await f.read();
  assert.equal(data.affs.length, 32);
  assert.equal(data.affs.at(-1).text, "entry-31");
});

// ---------------------------------------------------------------------------
// AFF03: restored user feedback through the real host with prefix + alias
// ---------------------------------------------------------------------------
test("AFF03 real host prefix and alias drive no-arg, index, save, list, remove and errors", async t => {
  const f = await fixture({ prefixes: ["!"], aliases: { a: "aff" } });
  t.after(() => f.cleanup());

  await f.send("!a", 1);
  assert.match(f.edits.at(-1).text, /暂无Aff信息/);
  assert.match(f.edits.at(-1).text, /!aff save/, "empty guidance uses the current prefix");

  await f.send("!a list", 2);
  assert.match(f.edits.at(-1).text, /Aff列表为空/);

  f.replies.set(3, { id: 3, text: "<b>Aff</b>", raw: { message: "<b>Aff</b>" } });
  await f.send("!a save", 3);
  assert.match(f.edits.at(-1).text, /当前序号：1/);

  await f.send("!a 1", 4);
  assert.equal(f.edits.at(-1).text, "<b>Aff</b>");
  assert.equal(f.edits.at(-1).options.parseMode, "html");

  f.replies.set(5, { id: 5, text: "second", raw: { message: "second" } });
  await f.send("!a save", 5);
  await f.send("!a list", 6);
  assert.match(f.edits.at(-1).text, /Aff 列表<\/b> · 1\/1/);
  assert.match(f.edits.at(-1).text, /!aff &lt;序号&gt;/, "multi list points at the send index");

  await f.send("!a 9", 7);
  assert.match(f.edits.at(-1).text, /找不到序号为 9/);

  await f.send("!a remove 1", 8);
  assert.match(f.edits.at(-1).text, /已删除序号 1/);
  await f.send("!a remove 5", 9);
  assert.match(f.edits.at(-1).text, /找不到序号 5/);
  await f.send("!a remove 0", 10);
  assert.match(f.edits.at(-1).text, /无效的序号/);

  await f.send("!a 1abc", 11);
  assert.match(f.edits.at(-1).text, /无效的参数/, "loose parseInt-style indices are rejected");

  await f.send("!a help", 12);
  assert.match(f.edits.at(-1).text, /!aff/);
});

test("AFF03 list keeps 10-per-page pagination and escaped Unicode previews", async t => {
  const f = await fixture({
    prefixes: ["!"],
    aliases: { a: "aff" },
    initial: {
      affs: Array.from({ length: 12 }, (_, index) => ({
        text: `entry${index + 1} <&😀`,
        webPage: false,
      })),
    },
  });
  t.after(() => f.cleanup());
  await f.send("!a list 2", 1);
  const page = f.edits.at(-1).text;
  assert.match(page, /1\/2|2\/2/);
  assert.match(page, /Aff 列表<\/b> · 2\/2/);
  assert.match(page, /entry11/);
  assert.match(page, /entry12/);
  assert.ok(page.includes("&lt;&amp;😀"));
  assert.ok(page.length < 3500);
  await f.send("!a list 3", 2);
  assert.match(f.edits.at(-1).text, /页码无效/);
});
