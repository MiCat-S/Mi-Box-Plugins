"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "yinglish",
  packageRoot: path.resolve(__dirname, "../yinglish"),
  entry: "v2.ts",
});
const built = require(path.join(artifactDir, "index.cjs"));
const create = built.default;

function withRandom(values, use) {
  const original = Math.random;
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)];
  try {
    return use();
  } finally {
    Math.random = original;
  }
}

test("yinglish preserves the legacy random gate and conversion order", () => {
  assert.equal(
    withRandom([0.9], () => built.convert("，")),
    "，",
  );
  assert.equal(
    withRandom([0], () => built.convert("，")),
    "…",
  );
  assert.equal(
    withRandom([0.5], () => built.convert("hello")),
    "heLLo",
  );
  assert.equal(
    withRandom([0.5], () => built.convert("world")),
    "……world",
  );
  assert.equal(
    withRandom([0.5], () => built.convert("可以")),
    "岢苡",
  );
  assert.equal(
    withRandom([0.5], () => built.convert("123")),
    "……123",
  );
  assert.equal(
    withRandom([0, 0], () => built.convert("可以")),
    "可…可以",
  );
});

test("yinglish keeps supplementary Unicode characters intact", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const value of ["😀", "𠮷"]) {
    const converted = withRandom([0.5], () => built.convert(value));
    assert.ok(converted.includes(value));
    assert.doesNotMatch(converted, lone);
    const circled = withRandom([0, 0], () => built.convert(value));
    assert.equal(circled, "…⭕");
    assert.doesNotMatch(circled, lone);
  }
});

async function fixture(t, { reply = "reply <&>", failPage = 0 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-yinglish-v2-"))),
    edits = [],
    replies = [],
    logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(name, data) {
        logs.push({ name, data });
      },
    },
    telegram: {
      async edit(_, text) {
        edits.push(text);
        if (failPage === 1) throw new Error("first");
      },
      async reply(_, text) {
        replies.push(text);
        if (failPage === replies.length + 1) throw new Error("later");
      },
      async invoke() {},
      async getReply() {
        return { id: 2, text: reply };
      },
      async withClient() {},
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { host, edits, replies, logs };
}

test("yinglish uses dynamic help and converts replied pure text safely in a real host", async t => {
  const f = await fixture(t);
  const original = Math.random;
  Math.random = () => 0.9;
  try {
    await f.host.dispatchPrimary({
      id: 1,
      chatId: "1",
      senderId: "1",
      outgoing: true,
      text: ".yinglish",
      replyToId: 2,
    });
  } finally {
    Math.random = original;
  }
  assert.match(f.edits.at(-1), /reply &lt;&amp;&gt;/);
  const pages = [];
  await create().commands.yinglish.handle(
    { args: [], prefix: "!!", message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
      },
    },
  );
  assert.match(pages.at(-1), /!!yinglish/);
});

test("yinglish paginates the complete transformed text", async t => {
  const input = Array.from({ length: 900 }, (_, index) => `token${index}`).join(" "),
    f = await fixture(t);
  const original = Math.random;
  Math.random = () => 0.9;
  try {
    await f.host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: `.yinglish ${input}` });
  } finally {
    Math.random = original;
  }
  const output = [...f.edits, ...f.replies].join("");
  assert.ok(f.replies.length > 0);
  assert.match(output, /token0/);
  assert.match(output, /token899/);
  assert.ok([...f.edits, ...f.replies].every(page => page.length <= 4096));
});

test("yinglish continuation failure preserves the first page and reports a fixed interruption", async t => {
  const f = await fixture(t, { failPage: 2 });
  const input = "a".repeat(4096);
  const original = Math.random;
  Math.random = () => 0.9;
  try {
    await f.host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: `.yinglish ${input}` });
  } finally {
    Math.random = original;
  }
  assert.equal(f.edits.length, 2);
  assert.doesNotMatch(f.edits.join("") + f.replies.join(""), /转换结果发送失败|later/);
  assert.match(f.replies.at(-1), /已发送 1\/3 页/);
  assert.equal(f.logs[0].name, "yinglish_page_delivery_failed");
});

test("yinglish cancellation after reply lookup publishes no late conversion", async () => {
  const controller = new AbortController(),
    edits = [];
  let resolveReply;
  const reply = new Promise(resolve => {
    resolveReply = resolve;
  });
  const work = create().commands.yinglish.handle(
    { args: [], prefix: ".", message: { id: 1, chatId: "1", text: "", outgoing: true, replyToId: 2 } },
    {
      signal: controller.signal,
      telegram: {
        async getReply() {
          return reply;
        },
        async edit(_, text) {
          edits.push(text);
        },
        async reply() {},
      },
    },
  );
  controller.abort(new Error("stop"));
  resolveReply({ id: 2, text: "late text" });
  await assert.rejects(work, /stop/);
  assert.deepEqual(edits, []);
});
