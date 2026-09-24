"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));
const create = require(
  path.join(
    buildPlugin({ id: "sum", packageRoot: path.resolve(__dirname, "../sum"), entry: "v2.ts" }).artifactDir,
    "index.cjs",
  ),
).default;
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sum-v2-"))),
    edits = [],
    replies = [],
    sent = [],
    calls = [],
    logs = [];
  let replyAttempt = 0;
  const messages = options.messages ?? [
    { id: 9, date: Math.floor(Date.now() / 1000), message: "内容", senderId: 900719925474099312345n },
  ];
  const client = {
    async getEntity(value) {
      return { id: value, title: options.title ?? "群组", username: "group" };
    },
    async *iterMessages(_entity, input) {
      calls.push({ kind: "history", input });
      for (const item of messages) yield item;
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event, fields) {
        logs.push({ level: "error", event, fields });
      },
    },
    telegram: {
      async edit(message, text, settings) {
        if (options.editFailsOn && String(text).includes(options.editFailsOn)) throw new Error("private receipt");
        edits.push({ text, settings });
      },
      async reply(message, text, settings) {
        replyAttempt++;
        if (replyAttempt === options.replyFailsAt) throw new Error("private delivery");
        replies.push({ text, settings });
      },
      async invoke() {},
      async getReply() {},
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  const ai = definePlugin({
    apiVersion: 1,
    id: "ai",
    description: "fixture",
    commands: { ai: { description: "fixture", handle() {} } },
    services: {
      chat: {
        description: "fixture",
        handle(input) {
          calls.push({ kind: "ai", input });
          return options.output ?? "<b>摘要</b>";
        },
      },
      selection: {
        description: "fixture",
        handle() {
          return { chat: { tag: "main", model: "model" } };
        },
      },
      import_provider: {
        description: "fixture",
        handle() {
          return { tag: "imported" };
        },
      },
    },
  });
  await host.load(ai);
  await host.load(create());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    replies,
    sent,
    calls,
    logs,
    run: (text, extra = {}) =>
      host.dispatchPrimary({
        id: 20,
        chatId: "-100900719925474099399999",
        senderId: "1",
        outgoing: true,
        text,
        raw: { peerId: {} },
        ...extra,
      }),
    read: async () => JSON.parse(await fs.readFile(path.join(root, "sum/database.json"), "utf8")),
  };
}

test("sum immediate summary uses unified ai, excludes the command and preserves anonymous exact ids", async t => {
  const f = await fixture(t);
  await f.run(".sum 10 --provider vip");
  const history = f.calls.find(item => item.kind === "history"),
    ai = f.calls.find(item => item.kind === "ai");
  assert.equal(history.input.maxId, 20);
  assert.match(ai.input.text, /900719925474099312345/);
  assert.equal(ai.input.tag, "vip");
  assert.match(f.edits.at(-1).text, /摘要/);
  assert.equal(f.edits.at(-1).settings.linkPreview, false);
});

test("sum restores add options, default push target, ls and rm aliases", async t => {
  const f = await fixture(t);
  await f.run(".sum config set push -100900719925474099312345");
  await f.run(".sum add here 45m 50 --time 24 --provider vip --spoiler nightly report");
  let state = await f.read(),
    task = state.tasks[0];
  assert.equal(state.defaultPushTarget, "-100900719925474099312345");
  assert.equal(task.timeRange, 24);
  assert.equal(task.aiProvider, "vip");
  assert.equal(task.useSpoiler, true);
  assert.equal(task.remark, "nightly report");
  assert.equal(task.pushTarget, state.defaultPushTarget);
  assert.equal(task.cron, "0 */45 * * * *");
  await f.run(".sum ls");
  assert.match(f.edits.at(-1).text, /45m/);
  assert.match(f.edits.at(-1).text, /nightly report/);
  await f.run(".sum rm 1");
  state = await f.read();
  assert.deepEqual(state.tasks, []);
});

test("sum run sends scheduled output to an exact numeric push target", async t => {
  const f = await fixture(t);
  await f.run(".sum config set push -100900719925474099312345");
  await f.run(".sum add here 2h 10");
  await f.run(".sum run 1");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].peer.toString(), "-100900719925474099312345");
  assert.equal(typeof f.sent[0].peer, "object");
});

test("sum keeps the first page and fixed diagnostics when the second page fails", async t => {
  const f = await fixture(t, { output: `<b>${"x".repeat(8000)}</b>`, replyFailsAt: 1 });
  await f.run(".sum 10");
  assert.ok(f.edits.at(-1).text.length < 4096);
  assert.doesNotMatch(f.edits.at(-1).text, /摘要操作失败/);
  assert.match(f.replies.at(-1).text, /已发送 1\/3 页|已发送 1\/\d+ 页/);
  assert.equal(f.calls.filter(item => item.kind === "ai").length, 1);
  assert.ok(f.logs.some(item => item.event === "sum:output-failed"));
  assert.doesNotMatch(JSON.stringify(f.logs), /private delivery/);
});

test("sum rejects empty history before calling paid ai services", async t => {
  const f = await fixture(t, { messages: [] });
  await f.run(".sum 10");
  assert.equal(
    f.calls.some(item => item.kind === "ai"),
    false,
  );
  assert.match(f.edits.at(-1).text, /未找到可总结的消息/);
});

test("sum parses shorthand and raw five/six-field cron through a real nondefault-prefix alias", async t => {
  const f = await fixture(t);
  f.host.replacePrefixes(["!"]);
  f.host.replaceAliases({ sm: "sum" });
  await f.run("!sm add here 30m 10");
  await f.run("!sm add here 2h 10");
  await f.run("!sm add here 30 */2 * * * 25 --provider vip five field note");
  await f.run("!sm add here 0 0 9 * * * 30 --time 12 six field note");
  await f.run('!sm add here "15 */3 * * *" 40 quoted note');
  const tasks = (await f.read()).tasks;
  assert.deepEqual(
    tasks.map(task => task.cron),
    ["0 */30 * * * *", "0 0 */2 * * *", "0 30 */2 * * *", "0 0 9 * * *", "0 15 */3 * * *"],
  );
  assert.equal(tasks[2].messageCount, 25);
  assert.equal(tasks[2].aiProvider, "vip");
  assert.equal(tasks[2].remark, "five field note");
  assert.equal(tasks[3].messageCount, 30);
  assert.equal(tasks[3].timeRange, 12);
  assert.equal(tasks[3].remark, "six field note");
  assert.equal(tasks[4].messageCount, 40);
  assert.equal(tasks[4].remark, "quoted note");
});

test("sum rejects an invalid raw cron without persisting or registering a job", async t => {
  const f = await fixture(t);
  f.host.replacePrefixes(["!"]);
  f.host.replaceAliases({ sm: "sum" });
  const before = f.host.snapshot().jobs.jobs;
  await f.run("!sm add here 0 0 nope * * * 10");
  assert.deepEqual((await f.read()).tasks, []);
  assert.equal(f.host.snapshot().jobs.jobs, before);
  assert.match(f.edits.at(-1).text, /摘要操作失败/);
});

test("sum keeps English text after a five-field cron as the remark", async t => {
  const f = await fixture(t);
  await f.run(".sum add here * * * * * memo words");
  const [task] = (await f.read()).tasks;
  assert.equal(task.cron, "0 * * * * *");
  assert.equal(task.remark, "memo words");
  assert.equal(task.messageCount, 100);
});

test("sum allocates unique task ids atomically under concurrent adds", async t => {
  const f = await fixture(t);
  await Promise.all([
    f.run(".sum add here 30m 10", { chatId: "-1001", id: 31 }),
    f.run(".sum add here 2h 10", { chatId: "-1002", id: 32 }),
  ]);
  const state = await f.read();
  assert.equal(state.seq, "2");
  assert.deepEqual(state.tasks.map(task => task.id).sort(), ["1", "2"]);
});

test("sum does not turn a registered task into a failure when its success receipt fails", async t => {
  const f = await fixture(t, { editFailsOn: "✅ 已创建摘要任务" });
  await f.run(".sum add here 30m 10");
  assert.equal((await f.read()).tasks.length, 1);
  assert.ok(f.logs.some(item => item.event === "sum:receipt-failed"));
  assert.equal(
    f.logs.some(item => JSON.stringify(item).includes("private receipt")),
    false,
  );
  assert.equal(
    f.edits.some(item => String(item.text).includes("摘要操作失败")),
    false,
  );
});

test("sum paginates a long configured prompt through SDK delivery", async t => {
  const f = await fixture(t);
  await f.run(`.sum config set prompt ${"p".repeat(9000)}`);
  await f.run(".sum config set prompt show");
  assert.ok(f.edits.at(-1).text.length < 4096);
  assert.ok(f.replies.length >= 2);
  assert.ok(
    [f.edits.at(-1), ...f.replies]
      .map(item => item.text)
      .join("")
      .replace(/<[^>]+>/g, "")
      .includes("p".repeat(8000)),
  );
});

test("sum concurrent duplicate deletion never removes a different task", async t => {
  const f = await fixture(t);
  await f.run(".sum add here 30m 10");
  await f.run(".sum add here 2h 10");
  await Promise.all([
    f.run(".sum del 1", { chatId: "-1001", id: 41 }),
    f.run(".sum del 1", { chatId: "-1002", id: 42 }),
  ]);
  const tasks = (await f.read()).tasks;
  assert.deepEqual(
    tasks.map(task => task.id),
    ["2"],
  );
});

test("sum keeps a disabled task disabled when enabling cannot register its cron", async t => {
  const f = await fixture(t);
  await f.run(".sum add here 30m 10");
  await f.run(".sum disable 1");
  await f.host.unload("sum", 2000);
  const file = path.join(f.root, "sum/database.json"),
    state = JSON.parse(await fs.readFile(file, "utf8"));
  state.tasks[0].cron = "invalid cron";
  await fs.writeFile(file, JSON.stringify(state));
  await f.host.load(create());
  await f.run(".sum enable 1");
  assert.equal((await f.read()).tasks[0].disabled, true);
  assert.match(f.edits.at(-1).text, /摘要操作失败/);
});

test("sum keeps a delivered scheduled summary successful when its receipt fails", async t => {
  const f = await fixture(t, { editFailsOn: "✅ 摘要已推送" });
  await f.run(".sum add here 30m 10");
  await f.run(".sum run 1");
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.some(item => item.event === "sum:receipt-failed"));
  assert.equal(
    f.edits.some(item => String(item.text).includes("摘要操作失败")),
    false,
  );
});

test("sum serializes enable then disable across a gated scheduler registration", async t => {
  const f = await fixture(t);
  await f.run(".sum add here 30m 10");
  await f.run(".sum disable 1");
  const scheduler = f.host.scheduler,
    original = scheduler.register.bind(scheduler);
  let release, enteredResolve;
  const gate = new Promise(resolve => {
      release = resolve;
    }),
    entered = new Promise(resolve => {
      enteredResolve = resolve;
    });
  scheduler.register = async (...args) => {
    enteredResolve();
    await gate;
    return original(...args);
  };
  const enabling = f.run(".sum enable 1", { chatId: "-1001", id: 51 });
  await entered;
  const disabling = f.run(".sum disable 1", { chatId: "-1002", id: 52 });
  release();
  await Promise.all([enabling, disabling]);
  assert.equal((await f.read()).tasks[0].disabled, true);
  assert.equal(f.host.snapshot().jobs.jobs, 0);
});

test("sum serializes double enable and registers only one scheduler job", async t => {
  const f = await fixture(t);
  await f.run(".sum add here 30m 10");
  await f.run(".sum disable 1");
  const scheduler = f.host.scheduler,
    original = scheduler.register.bind(scheduler);
  let release,
    enteredResolve,
    calls = 0;
  const gate = new Promise(resolve => {
      release = resolve;
    }),
    entered = new Promise(resolve => {
      enteredResolve = resolve;
    });
  scheduler.register = async (...args) => {
    calls++;
    enteredResolve();
    await gate;
    return original(...args);
  };
  const first = f.run(".sum enable 1", { chatId: "-1001", id: 61 });
  await entered;
  const second = f.run(".sum enable 1", { chatId: "-1002", id: 62 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal((await f.read()).tasks[0].disabled, false);
  assert.equal(f.host.snapshot().jobs.jobs, 1);
});
