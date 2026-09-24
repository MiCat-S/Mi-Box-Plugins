"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api, helpers, utils } = require(path.join(core, "node_modules/teleproto"));
const create = require(
  path.join(
    buildPlugin({
      id: "premium",
      packageRoot: process.env.PREMIUM_TEST_SOURCE || path.resolve(__dirname, "../premium"),
      entry: "v2.ts",
    }).artifactDir,
    "index.cjs",
  ),
).default;
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "premium-v2-"))),
    edits = [],
    logs = [],
    targets = [],
    requests = [];
  let iterations = 0;
  const id = helpers.returnBigInt("9007199254740993"),
    chat =
      options.chat ||
      new Api.Channel({
        id,
        accessHash: helpers.returnBigInt(7),
        title: "Group",
        participantsCount: options.count ?? 100,
      });
  const client = {
    async getEntity(target) {
      targets.push(target);
      if (options.getEntity) return options.getEntity(target);
      return chat;
    },
    async getInputEntity() {
      return new Api.InputPeerChannel({ channelId: id, accessHash: helpers.returnBigInt(7) });
    },
    async invoke(request) {
      requests.push(request);
      await request.resolve(this, utils);
      assert.ok(request.getBytes().length > 0);
      if (options.invoke) return options.invoke(request);
      return { fullChat: { participantsCount: options.count ?? 100 } };
    },
    async *iterParticipants(_chat, parameters) {
      iterations++;
      assert.equal(parameters.limit, 10000);
      for (const value of options.participants || []) yield value;
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!"],
    logger: { info() {}, error: event => logs.push(event) },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(fn, signal) {
        return fn(client, signal);
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    chat,
    edits,
    logs,
    targets,
    requests,
    get iterations() {
      return iterations;
    },
    run: (text = "!premium", extra = {}) =>
      host.dispatchPrimary({ id: 1, chatId: "-1009007199254740993", senderId: "1", outgoing: true, text, ...extra }),
  };
}
test("premium counts attached ChannelParticipant users and reports progress every 100", async t => {
  const premium = new Api.User({ id: 1, firstName: "P", premium: true }),
    wrapped = new Api.ChannelParticipant({ userId: premium.id, date: 0 });
  Object.defineProperty(wrapped, "user", { value: premium });
  const values = [
    wrapped,
    new Api.User({ id: 2, firstName: "B", bot: true }),
    new Api.User({ id: 3, firstName: "D", deleted: true }),
    new Api.ChatParticipant({ userId: 4, inviterId: 1, date: 0 }),
    ...Array.from({ length: 96 }, (_, i) => new Api.User({ id: 10 + i, firstName: "U" })),
  ];
  const f = await fixture(t, { participants: values });
  await f.run("!premium", {
    raw: { peerId: new Api.PeerChannel({ channelId: helpers.returnBigInt("9007199254740993") }) },
  });
  assert.match(f.edits.at(-2), /已处理 100 个成员/);
  assert.match(f.edits.at(-1), /Premium：<b>1<\/b> \/ 97/);
  assert.match(f.edits.at(-1), /过滤 Bot 1 · 已注销 1/);
  assert.match(f.edits.at(-1), /处理成员 100/);
  assert.ok(f.requests[0] instanceof Api.channels.GetFullChannel);
});
test("premium preserves force and ignored-extra argument behavior plus complete active-prefix help", async t => {
  const blocked = await fixture(t, { count: 10000 });
  await blocked.run("!premium");
  assert.equal(blocked.iterations, 0);
  assert.match(blocked.edits.at(-1), /!premium force/);
  const forced = await fixture(t, { count: 10000 });
  await forced.run("!premium force extra");
  assert.equal(forced.iterations, 1);
  const ignored = await fixture(t, { count: 5 });
  await ignored.run("!premium unknown");
  assert.equal(ignored.iterations, 1);
  await ignored.run("!premium help");
  assert.match(ignored.edits.at(-1), /自动过滤机器人和死号/);
});
test("premium resolves rawless large channel ids without precision loss", async t => {
  const f = await fixture(t, { count: 1 });
  await f.run();
  assert.ok(f.targets[0] instanceof Api.PeerChannel);
  assert.equal(f.targets[0].channelId.toString(), "9007199254740993");
});
test("premium maps known failures without leaking arbitrary native diagnostics", async t => {
  for (const [error, expected] of [
    [new Error("CHAT_ADMIN_REQUIRED secret"), /需要管理员权限/],
    [new Error("FLOOD_WAIT_37 token"), /37 秒/],
    [new Error("private-token"), /请确认当前会话/],
  ]) {
    const f = await fixture(t, {
      getEntity: async () => {
        throw error;
      },
    });
    await f.run();
    assert.match(f.edits.at(-1), expected);
    assert.doesNotMatch(f.edits.join("\n"), /secret|token/);
    assert.deepEqual(f.logs, ["premium_scan_failed"]);
  }
});
test("premium cancellation after getEntity performs no later Telegram operation", async () => {
  const controller = new AbortController();
  let release,
    invokes = 0,
    iterations = 0;
  const gate = new Promise(resolve => {
      release = resolve;
    }),
    edits = [];
  const client = {
    async getEntity() {
      await gate;
      return new Api.Channel({ id: 1, accessHash: 2, title: "x" });
    },
    async invoke() {
      invokes++;
    },
    async *iterParticipants() {
      iterations++;
    },
  };
  const running = create().commands.premium.handle(
    {
      command: "premium",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1001", outgoing: true, text: ".premium", raw: { peerId: {} } },
    },
    {
      signal: controller.signal,
      log: { error() {} },
      telegram: { edit: async (_m, t) => edits.push(t), withClient: fn => fn(client, controller.signal) },
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release();
  await running;
  assert.equal(invokes, 0);
  assert.equal(iterations, 0);
  assert.equal(edits.length, 1);
});

test("premium reports inspected count even when the hundredth participant has no user", async t => {
  const f = await fixture(t, {
    participants: Array.from(
      { length: 100 },
      (_, i) => new Api.ChatParticipant({ userId: i + 1, inviterId: 1, date: 0 }),
    ),
  });
  await f.run();
  assert.match(f.edits.at(-2), /已处理 100 个成员/);
  assert.match(f.edits.at(-1), /处理成员 100/);
});
