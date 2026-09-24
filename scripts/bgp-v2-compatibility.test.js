"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));

async function fixture(t, fetch, client) {
  const { artifactDir } = buildPlugin({ id: "bgp", packageRoot: path.resolve(__dirname, "../bgp"), entry: "v2.ts" });
  const create = require(path.join(artifactDir, "index.cjs")).default;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-bgp-compat-")));
  const edits = [],
    replies = [],
    logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info(event, fields) {
        logs.push({ event, fields });
      },
      error() {},
    },
    http: { fetch },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply(message, text, options) {
        replies.push({ message, text, options });
      },
      async invoke() {
        throw new Error("unexpected invoke");
      },
      async getReply() {
        return undefined;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    replies,
    logs,
    run: (text, extra = {}) =>
      host.dispatchPrimary({ id: 7, chatId: "-1009007199254740993", senderId: "1", outgoing: true, text, ...extra }),
  };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3"/></svg>';

test("successful graph transport deletes the command before sending the PNG and preserves the chat ID", async t => {
  const calls = [];
  const f = await fixture(t, async () => new Response(svg), {
    async deleteMessages(peer, ids, options) {
      calls.push(["delete", peer.toString(), ids, options]);
    },
    async sendFile(peer, options) {
      calls.push(["file", peer.toString(), await fs.readFile(options.file), options.caption]);
    },
  });
  await f.run(".bgp 1.1.1.1");
  assert.deepEqual(
    calls.map(call => call[0]),
    ["delete", "file"],
  );
  assert.equal(calls[0][1], "-1009007199254740993");
  assert.deepEqual(calls[0][2], [7]);
  assert.equal(calls[1][1], "-1009007199254740993");
  assert.deepEqual(calls[1][2].subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("DNS preserves every escaped record across bounded SDK rich-text pages", async t => {
  const records = Array.from(
    { length: 600 },
    (_, index) => `1.1.${Math.floor(index / 250)}.${index % 250} node${index}.root${index}.test`,
  ).join(" &amp; ");
  const f = await fixture(t, async () => new Response(`<p>${records}</p>`), {});
  await f.run(".bgp dns 1.1.1.1");
  const pages = [f.edits.at(-1).text, ...f.replies.map(reply => reply.text)];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 4096 && page.isWellFormed()));
  const joined = pages
    .join("\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\d+\/\d+ 页\n?/g, "");
  for (let index = 0; index < 600; index += 1) assert.match(joined, new RegExp(`node${index}\\.root${index}\\.test`));
});

test("missing raw peer fields fall back to precise chat ID and deletion failure is logged", async t => {
  let sentPeer;
  const f = await fixture(t, async () => new Response(svg), {
    async deleteMessages() {
      throw new Error("expected delete failure");
    },
    async sendFile(peer) {
      sentPeer = peer.toString();
    },
  });
  await f.run(".bgp 1.1.1.1", { raw: { className: "Message" } });
  assert.equal(sentPeer, "-1009007199254740993");
  assert.deepEqual(
    f.logs.filter(item => item.event === "bgp_command_delete_failed"),
    [{ event: "bgp_command_delete_failed", fields: { plugin: "bgp" } }],
  );
});

test("a send failure after command deletion uses a new Telegram message for the error", async t => {
  const sent = [];
  const f = await fixture(t, async () => new Response(svg), {
    async deleteMessages() {},
    async sendFile() {
      throw new Error("transport-secret");
    },
    async sendMessage(peer, options) {
      sent.push({ peer: peer.toString(), options });
    },
  });
  await f.run(".bgp 1.1.1.1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, "-1009007199254740993");
  assert.match(sent[0].options.message, /BGP查询失败/);
  assert.doesNotMatch(sent[0].options.message, /transport-secret/);
  assert.doesNotMatch(f.edits.at(-1).text, /BGP 查询失败/);
});

test("placeholder graph keeps the legacy DFZ diagnosis and direct prefix link", async t => {
  const f = await fixture(t, async () => new Response("<svg>Not_Visible in_DFZ</svg>"), {
    async deleteMessages() {
      throw new Error("must not delete");
    },
    async sendFile() {
      throw new Error("must not send");
    },
  });
  await f.run(".bgp 1.1.1.1");
  assert.match(f.edits.at(-1).text, /DFZ 中不可见/);
  assert.match(f.edits.at(-1).text, /https:\/\/bgp\.tools\/prefix\/1\.1\.0\.0\/23/);
});
