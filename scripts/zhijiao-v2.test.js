"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { buildPlugin } = require("../../TeleBox-Core/scripts/build-v2-plugin.cjs");
const { PluginHost } = require("../../TeleBox-Core/dist/v2/host.js");
const { artifactDir } = buildPlugin({
  id: "zhijiao",
  packageRoot: path.resolve(__dirname, "../zhijiao"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;
test("zhijiao retains all 27 original phrases verbatim", () => {
  const legacy = fs.readFileSync(path.resolve(__dirname, "../zhijiao/zhijiao.ts"), "utf8");
  const current = fs.readFileSync(path.resolve(__dirname, "../zhijiao/v2.ts"), "utf8");
  const entries = [...legacy.matchAll(/([胜阳阴]{3}): "([^"]+)"/g)];
  assert.equal(entries.length, 27);
  for (const [, key, value] of entries) assert.ok(current.includes(`${key}: "${value}"`), key);
});
test("zhijiao cancellation during animation prevents subsequent edits", async () => {
  const controller = new AbortController();
  const edits = [];
  const running = create().commands.zhijiao.handle(
    {
      message: { id: 1, chatId: "1", text: ".zhijiao", outgoing: true },
      args: [],
      prefix: ".",
      command: "zhijiao",
    },
    { signal: controller.signal, telegram: { edit: async (_, text) => edits.push(text) } },
  );
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(edits.length, 1);
});

test("zhijiao performs three local tosses and renders result", async () => {
  const edits = [];
  const signal = new AbortController().signal;
  await create().commands.zhijiao.handle(
    {
      message: { id: 1, chatId: "chat", senderId: "owner", outgoing: true, text: ".zhijiao" },
      args: [],
      prefix: ".",
      command: "zhijiao",
    },
    { signal, telegram: { edit: async (_, text) => edits.push(text) } },
  );
  assert.ok(edits.length >= 4);
  assert.equal(edits.length, 5);
  assert.match(edits[0], /第1投：…[\s\S]*第2投：…[\s\S]*第3投：…/);
  assert.match(edits[2], /第1投：[胜阳阴][\s\S]*第2投：[胜阳阴][\s\S]*第3投：…/);
  assert.match(edits.at(-1), /第1投/);
  assert.match(edits.at(-1), /第2投/);
  assert.match(edits.at(-1), /第3投/);
  assert.match(edits.at(-1), /<b>卦辞<\/b>[\s\S]*<blockquote>[胜阳阴]{3}：/);
});

test("real Host routes dynamic-prefix help without starting a toss", async t => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "zhijiao-host-")),
    edits = [];
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!!"],
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient() {},
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: "!!zhijiao help", raw: {} });
  assert.equal(edits.length, 1);
  assert.match(edits[0], /!!zhijiao/);
});
