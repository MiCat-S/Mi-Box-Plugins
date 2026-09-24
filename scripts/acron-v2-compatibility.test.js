"use strict";
// Behavioral compatibility tests for the acron V2 parity fixes. Everything runs
// against the real plugin factory and a simulated Telegram client; no message is
// sent, deleted, banned or paid for.
process.env.TZ = process.env.TZ || "UTC";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildSync } = require(path.join(core, "node_modules/esbuild"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { Api, utils } = require(path.join(core, "node_modules/teleproto"));
const { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
const { ScopedSafeRegExp } = require(path.join(core, "dist/v2/safe-regexp.js"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { messageEnvelope } = require(path.join(core, "dist/v2/telegram.js"));
const { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));
const cron = require(path.join(core, "node_modules/cron"));

const CHAT = "-100100";
let root, factory, tasksModule;

test.before(async () => {
  root = await fs.mkdtemp(path.join(core, "temp/acron-compat-"));
  const built = buildPlugin({
    id: "acron",
    packageRoot: path.resolve(__dirname, "../acron"),
    entry: "v2.ts",
    rootDir: core,
  });
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
  buildSync({
    entryPoints: [path.resolve(__dirname, "../acron/v2/tasks.ts")],
    outfile: path.join(root, "tasks.cjs"),
    bundle: true,
    platform: "node",
    packages: "external",
  });
  tasksModule = require(path.join(root, "tasks.cjs"));
});
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const clone = value => JSON.parse(JSON.stringify(value));
const channelFor = value => {
  const raw = String(value).replace(/^-100/, "");
  return new Api.Channel({ id: returnBigInt(raw), accessHash: returnBigInt(7), title: `Chat${raw}`, megagroup: true });
};
const replyRaw = (entities, extra = {}) =>
  new Api.Message({
    id: 5,
    peerId: new Api.PeerChannel({ channelId: returnBigInt(100) }),
    message: "bold text",
    entities,
    ...extra,
  });

// Shared JSON state + a per-load environment with captured jobs and RPCs.
function createHarness(initial) {
  const state = { data: initial ? clone(initial) : { schemaVersion: 1, seq: "0", tasks: [] } };
  const makeEnv = (options = {}) => {
    const controller = new AbortController();
    const edits = [],
      replies = [],
      logs = [],
      sends = [],
      deletes = [],
      pins = [],
      unpins = [],
      forwards = [],
      reads = [],
      dispatches = [];
    const jobs = new Map();
    const safeRegexp = new ScopedSafeRegExp();
    const store = {
      read: async () => clone(state.data),
      update: async mutator => {
        state.data = clone(await mutator(clone(state.data)));
        return clone(state.data);
      },
    };
    const client = {
      sendMessage: async (target, payload) => {
        sends.push({ target, payload });
        return { id: 1 };
      },
      getMessages: async (target, params) => {
        reads.push({ target, params });
        return options.messages ?? [];
      },
      deleteMessages: async (target, ids, opts) => {
        deletes.push({ target, ids, opts });
      },
      pinMessage: async (target, id, opts) => {
        pins.push({ target, id, opts });
      },
      unpinMessage: async (target, id) => {
        unpins.push({ target, id });
      },
      invoke: async request => {
        forwards.push(request);
        return {};
      },
      getEntity: async value => (options.getEntity ? options.getEntity(value) : channelFor(value)),
    };
    const ctx = {
      signal: controller.signal,
      log: {
        info: (event, fields) => logs.push({ level: "info", event, fields }),
        error: (event, fields) => logs.push({ level: "error", event, fields }),
      },
      tasks: { run: (label, fn) => Promise.resolve().then(() => fn(controller.signal)) },
      storage: { json: () => store },
      jobs: {
        register: async (id, spec, handler) => {
          jobs.set(id, { spec, handler });
          return async () => {
            jobs.delete(id);
          };
        },
      },
      commands: {
        parse: () => undefined,
        dispatch: async sent => {
          dispatches.push(sent);
          if (options.dispatch) return options.dispatch(sent);
          return { status: "dispatched", command: "mock", pluginId: "mock" };
        },
      },
      regexp: {
        test: (pattern, input, opts) =>
          options.regexp
            ? options.regexp(pattern, input, opts)
            : safeRegexp.test(pattern, input, opts, controller.signal),
      },
      telegram: {
        edit: async (_message, text) => {
          edits.push(text);
        },
        reply: async (_message, text) => {
          replies.push(text);
        },
        invoke: async () => ({}),
        getReply: async () => options.reply,
        withClient: async operation => {
          controller.signal.throwIfAborted();
          return operation(client, controller.signal);
        },
      },
    };
    return { ctx, controller, edits, replies, logs, sends, deletes, pins, unpins, forwards, reads, dispatches, jobs };
  };
  return { state, makeEnv };
}

const invocation = (text, chatId = CHAT) => ({
  message: { id: 9, chatId, senderId: "1", text, outgoing: true },
  command: "acron",
  prefix: ".",
  args: text
    .replace(/^\.acron\b\s*/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean),
});
const dispatch = (definition, env, text, chatId) => definition.commands.acron.handle(invocation(text, chatId), env.ctx);
const runJob = (env, id) => env.jobs.get(`task_${id}`).handler(env.controller.signal);

// ---------------------------------------------------------------------------
// 1. send entities: serialize, reload, revive, real getBytes
// ---------------------------------------------------------------------------
test("send stores TL entities and resends them after reload with intact long fields", async () => {
  const harness = createHarness();
  const created = harness.makeEnv({
    reply: {
      id: 5,
      chatId: CHAT,
      text: "bold text",
      raw: replyRaw([
        new Api.MessageEntityBold({ offset: 0, length: 4 }),
        new Api.MessageEntityCustomEmoji({ offset: 0, length: 1, documentId: returnBigInt("1234567890123456789") }),
      ]),
    },
  });
  const definition = factory();
  await definition.setup(created.ctx);
  await dispatch(definition, created, `.acron send 0 0 2 * * * ${CHAT}  my   remark`);
  assert.equal(harness.state.data.tasks.length, 1);
  const stored = harness.state.data.tasks[0];
  assert.equal(stored.message, "bold text");
  assert.equal(stored.remark, "my   remark", "remark keeps internal spacing");
  assert.equal(stored.entities.length, 2);
  assert.equal(stored.entities[1].className, "MessageEntityCustomEmoji");
  assert.equal(stored.entities[1].documentId, "1234567890123456789", "long field persisted as exact decimal string");

  // Reload from persisted JSON into a fresh plugin instance and run the job.
  const reloaded = harness.makeEnv();
  const second = factory();
  await second.setup(reloaded.ctx);
  await runJob(reloaded, "1");
  assert.equal(reloaded.sends.length, 1);
  const payload = reloaded.sends[0].payload;
  assert.equal(payload.message, "bold text");
  assert.ok(payload.formattingEntities[0] instanceof Api.MessageEntityBold);
  const emoji = payload.formattingEntities[1];
  assert.ok(emoji instanceof Api.MessageEntityCustomEmoji);
  assert.equal(emoji.documentId.toString(), "1234567890123456789", "documentId precision survives revive");
  assert.ok(emoji.getBytes().length > 0, "revived entity really serializes");
});

test("send rejects media and replyMarkup instead of silently sending plain text", async () => {
  const harness = createHarness();
  const env = harness.makeEnv({
    reply: { id: 5, chatId: CHAT, text: "caption", raw: replyRaw(undefined, { media: new Api.MessageMediaPhoto({}) }) },
  });
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron send 0 0 2 * * * ${CHAT}`);
  assert.equal(harness.state.data.tasks.length, 0);
  assert.ok(env.edits.some(text => text.includes("不支持带多媒体")));

  const buttons = harness.makeEnv({
    reply: {
      id: 5,
      chatId: CHAT,
      text: "buttons",
      raw: replyRaw(undefined, { replyMarkup: new Api.ReplyInlineMarkup({ rows: [] }) }),
    },
  });
  await dispatch(definition, buttons, `.acron send 0 0 2 * * * ${CHAT}`);
  assert.equal(harness.state.data.tasks.length, 0);
  assert.ok(buttons.edits.some(text => text.includes("replyMarkup")));
});

// ---------------------------------------------------------------------------
// 2. copy keeps media + formattingEntities
// ---------------------------------------------------------------------------
test("copy re-sends the source message with its media and entities", async () => {
  const source = new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: returnBigInt(900) }),
    message: "caption",
    media: new Api.MessageMediaPhoto({}),
    entities: [new Api.MessageEntityItalic({ offset: 0, length: 3 })],
  });
  const harness = createHarness();
  const env = harness.makeEnv({ reply: { id: 7, chatId: "-100900", text: "caption", raw: source } });
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron copy 0 0 2 * * * ${CHAT}`);
  assert.equal(harness.state.data.tasks[0].fromChatId, "-100900");
  assert.equal(harness.state.data.tasks[0].fromMsgId, "7");

  const reloaded = harness.makeEnv({ messages: [source] });
  const second = factory();
  await second.setup(reloaded.ctx);
  await runJob(reloaded, "1");
  assert.equal(reloaded.sends.length, 1);
  assert.equal(reloaded.sends[0].payload.message, source, "media object passes through unchanged");
  assert.equal(reloaded.sends[0].payload.formattingEntities, source.entities);
  assert.equal(reloaded.sends[0].payload.message.media.className, "MessageMediaPhoto");
});

// ---------------------------------------------------------------------------
// 3. exact negative chat ids and topic ids
// ---------------------------------------------------------------------------
test("large negative chat ids and topic ids stay exact through creation and execution", async () => {
  const bigChat = "-1001234567890123456";
  const harness = createHarness();
  const env = harness.makeEnv({ reply: { id: 5, chatId: CHAT, text: "hi", raw: replyRaw() } });
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron send 0 0 2 * * * ${bigChat}|77`);
  const task = harness.state.data.tasks[0];
  assert.equal(task.chatId, bigChat);
  assert.equal(task.replyTo, "77");

  const reloaded = harness.makeEnv();
  const second = factory();
  await second.setup(reloaded.ctx);
  await runJob(reloaded, "1");
  assert.equal(String(reloaded.sends[0].target), bigChat, "target keeps full precision");
  assert.equal(reloaded.sends[0].payload.replyTo, 77);
});

test("forward passes topic topMsgId and precise peers", async () => {
  const source = new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: returnBigInt(900) }),
    message: "x",
  });
  const harness = createHarness();
  const env = harness.makeEnv({ reply: { id: 7, chatId: "-100900", text: "x", raw: source } });
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron forward 0 0 2 * * * -1001234567890123456|88`);
  const reloaded = harness.makeEnv();
  const second = factory();
  await second.setup(reloaded.ctx);
  await runJob(reloaded, "1");
  assert.equal(reloaded.forwards.length, 1);
  assert.equal(String(reloaded.forwards[0].topMsgId), "88");
  assert.equal(String(reloaded.forwards[0].fromPeer), "-100900");
  assert.equal(String(reloaded.forwards[0].toPeer), "-1001234567890123456");
});

// ---------------------------------------------------------------------------
// 4. full-width separator and lowercase list arguments
// ---------------------------------------------------------------------------
test("cmd keeps the first-line remark and only the second line as the command", async () => {
  const harness = createHarness();
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron cmd 0 0 2 * * * ${CHAT}  my   note\n.bf a\n.bf b`);
  const task = harness.state.data.tasks[0];
  assert.equal(task.remark, "my   note", "first-line remark keeps spacing");
  assert.equal(task.message, ".bf a", "only the second line is the command");

  const reloaded = harness.makeEnv();
  const second = factory();
  await second.setup(reloaded.ctx);
  await runJob(reloaded, "1");
  assert.equal(reloaded.sends[0].payload.message, ".bf a");
  assert.equal(harness.state.data.tasks[0].lastResult, "已执行命令", "cmd dispatches through the host route");
  assert.equal(reloaded.dispatches.length, 1, "the sent message is routed");
});

test("full-width vertical bar splits the target", async () => {
  const harness = createHarness();
  const env = harness.makeEnv({ reply: { id: 5, chatId: CHAT, text: "hi", raw: replyRaw() } });
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron send 0 0 2 * * * ${CHAT}｜88`);
  assert.equal(harness.state.data.tasks[0].chat, CHAT);
  assert.equal(harness.state.data.tasks[0].replyTo, "88");
});

test("list accepts lowercase all/type arguments and orders enabled before disabled", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "3",
    tasks: [
      {
        id: "1",
        type: "send",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        disabled: true,
      },
      {
        id: "2",
        type: "del",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        msgId: "11",
      },
      {
        id: "3",
        type: "del",
        cron: "0 0 2 * * *",
        chat: "-100900",
        chatId: "-100900",
        resolvedPeer: true,
        createdAt: "0",
        msgId: "12",
      },
    ],
  });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron LS ALL`);
  const page = env.edits.join("\n");
  assert.ok(page.includes("<code>2</code>"), "enabled del in current chat");
  assert.ok(page.includes("<code>3</code>"), "all scope includes other chats");
  assert.ok(page.indexOf("🔛") < page.indexOf("⏹"), "enabled block precedes disabled block");

  const filtered = harness.makeEnv();
  await dispatch(definition, filtered, `.acron ls del`);
  const filteredPage = filtered.edits.join("\n");
  assert.ok(filteredPage.includes("<code>2</code>"));
  assert.ok(!filteredPage.includes("<code>3</code>"), "current-chat scope filters other chats");

  const la = harness.makeEnv();
  await dispatch(definition, la, `.acron la send`);
  assert.ok(la.edits.join("\n").includes("<code>1</code>"));
});

// ---------------------------------------------------------------------------
// 5. pin flags, missing parameters, del_re validation
// ---------------------------------------------------------------------------
test("pin accepts yes/y/1/true and rejects missing flags or ids", async () => {
  const harness = createHarness();
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron pin 0 0 2 * * * ${CHAT} 5 YES y`);
  assert.equal(harness.state.data.tasks[0].notify, true);
  assert.equal(harness.state.data.tasks[0].pmOneSide, true);

  const before = harness.state.data.tasks.length;
  const missing = harness.makeEnv();
  await dispatch(definition, missing, `.acron pin 0 0 2 * * * ${CHAT} 5 yes`);
  assert.equal(harness.state.data.tasks.length, before, "missing pmOneSide adds no task");
  await dispatch(definition, missing, `.acron pin 0 0 2 * * * ${CHAT} 5`);
  assert.equal(harness.state.data.tasks.length, before, "missing flags add no task");
  await dispatch(definition, missing, `.acron unpin 0 0 2 * * * ${CHAT}`);
  assert.equal(harness.state.data.tasks.length, before, "missing unpin id adds no task");
  assert.ok(missing.edits.some(text => text.includes("请提供消息 ID")));
});

test("del_re rejects missing regex and out-of-range limits with no task and no deletion", async () => {
  const harness = createHarness();
  const env = harness.makeEnv({ messages: [{ id: 8, message: "unrelated text" }] });
  const definition = factory();
  await definition.setup(env.ctx);
  const before = harness.state.data.tasks.length;
  // Baseline reproduction: chat=100, limit=10, regex missing.
  await dispatch(definition, env, ".acron del_re 0 0 2 * * * 100 10");
  for (const bad of [
    `${CHAT} 0 /x/`,
    `${CHAT} -1 /x/`,
    `${CHAT} 0.5 /x/`,
    `${CHAT} 1001 /x/`,
    `${CHAT} x /x/`,
    `${CHAT} 10 not-a-regex(`,
    `${CHAT} 10 /x/ii`,
  ]) {
    await dispatch(definition, env, `.acron del_re 0 0 2 * * * ${bad}`);
  }
  assert.equal(harness.state.data.tasks.length, before, "no rejected del_re may add a task");
  assert.ok(
    env.edits.some(text => text.includes("1-1000")),
    "fixed range prompt",
  );
  for (const job of env.jobs.values()) await job.handler(env.controller.signal);
  assert.equal(env.deletes.length, 0, "no stored task may delete anything");
});

test("del_re accepts only in-range integer limits and stores them exactly", async () => {
  const harness = createHarness();
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, `.acron del_re 0 0 2 * * * ${CHAT} 1 /a/`);
  await dispatch(definition, env, `.acron del_re 0 0 2 * * * ${CHAT} 1000 /b/`);
  assert.deepEqual(
    harness.state.data.tasks.map(task => task.limit),
    ["1", "1000"],
  );
});

test("old out-of-range del_re rows are rejected without clamping or deleting", async () => {
  const dirty = {
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "del_re",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        limit: "1001",
        regex: "/x/",
        delivery: "pending",
      },
    ],
  };
  const harness = createHarness(dirty);
  const env = harness.makeEnv({ messages: [{ id: 8, message: "x" }] });
  const definition = factory();
  await definition.setup(env.ctx);
  await runJob(env, "1");
  assert.equal(env.deletes.length, 0, "out-of-range stored limit must not be clamped into a scan");
  assert.equal(harness.state.data.tasks[0].lastError, "DEL_RE_LIMIT");
  assert.equal(harness.state.data.tasks[0].lastResult, undefined, "must not report a completed scan");
});

test("old dirty del_re rows are re-validated at execution with zero deletion", async () => {
  const dirty = {
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "del_re",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        limit: "10",
        regex: "",
        delivery: "pending",
      },
    ],
  };
  const harness = createHarness(dirty);
  const env = harness.makeEnv({ messages: [{ id: 8, message: "unrelated text" }] });
  const definition = factory();
  await definition.setup(env.ctx);
  await runJob(env, "1");
  assert.equal(env.deletes.length, 0, "empty stored regex must not full-match delete");
  assert.equal(harness.state.data.tasks[0].lastError, "DEL_RE_REGEX");
});

test("del_re goes through the managed regexp worker and aborts with zero deletion on timeout", async () => {
  const good = {
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "del_re",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        limit: "5",
        regex: "/secret/i",
        delivery: "pending",
      },
    ],
  };
  const harness = createHarness(good);
  const env = harness.makeEnv({
    messages: [
      { id: 1, message: "SECRET" },
      { id: 2, message: "nope" },
    ],
  });
  const definition = factory();
  await definition.setup(env.ctx);
  await runJob(env, "1");
  assert.equal(env.deletes.length, 1);
  assert.deepEqual(env.deletes[0].ids, [1]);

  const timeout = createHarness(good);
  const slow = timeout.makeEnv({
    messages: [{ id: 8, message: "SECRET" }],
    regexp: () => ({ matched: false, timedOut: true }),
  });
  const timeoutDefinition = factory();
  await timeoutDefinition.setup(slow.ctx);
  await runJob(slow, "1");
  assert.equal(slow.deletes.length, 0, "timeout must not partially delete");
  assert.equal(timeout.state.data.tasks[0].lastError, "DEL_RE_TIMEOUT");
});

test("sticky del_re patterns differ from unanchored matches", async () => {
  const task = regex => ({
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "del_re",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        limit: "5",
        regex,
        delivery: "pending",
      },
    ],
  });
  const sticky = createHarness(task("/secret/y"));
  const stickyEnv = sticky.makeEnv({ messages: [{ id: 1, message: "xsecret" }] });
  const stickyDefinition = factory();
  await stickyDefinition.setup(stickyEnv.ctx);
  await runJob(stickyEnv, "1");
  assert.equal(stickyEnv.deletes.length, 0, "sticky must not match mid-string");

  const loose = createHarness(task("/secret/"));
  const looseEnv = loose.makeEnv({ messages: [{ id: 1, message: "xsecret" }] });
  const looseDefinition = factory();
  await looseDefinition.setup(looseEnv.ctx);
  await runJob(looseEnv, "1");
  assert.deepEqual(looseEnv.deletes[0]?.ids, [1], "unanchored must match mid-string");
});

test("d and v flags run through the managed worker", async () => {
  for (const regex of ["/abc/d", "/abc/v"]) {
    const harness = createHarness({
      schemaVersion: 1,
      seq: "1",
      tasks: [
        {
          id: "1",
          type: "del_re",
          cron: "0 0 2 * * *",
          chat: CHAT,
          chatId: CHAT,
          resolvedPeer: true,
          createdAt: "0",
          limit: "5",
          regex,
          delivery: "pending",
        },
      ],
    });
    const env = harness.makeEnv({ messages: [{ id: 1, message: "abc" }] });
    const definition = factory();
    await definition.setup(env.ctx);
    await runJob(env, "1");
    assert.deepEqual(env.deletes[0]?.ids, [1], regex);
  }
});

test("illegal del_re flags delete nothing", async () => {
  for (const regex of ["/x/ii", "/x/uv", "/x/z"]) {
    const harness = createHarness({
      schemaVersion: 1,
      seq: "1",
      tasks: [
        {
          id: "1",
          type: "del_re",
          cron: "0 0 2 * * *",
          chat: CHAT,
          chatId: CHAT,
          resolvedPeer: true,
          createdAt: "0",
          limit: "5",
          regex,
          delivery: "pending",
        },
      ],
    });
    const env = harness.makeEnv({ messages: [{ id: 1, message: "x" }] });
    const definition = factory();
    await definition.setup(env.ctx);
    await runJob(env, "1");
    assert.equal(env.deletes.length, 0, regex);
    assert.equal(harness.state.data.tasks[0].lastError, "任务执行失败", regex);
  }
});

// ---------------------------------------------------------------------------
// 6. task list: target, links, times, results, rebuild command, enable tip
// ---------------------------------------------------------------------------
test("list renders target, links, next/last times, results and rebuild commands", async () => {
  const tasks = [
    {
      id: "1",
      type: "send",
      cron: "0 0 2 * * *",
      chat: CHAT,
      chatId: CHAT,
      resolvedPeer: true,
      createdAt: "0",
      replyTo: "44",
      remark: "note",
      lastRunAt: "1700000000000",
      lastResult: "已发送 1 条消息",
    },
  ];
  const harness = createHarness({ schemaVersion: 1, seq: "1", tasks });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, ".acron list");
  const page = env.edits.join("\n");
  assert.ok(page.includes(`<code>1</code>`));
  assert.ok(page.includes("对话:"), "target chat shown");
  assert.ok(page.includes("Chat100"), "resolved display shown");
  assert.ok(page.includes("https://t.me/c/100/44"), "reply link shown");
  assert.ok(page.includes("下次:"), "next run shown");
  assert.ok(page.includes("上次:"), "last run shown");
  assert.ok(page.includes("结果:"), "result shown");
  assert.ok(page.includes("复制: <code>.acron send 0 0 2 * * *"), "copyable rebuild command");
});

test("enabling a task reports the next run and rebuild command", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "send",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        disabled: true,
      },
    ],
  });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, ".acron enable 1");
  const tip = env.edits.join("\n");
  assert.ok(tip.includes("下次执行:"));
  assert.ok(tip.includes("复制: <code>.acron send 0 0 2 * * *"));
  assert.equal(harness.state.data.tasks[0].disabled, false);
  assert.equal(env.jobs.has("task_1"), true);
});

test("enable with an invalid cron leaves the task disabled and unregistered", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "send",
        cron: "bad cron",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        disabled: true,
      },
    ],
  });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, ".acron enable 1");
  assert.equal(harness.state.data.tasks[0].disabled, true);
  assert.equal(env.jobs.has("task_1"), false);
  assert.ok(env.edits.some(text => text.includes("无法启用")));
});

test("enable keeps the task disabled when registration fails", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "1",
    tasks: [
      {
        id: "1",
        type: "send",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        disabled: true,
      },
    ],
  });
  const env = harness.makeEnv();
  env.ctx.jobs.register = async () => {
    throw new Error("Invalid scheduled job");
  };
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, ".acron enable 1");
  assert.equal(harness.state.data.tasks[0].disabled, true);
  assert.equal(env.jobs.has("task_1"), false);
  assert.ok(env.edits.some(text => text.includes("启用失败")));
});

test("long task lists paginate instead of truncating", async () => {
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    id: String(index + 1),
    type: "del",
    cron: "0 0 2 * * *",
    chat: CHAT,
    chatId: CHAT,
    resolvedPeer: true,
    createdAt: "0",
    msgId: String(1000 + index),
  }));
  const harness = createHarness({ schemaVersion: 1, seq: "40", tasks });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  await dispatch(definition, env, ".acron list");
  assert.ok(env.edits.length + env.replies.length > 1, "long list is split across messages");
});

// ---------------------------------------------------------------------------
// 7. setup resilience against old invalid cron rows
// ---------------------------------------------------------------------------
test("setup skips invalid cron rows without blocking valid tasks or deleting data", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "3",
    tasks: [
      { id: "1", type: "send", cron: "not a cron", chat: CHAT, chatId: CHAT, resolvedPeer: true, createdAt: "0" },
      {
        id: "2",
        type: "send",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        disabled: true,
      },
      {
        id: "3",
        type: "del",
        cron: "0 0 2 * * *",
        chat: CHAT,
        chatId: CHAT,
        resolvedPeer: true,
        createdAt: "0",
        msgId: "5",
      },
    ],
  });
  const env = harness.makeEnv();
  const definition = factory();
  await definition.setup(env.ctx);
  assert.equal(env.jobs.has("task_1"), false);
  assert.equal(env.jobs.has("task_2"), false);
  assert.equal(env.jobs.has("task_3"), true);
  assert.ok(env.logs.some(entry => entry.event === "acron_task_invalid_cron" && entry.fields.taskId === "1"));
  assert.equal(harness.state.data.tasks.length, 3, "dirty rows are kept");
});

test("setup continues when jobs.register rejects one task", async () => {
  const harness = createHarness({
    schemaVersion: 1,
    seq: "2",
    tasks: [
      { id: "1", type: "send", cron: "0 0 2 * * *", chat: CHAT, chatId: CHAT, resolvedPeer: true, createdAt: "0" },
      { id: "2", type: "send", cron: "0 0 2 * * *", chat: CHAT, chatId: CHAT, resolvedPeer: true, createdAt: "0" },
    ],
  });
  const env = harness.makeEnv();
  const originalRegister = env.ctx.jobs.register;
  env.ctx.jobs.register = async (id, spec, handler) => {
    if (id === "task_1") throw new Error("Invalid scheduled job");
    return originalRegister(id, spec, handler);
  };
  const definition = factory();
  await definition.setup(env.ctx);
  assert.equal(env.jobs.has("task_1"), false);
  assert.equal(env.jobs.has("task_2"), true);
  assert.ok(env.logs.some(entry => entry.event === "acron_task_register_failed" && entry.fields.taskId === "1"));
});

// ---------------------------------------------------------------------------
// Timezone: next run must be computed in Asia/Shanghai, not the process zone
// ---------------------------------------------------------------------------
test("a cron cmd task routes the sent command into the real host and runs the target handler", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, "temp/acron-dispatch-")));
  let pingRuns = 0;
  const client = {
    getEntity: async value => channelFor(value),
    sendMessage: async (_target, payload) =>
      new Api.Message({
        id: 42,
        out: true,
        message: payload.message,
        peerId: new Api.PeerChannel({ channelId: returnBigInt(100) }),
      }),
    getMessages: async () => [],
    deleteMessages: async () => {},
    pinMessage: async () => {},
    unpinMessage: async () => {},
    invoke: async () => ({}),
  };
  const host = new PluginHost({
    storageRoot: root,
    selfId: "1",
    prefixes: ["."],
    logger: { info() {}, error() {} },
    envelope: message => {
      if (!(message instanceof Api.Message)) throw new TypeError("Command dispatch requires a Telegram message");
      return messageEnvelope(message, { selfId: "1" });
    },
    telegram: {
      edit: async () => {},
      reply: async () => {},
      invoke: async () => {},
      getReply: async () => undefined,
      withClient: async (operation, signal) => {
        signal.throwIfAborted();
        return operation(client, signal);
      },
    },
  });
  t.after(async () => {
    const report = await host.shutdown(2000);
    assert.equal(report.completed, true, "dispatch host must shut down cleanly");
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "target",
      description: "target",
      commands: {
        ping: {
          description: "ping",
          handle() {
            pingRuns += 1;
          },
        },
      },
    }),
  );
  await host.load(factory());
  const text = ".acron cmd * * * * * * -100100 note\n.ping";
  assert.equal(await host.dispatchPrimary({ id: 1, chatId: "-100100", senderId: "1", outgoing: true, text }), true);
  const deadline = Date.now() + 6000;
  while (pingRuns === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(pingRuns >= 1, "the host must actually run the target handler");
});

test("next run uses Asia/Shanghai regardless of the process timezone", async () => {
  await tasksModule.ensureCron();
  const next = tasksModule.nextRunTime("0 0 2 * * *");
  const expected = new cron.CronTime("0 0 2 * * *", "Asia/Shanghai").sendAt().toJSDate();
  assert.equal(next.getTime(), expected.getTime());
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(next),
  );
  assert.equal(hour, 2, "02:00 Asia/Shanghai");
});
