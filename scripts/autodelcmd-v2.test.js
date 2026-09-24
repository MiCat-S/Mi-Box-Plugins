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
  id: "autodelcmd",
  packageRoot: path.resolve(__dirname, "../autodelcmd"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

async function within(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(
  initial = { enabled: false, configVersion: 1, customRules: [{ command: "ping", delay: 10 }] },
  options = {},
) {
  let state = structuredClone(initial),
    updateTail = Promise.resolve(),
    readBarrier;
  const edits = [],
    tasks = [],
    errors = [];
  const json = {
    async read() {
      if (readBarrier) {
        const barrier = readBarrier;
        barrier.arrivals++;
        if (barrier.arrivals === barrier.count) barrier.release();
        await barrier.promise;
      }
      return structuredClone(state);
    },
    update(fn) {
      const update = async () => {
        state = await fn(structuredClone(state));
        return structuredClone(state);
      };
      if (!options.serializeUpdates) return update();
      const result = updateTail.then(update);
      updateTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const client = options.client ?? {
    async getMessages() {
      return [
        { id: 11, out: true },
        { id: 10, out: true },
      ];
    },
    async deleteMessages() {},
  };
  const context = {
    signal: new AbortController().signal,
    storage: {
      json() {
        return json;
      },
    },
    tasks: {
      run(label, fn) {
        tasks.push({ label, fn });
        return Promise.resolve();
      },
    },
    commands: {
      parse(text) {
        const found = text.match(/^([.,。$!！])([a-z0-9_]+)(?:\s+(.*))?$/i);
        return found && { prefix: found[1], command: found[2].toLowerCase(), args: found[3]?.split(/\s+/) ?? [], text };
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async withClient(op) {
        return op(client, context.signal);
      },
    },
    log: {
      info() {},
      error(...args) {
        errors.push(args);
      },
    },
  };
  const plugin = create(),
    message = { id: 10, chatId: "9007199254740993", senderId: "1", outgoing: true, saved: true, text: "" };
  return {
    plugin,
    context,
    edits,
    tasks,
    errors,
    state: () => state,
    setup: () => plugin.setup(context),
    gateReads(count) {
      let release;
      const promise = new Promise(resolve => {
        release = resolve;
      });
      readBarrier = { arrivals: 0, count, promise, release };
    },
    run: text =>
      plugin.commands.autodelcmd.handle(
        {
          command: "autodelcmd",
          prefix: ".",
          args: text.trim().split(/\s+/).filter(Boolean),
          message: { ...message, text: `.autodelcmd ${text}` },
        },
        context,
      ),
    listen: text => plugin.listeners[0].handle({ ...message, text }, context),
  };
}

test("migrates legacy rules idempotently and defaults to disabled", async () => {
  const f = fixture();
  await f.setup();
  await f.setup();
  assert.equal(f.state().schemaVersion, 2);
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.state().rules, [{ id: "1", command: "ping", delay: 10 }]);
  assert.equal(f.state().configVersion, 1);
});

test("version-zero migration adds missing defaults and assigns collision-free rule ids", async () => {
  const f = fixture({
    enabled: true,
    customRules: [
      { id: "2", command: "custom", delay: 15 },
      { command: "ping", delay: 30 },
    ],
  });
  await f.setup();
  assert.equal(f.state().configVersion, 1);
  assert.equal(
    f.state().rules.some(rule => rule.command === "lang" && rule.delay === 10),
    true,
  );
  assert.equal(f.state().rules.filter(rule => rule.command === "ping").length, 1);
  assert.equal(new Set(f.state().rules.map(rule => rule.id)).size, f.state().rules.length);
});

test("manages rules, validates conflicts, and does not schedule control commands without a rule", async () => {
  const f = fixture();
  await f.setup();
  await f.run("on");
  await f.run("add help 12 -r");
  assert.equal(
    f.state().rules.some(rule => rule.command === "help" && rule.deleteResponse),
    true,
  );
  await f.run("add help 20 -r");
  assert.match(f.edits.at(-1), /冲突/);
  await f.listen(".autodelcmd status");
  assert.equal(f.tasks.length, 0);
});

test("requires an explicit bounded integer delay and preserves case-sensitive parameters", async () => {
  const f = fixture({ schemaVersion: 2, enabled: false, rules: [], pending: {} });
  await f.setup();
  await f.run("add ping");
  await f.run("add ping 1.5");
  await f.run("add ping 86401");
  assert.deepEqual(f.state().rules, []);
  await f.run("add   ping   12   Install   -r");
  assert.deepEqual(f.state().rules, [
    { id: "1", command: "ping", delay: 12, parameters: ["Install"], deleteResponse: true },
  ]);
});

test("preserves the reachable legacy merge boundary for generic and parameter rules", async () => {
  const same = fixture({
    schemaVersion: 2,
    enabled: false,
    rules: [{ id: "1", command: "ping", delay: 10 }],
    pending: {},
  });
  await same.setup();
  await same.run("add ping 10 install");
  assert.deepEqual(same.state().rules, [{ id: "1", command: "ping", delay: 10, parameters: ["install"] }]);

  const different = fixture({
    schemaVersion: 2,
    enabled: false,
    rules: [{ id: "1", command: "ping", delay: 10 }],
    pending: {},
  });
  await different.setup();
  await different.run("add ping 20 install");
  assert.deepEqual(different.state().rules, [
    { id: "1", command: "ping", delay: 10 },
    { id: "2", command: "ping", delay: 20, parameters: ["install"] },
  ]);
});

test("serializes conflict detection and does not duplicate an identical generic rule", async () => {
  const f = fixture({ schemaVersion: 2, enabled: false, rules: [], pending: {} }, { serializeUpdates: true });
  await f.setup();
  f.gateReads(2);
  await within(Promise.all([f.run("add ping 10"), f.run("add ping 20")]));
  assert.equal(f.state().rules.filter(rule => rule.command === "ping").length, 1);
  assert.equal(f.edits.filter(text => /冲突/.test(text)).length, 1);
  const delay = f.state().rules[0].delay;
  await f.run(`add ping ${delay}`);
  assert.equal(f.state().rules.filter(rule => rule.command === "ping").length, 1);
});

test("prefers exact no-argument rules regardless of list order", async () => {
  const before = Date.now();
  const f = fixture({
    schemaVersion: 2,
    enabled: true,
    rules: [
      { id: "1", command: "ping", delay: 120 },
      { id: "2", command: "ping", delay: 10, exactMatch: true },
    ],
    pending: {},
  });
  await f.listen(".ping");
  assert.ok(f.state().pending["9007199254740993:10"].dueAt < before + 15_000);
});

test("del by command lists matching rule ids without deleting them", async () => {
  const f = fixture();
  await f.setup();
  await f.run("del ping");
  assert.equal(f.state().rules.length, 1);
  assert.match(f.edits.at(-1), /ping/);
  assert.match(f.edits.at(-1), /ID: 1/);
});

test("reset preserves already pending deletion work while disabling future matches", async () => {
  const pending = { "7:3": { chatId: "7", messageId: 3, dueAt: Date.now() + 60_000 } };
  const f = fixture({ schemaVersion: 2, enabled: true, rules: [{ id: "1", command: "ping", delay: 10 }], pending });
  await f.setup();
  await f.run("reset");
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.state().pending, pending);
});

test("matches parameter rules first and persists command/response deletion before scheduling", async () => {
  const f = fixture({
    schemaVersion: 2,
    enabled: true,
    rules: [
      { id: "1", command: "tpm", delay: 120 },
      { id: "2", command: "tpm", delay: 10, parameters: ["install"], deleteResponse: true },
    ],
    pending: {},
  });
  await f.listen(".tpm install x");
  assert.equal(Object.keys(f.state().pending).length, 2);
  assert.equal(f.tasks.length, 2);
  assert.ok(Object.values(f.state().pending).every(item => item.dueAt > Date.now()));
});

test("response selection uses the exact chat id, filters direction and future ids, and caps at three", async () => {
  let peer, options;
  const client = {
    async getMessages(value, params) {
      peer = value;
      options = params;
      return [
        { id: 15, out: false },
        { id: 14, out: true },
        { id: 13, out: true },
        { id: 12, out: true },
        { id: 11, out: true },
        { id: 9, out: true },
      ];
    },
  };
  const f = fixture(
    {
      schemaVersion: 2,
      enabled: true,
      rules: [{ id: "1", command: "help", delay: 60, deleteResponse: true }],
      pending: {},
    },
    { client },
  );
  await f.plugin.listeners[0].handle(
    { id: 10, chatId: "9007199254740993", senderId: "1", outgoing: true, saved: false, text: ".help" },
    f.context,
  );
  assert.equal(peer.value, 9007199254740993n);
  assert.deepEqual(options, { limit: 100 });
  assert.deepEqual(
    f.tasks.map(task => task.label),
    [
      "autodelcmd:9007199254740993:14",
      "autodelcmd:9007199254740993:13",
      "autodelcmd:9007199254740993:12",
      "autodelcmd:9007199254740993:10",
    ],
  );
});

test("filters incoming chats, admits Saved Messages, and deduplicates repeat delivery", async () => {
  const f = fixture({ schemaVersion: 2, enabled: true, rules: [{ id: "1", command: "ping", delay: 60 }], pending: {} });
  const incoming = { id: 20, chatId: "7", senderId: "2", outgoing: false, saved: false, text: ".ping" };
  await f.plugin.listeners[0].handle(incoming, f.context);
  assert.equal(f.tasks.length, 0);
  const saved = { ...incoming, saved: true };
  await f.plugin.listeners[0].handle(saved, f.context);
  await f.plugin.listeners[0].handle(saved, f.context);
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(Object.keys(f.state().pending), ["7:20"]);
});

test("compiled plugin restores pending work and cancels it on unload", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autodelcmd-v2-")));
  const dir = path.join(root, "autodelcmd");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      rules: [],
      pending: { "7:3": { chatId: "7", messageId: 3, dueAt: Date.now() + 60_000 } },
    }),
  );
  let deletes = 0;
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op(
          {
            deleteMessages: async () => {
              deletes++;
            },
          },
          signal,
        );
      },
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  const report = await host.unload("autodelcmd", 1000);
  assert.equal(report.completed, true);
  assert.equal(deletes, 0);
  const state = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(state.pending), ["7:3"]);
});

test("failed native deletion is sanitized and removed from persisted pending work", async () => {
  const secret = "BOT_TOKEN=should-not-leak";
  const secretName = "sk-live-should-not-leak/etc/passwd";
  let peer;
  const client = {
    async deleteMessages(value) {
      peer = value;
      const error = new Error(secret);
      error.name = secretName;
      throw error;
    },
  };
  const pending = { "9007199254740993:3": { chatId: "9007199254740993", messageId: 3, dueAt: Date.now() - 1 } };
  const f = fixture({ schemaVersion: 2, enabled: true, rules: [], pending }, { client });
  await f.setup();
  await f.tasks[0].fn(new AbortController().signal);
  assert.equal(peer.value, 9007199254740993n);
  assert.deepEqual(f.state().pending, {});
  const logged = JSON.stringify(f.errors);
  assert.equal(logged.includes(secret), false);
  assert.equal(logged.includes(secretName), false);
  assert.deepEqual(f.errors, [["autodelcmd:delete_failed"]]);
});

test("real host parser applies a Unicode prefix and longest multi-word alias before matching", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autodelcmd-alias-v2-")));
  const dir = path.join(root, "autodelcmd");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      rules: [{ id: "1", command: "tpm", delay: 60, parameters: ["install"] }],
      pending: {},
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["🙂"],
    aliases: { please: "tpm search", "please clean": "tpm install" },
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op({ deleteMessages: async () => {} }, signal);
      },
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  await host.dispatchListeners({ id: 8, chatId: "7", senderId: "1", outgoing: true, text: "🙂please clean package" });
  const state = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(state.pending), ["7:8"]);
  assert.ok(state.pending["7:8"].dueAt > Date.now());
  assert.equal((await host.unload("autodelcmd", 1000)).completed, true);
});

test("real host postprocess can schedule the autodelcmd command itself when configured", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autodelcmd-self-v2-")));
  const dir = path.join(root, "autodelcmd");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      rules: [{ id: "1", command: "autodelcmd", delay: 60 }],
      pending: {},
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op({ deleteMessages: async () => {} }, signal);
      },
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(create());
  const message = { id: 4, chatId: "7", senderId: "1", outgoing: true, text: ".autodelcmd status" };
  assert.equal(await host.dispatchPrimary(message), true);
  await host.dispatchListeners(message);
  const state = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(state.pending), ["7:4"]);
  assert.equal((await host.unload("autodelcmd", 1000)).completed, true);
});
