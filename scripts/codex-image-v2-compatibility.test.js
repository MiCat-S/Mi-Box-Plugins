"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));

let root, factory;
test.before(async () => {
  root = await fs.mkdtemp(path.join(core, "temp/codex-image-compat-"));
  const built = buildPlugin({
    id: "codex_image",
    packageRoot: path.resolve(__dirname, "../codex_image"),
    entry: "v2.ts",
    rootDir: core,
  });
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
});
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(t, options = {}) {
  const calls = [],
    edits = [],
    replies = [],
    sent = [],
    logs = [];
  const client = {
    async sendFile(peer, value) {
      sent.push({ peer, value });
      options.onSendFile?.();
    },
    async *iterDownload(media, params) {
      if (options.iterDownload) {
        yield* options.iterDownload(media, params);
        return;
      }
      yield Buffer.from("reference");
    },
  };
  const host = new PluginHost({
    storageRoot: await fs.mkdtemp(path.join(root, "host-")),
    prefixes: options.prefixes ?? ["."],
    aliases: options.aliases,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    telegram: {
      async edit(_message, text, settings, signal) {
        signal.throwIfAborted();
        options.onEdit?.(text);
        edits.push({ text, settings });
      },
      async reply(_message, text, settings, signal) {
        signal.throwIfAborted();
        replies.push({ text, settings });
      },
      async invoke() {},
      async getReply() {
        return options.reply;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(
    definePlugin({
      id: "ai",
      apiVersion: 1,
      description: "fixture ai",
      commands: {},
      services: {
        image: {
          description: "fixture",
          async handle(input) {
            calls.push(input);
            return options.service
              ? options.service(input)
              : [{ data: Buffer.from("generated"), mimeType: "image/png", revisedPrompt: "refined" }];
          },
        },
      },
    }),
  );
  await host.load(factory());
  t.after(async () => {
    await host.shutdown(1000);
  });
  return {
    host,
    calls,
    edits,
    replies,
    sent,
    logs,
    run: (text, message = {}) => {
      const raw =
        message.raw === null
          ? undefined
          : {
              message: text,
              peerId: {},
              async delete() {
                options.onDelete?.();
              },
              ...message.raw,
            };
      return host.dispatchPrimary({ id: 10, chatId: "-1001", senderId: "1", outgoing: true, text, ...message, raw });
    },
  };
}

test("preserves the original multiline prompt and elapsed caption", async t => {
  const f = await fixture(t);
  await f.run(".cximg first line\nsecond   line");
  assert.equal(f.calls[0].prompt, "first line\nsecond   line");
  assert.match(f.sent[0].value.caption, /<b>耗时:<\/b> \d+秒/);
  assert.match(f.sent[0].value.caption, /<b>修订提示词:<\/b>/);
});

test("preserves multiline prompt after a non-default prefix and longest multiword alias", async t => {
  const f = await fixture(t, { prefixes: ["!!", "!"], aliases: { "make some art": "cximg" } });
  await f.run("!!make some art first line\nsecond   line");
  assert.equal(f.calls[0].prompt, "first line\nsecond   line");
});

test("prepends alias-injected arguments while preserving the original multiline tail", async t => {
  const f = await fixture(t, { prefixes: ["!"], aliases: { draw: "cximg painted" } });
  await f.run("!draw cat\n blue");
  assert.equal(f.calls[0].prompt, "painted cat\n blue");
});

test("a text reply remains a text-only generation request", async t => {
  const f = await fixture(t, { reply: { id: 8, text: "context only", raw: { className: "Message" } } });
  await f.run(".cximg draw", { replyToId: 8 });
  assert.equal(Object.hasOwn(f.calls[0], "input"), false);
  assert.equal(f.sent.length, 1);
});

test("long generation retains the original periodic progress receipt", async t => {
  let finish;
  const original = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => original(callback, delay === 20000 ? 0 : delay, ...args);
  try {
    const f = await fixture(t, {
      service: () =>
        new Promise(resolve => {
          finish = () => resolve([{ data: Buffer.from("generated") }]);
        }),
      onEdit(text) {
        if (text.includes("正在等待 AI 返回结果")) finish();
      },
    });
    await f.run(".cximg slow draw");
    assert.match(f.edits[1].text, /正在等待 AI 返回结果/);
    assert.match(f.edits[1].text, /已耗时：\d+秒/);
  } finally {
    global.setTimeout = original;
  }
});

test("long prompt and revision use a bounded caption and complete paginated receipts", async t => {
  const prompt = `PROMPT_START_${"甲".repeat(1400)}_PROMPT_END`;
  const revised = `REVISION_START_${"乙".repeat(1400)}_REVISION_END`;
  const f = await fixture(t, { service: async () => [{ data: Buffer.from("generated"), revisedPrompt: revised }] });
  await f.run(`.cximg ${prompt}`);
  assert.ok(f.sent[0].value.caption.length <= 1024);
  const pages = f.replies.map(value => value.text).join("\n");
  for (const marker of ["PROMPT_START_", "_PROMPT_END", "REVISION_START_", "_REVISION_END"])
    assert.match(pages, new RegExp(marker));
  assert.equal((pages.match(/甲/g) ?? []).length, 1400);
  assert.equal((pages.match(/乙/g) ?? []).length, 1400);
  assert.ok(f.replies.length >= 1);
});

test("missing raw peer falls back to the envelope chat id", async t => {
  const f = await fixture(t);
  await f.run(".cximg draw", { raw: null });
  assert.equal(String(f.sent[0].peer), "-1001");
  assert.equal(f.edits.length, 1, "a successful fallback must not emit a failure edit");
  assert.doesNotMatch(f.edits.map(value => value.text).join("\n"), /失败/);
  assert.equal(
    f.logs.some(value => value.event === "codex_image_failed"),
    false,
  );
});

test("reference download passes the active signal and cancels a hung iterator", async t => {
  let started,
    calls = 0;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, {
    reply: { id: 8, raw: { media: { photo: {} } } },
    iterDownload: async function* (_media, params) {
      assert.equal(params.requestSize, 64 * 1024);
      assert.ok(params.signal instanceof AbortSignal);
      started();
      await new Promise((_resolve, reject) =>
        params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true }),
      );
    },
    service: async () => {
      calls += 1;
      return [];
    },
  });
  const running = f.run(".cximg draw", { replyToId: 8 });
  await ready;
  assert.equal((await f.host.unload("codex_image", 1000)).completed, true);
  await running;
  assert.equal(calls, 0);
});

test("reference download preserves short chunks through the exact 20 MiB boundary", async t => {
  const chunks = [Buffer.alloc(3, 1), Buffer.alloc(10 * 1024 * 1024 - 3, 2), Buffer.alloc(10 * 1024 * 1024, 3)];
  const f = await fixture(t, {
    reply: { id: 8, raw: { media: { photo: {} } } },
    iterDownload: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  });
  await f.run(".cximg edit", { replyToId: 8 });
  assert.equal(f.calls[0].input.data.length, 20 * 1024 * 1024);
  assert.deepEqual([...f.calls[0].input.data.subarray(0, 3)], [1, 1, 1]);
  assert.equal(f.calls[0].input.data.at(-1), 3);
});

test("reference download rejects the first byte beyond 20 MiB before AI dispatch", async t => {
  const f = await fixture(t, {
    reply: { id: 8, raw: { media: { photo: {} } } },
    iterDownload: async function* () {
      yield Buffer.alloc(20 * 1024 * 1024);
      yield Buffer.from([1]);
    },
  });
  await f.run(".cximg edit", { replyToId: 8 });
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /图片生成失败/);
});

test("command deletion failure does not replace a successful generated image", async t => {
  const f = await fixture(t, {
    onDelete() {
      throw new Error("private delete failure");
    },
  });
  await f.run(".cximg draw");
  assert.equal(f.sent.length, 1);
  assert.match(f.edits.at(-1).text, /图片生成完成/);
  assert.deepEqual(f.logs.at(-1), { event: "codex_image_command_delete_failed", fields: undefined });
  assert.doesNotMatch(JSON.stringify(f.logs), /private delete failure/);
});

test("completion receipt failure after a sent image stays a fixed cleanup error", async t => {
  const f = await fixture(t, {
    onDelete() {
      throw new Error("private delete failure");
    },
    onEdit(text) {
      if (text.includes("图片生成完成")) throw new Error("private receipt failure");
    },
  });
  await f.run(".cximg draw");
  assert.equal(f.sent.length, 1);
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.logs.slice(-2), [
    { event: "codex_image_command_delete_failed", fields: undefined },
    { event: "codex_image_completion_edit_failed", fields: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify({ edits: f.edits, logs: f.logs }), /private (delete|receipt) failure/);
});

test("cancellation during sendFile prevents command deletion", async () => {
  const controller = new AbortController();
  let deleted = 0;
  const message = {
    id: 10,
    chatId: "-1001",
    text: ".cximg draw",
    raw: {
      peerId: {},
      async delete() {
        deleted += 1;
      },
    },
  };
  const context = {
    signal: controller.signal,
    log: { error() {} },
    storage: {
      json: () => ({
        async read() {
          return { maxWaitMs: 600000, importedLegacy: true, aiMigrated: true };
        },
      }),
    },
    services: {
      available: () => true,
      async call() {
        return [{ data: Buffer.from("generated") }];
      },
    },
    telegram: {
      async edit() {},
      async getReply() {},
      async withClient(operation) {
        return operation(
          {
            async sendFile() {
              controller.abort();
            },
          },
          controller.signal,
        );
      },
    },
  };
  await factory().commands.cximg.handle({ message, command: "cximg", prefix: ".", args: ["draw"] }, context);
  assert.equal(deleted, 0);
});
