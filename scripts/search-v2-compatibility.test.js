"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
const create = require(
  path.join(
    buildPlugin({ id: "search", packageRoot: path.resolve(__dirname, "../search"), entry: "v2.ts" }).artifactDir,
    "index.cjs",
  ),
).default;
async function fixture(
  t,
  client,
  state = {
    schemaVersion: 1,
    defaultChannel: "@source",
    channelList: [{ title: "Source", handle: "@source" }],
    adFilters: [],
  },
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "search-host-")));
  await fs.mkdir(path.join(root, "search"));
  await fs.writeFile(path.join(root, "search", "channel_search_config.json"), JSON.stringify(state));
  const edits = [],
    logs = [],
    host = new PluginHost({
      storageRoot: root,
      tempRoot: path.join(root, "temp"),
      logger: {
        info() {},
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
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
    host,
    edits,
    logs,
    run: (text = ".so movie", fields = {}) =>
      host.dispatchPrimary({
        id: 1,
        chatId: "-1009007199254740993",
        senderId: "7",
        outgoing: true,
        text,
        raw: { peerId: new Api.PeerChannel({ channelId: returnBigInt("9007199254740993") }), ...fields.raw },
        ...fields,
      }),
  };
}

test("search forwards an exact TL source and preserves topic routing", async t => {
  const sourcePeer = new Api.PeerChannel({ channelId: returnBigInt("9007199254740995") }),
    forwarded = [];
  const video = {
    id: 8,
    peerId: sourcePeer,
    message: "movie",
    video: { attributes: [{ className: "DocumentAttributeVideo", duration: 60 }] },
    media: {},
  };
  const f = await fixture(t, {
    async getEntity() {
      return { className: "Channel", megagroup: true };
    },
    async getMessages() {
      return [video];
    },
    async forwardMessages(peer, options) {
      assert.ok(peer.getBytes().length > 0);
      assert.ok(options.fromPeer.getBytes().length > 0);
      forwarded.push(options);
    },
  });
  await f.run(".so movie", { topicId: 44 });
  assert.equal(forwarded[0].fromPeer.channelId.toString(), "9007199254740995");
  assert.equal(forwarded[0].topMsgId, 44);
});

test("cancellation aborts a pending video fallback download with no upload or command delete", async t => {
  let enteredResolve,
    nextCalls = 0,
    deleted = 0,
    sent = 0,
    downloadSignal;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    controller = new AbortController(),
    selected = {
      id: 8,
      peerId: "source",
      message: "movie",
      video: { attributes: [{ className: "DocumentAttributeVideo", duration: 60 }] },
      media: {},
      document: { size: 1 },
    },
    state = {
      schemaVersion: 1,
      defaultChannel: "@source",
      channelList: [{ title: "Source", handle: "@source" }],
      adFilters: [],
    };
  const client = {
    async getEntity() {
      return { className: "Channel", megagroup: true };
    },
    async getMessages() {
      return [selected];
    },
    async *iterDownload(_media, options) {
      downloadSignal = options.signal;
      nextCalls++;
      enteredResolve();
      await new Promise((resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
      );
      nextCalls++;
      yield Buffer.from("late");
    },
    async sendFile() {
      sent++;
    },
  };
  const context = {
    signal: controller.signal,
    log: { error() {} },
    storage: {
      json() {
        return {
          async read() {
            return structuredClone(state);
          },
          async update(fn) {
            state = await fn(structuredClone(state));
            return state;
          },
        };
      },
    },
    files: {
      async withTemp(fn) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cancel-"));
        try {
          return await fn(dir, controller.signal);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    },
    telegram: {
      async edit() {},
      async withClient(fn) {
        return fn(client, controller.signal);
      },
    },
  };
  const running = create().commands.so.handle(
    {
      command: "so",
      prefix: ".",
      args: ["movie", "-s"],
      message: {
        id: 1,
        chatId: "-1001",
        senderId: "1",
        outgoing: true,
        text: ".so movie -s",
        raw: {
          peerId: new Api.InputPeerSelf(),
          async delete() {
            deleted++;
          },
        },
      },
    },
    context,
  );
  await entered;
  controller.abort();
  await running;
  assert.equal(downloadSignal.aborted, true);
  assert.equal(nextCalls, 1);
  assert.equal(sent, 0);
  assert.equal(deleted, 0);
});

test("search import rejects an oversized declared backup before starting download", async () => {
  let downloads = 0;
  const signal = new AbortController().signal,
    edits = [];
  const context = {
    signal,
    log: { error() {} },
    storage: {
      json() {
        return {
          async read() {
            return { schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: [] };
          },
          async update(value) {
            return value;
          },
        };
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async getReply() {
        return { raw: { media: {}, document: { size: 256 * 1024 + 1 } } };
      },
      async withClient(fn) {
        return fn(
          {
            async *iterDownload() {
              downloads++;
              yield Buffer.from("@x");
            },
          },
          signal,
        );
      },
    },
  };
  await create().commands.so.subcommands.import.handle(
    {
      command: "so",
      subcommand: "import",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "1", outgoing: true, text: ".so import" },
    },
    context,
  );
  assert.equal(downloads, 0);
  assert.match(edits.at(-1), /256 KiB/);
});

test("search hides arbitrary storage and source errors from output and logs", async t => {
  const evil = Object.assign(new Error("https://user:pass@secret.invalid/private"), { name: "MaliciousTransport" }),
    edits = [],
    logs = [],
    signal = new AbortController().signal,
    context = {
      signal,
      log: {
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
      storage: {
        json() {
          return {
            async read() {
              throw evil;
            },
            async update() {
              throw evil;
            },
          };
        },
      },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
      },
    };
  await create().commands.so.handle(
    { command: "so", prefix: ".", args: ["movie"], message: { id: 1, chatId: "1", outgoing: true, text: ".so movie" } },
    context,
  );
  assert.equal(edits.at(-1), "❌ 错误：\n搜索操作失败，请稍后重试");
  assert.doesNotMatch(JSON.stringify({ edits, logs }), /user:pass|secret\.invalid|MaliciousTransport/);
});

test("search source logs use only a local fixed category", async t => {
  const evil = Object.assign(new Error("private-message"), { code: "SECRET123", name: "SecretName" }),
    f = await fixture(t, {
      async getEntity() {
        throw evil;
      },
    });
  await f.run();
  assert.deepEqual(f.logs, [
    { event: "search_source_failed", fields: { source: "@source", category: "SOURCE_FAILED" } },
  ]);
  assert.doesNotMatch(JSON.stringify({ edits: f.edits, logs: f.logs }), /SECRET123|SecretName|private-message/);
});

test("search add failures paginate every escaped source without leaking native errors", async () => {
  let state = { schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: [] };
  const edits = [],
    replies = [],
    signal = new AbortController().signal,
    handles = Array.from({ length: 180 }, (_, i) => `@bad<${i}>`),
    context = {
      signal,
      log: { error() {} },
      storage: {
        json() {
          return {
            async read() {
              return structuredClone(state);
            },
            async update(fn) {
              state = await fn(structuredClone(state));
              return state;
            },
          };
        },
      },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply(_m, text) {
          replies.push(text);
        },
        async withClient(fn) {
          return fn(
            {
              async getEntity() {
                throw new Error("native-secret");
              },
            },
            signal,
          );
        },
      },
    };
  await create().commands.so.subcommands.add.handle(
    {
      command: "so",
      subcommand: "add",
      prefix: ".",
      args: [handles.join("\\")],
      message: { id: 1, chatId: "1", outgoing: true, text: ".so add" },
    },
    context,
  );
  const pages = [...edits.slice(1), ...replies],
    joined = pages.join("\n");
  assert.ok(pages.length > 1, JSON.stringify({ edits, replies }));
  assert.ok(pages.every(page => page.length <= 3500));
  assert.equal((joined.match(/无法访问/g) || []).length, 180, joined);
  assert.match(joined, /@bad(?:&lt;|%3C)0(?:&gt;|%3E)/);
  assert.doesNotMatch(joined, /native-secret/);
});

test("search channel and ad lists paginate every escaped field", async () => {
  const channels = Array.from({ length: 400 }, (_, i) => ({ title: `频道<&${i}>`, handle: `@c${i}` })),
    filters = Array.from({ length: 500 }, (_, i) => `词<&${i}>`),
    state = { schemaVersion: 1, defaultChannel: "@c0", channelList: channels, adFilters: filters },
    edits = [],
    replies = [],
    signal = new AbortController().signal,
    context = {
      signal,
      log: { error() {} },
      storage: {
        json() {
          return {
            async read() {
              return state;
            },
          };
        },
      },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async reply(_m, text) {
          replies.push(text);
        },
      },
    };
  const message = { id: 1, chatId: "1", outgoing: true, text: "" };
  await create().commands.so.subcommands.list.handle(
    { command: "so", subcommand: "list", prefix: ".", args: [], message },
    context,
  );
  await create().commands.so.subcommands.ad.subcommands.list.handle(
    { command: "so", subcommands: ["ad", "list"], prefix: ".", args: [], message },
    context,
  );
  const output = [...edits, ...replies].join("\n");
  assert.ok([...edits, ...replies].every(page => page.length <= 3500));
  for (const index of [0, 199, 399])
    assert.match(output, new RegExp(`频道(?:&lt;|%3C)(?:&amp;|&)${index}(?:&gt;|%3E)`));
  for (const index of [0, 249, 499]) assert.match(output, new RegExp(`词(?:&lt;|%3C)(?:&amp;|&)${index}(?:&gt;|%3E)`));
});

test("search cancellation after GetFullChannel prevents linked entity lookup and persistence", async () => {
  const controller = new AbortController();
  let enteredResolve,
    releaseResolve,
    linkedReads = 0;
  const entered = new Promise(resolve => {
      enteredResolve = resolve;
    }),
    release = new Promise(resolve => {
      releaseResolve = resolve;
    });
  let state = { schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: [] };
  const client = {
    async getEntity(value) {
      if (value === "@channel") return { className: "Channel", title: "C", broadcast: true, megagroup: false };
      linkedReads++;
      return {};
    },
    async invoke() {
      enteredResolve();
      await release;
      return { fullChat: { linkedChatId: 9 } };
    },
  };
  const context = {
    signal: controller.signal,
    log: { error() {} },
    storage: {
      json() {
        return {
          async read() {
            return structuredClone(state);
          },
          async update(fn) {
            state = await fn(structuredClone(state));
            return state;
          },
        };
      },
    },
    telegram: {
      async edit() {},
      async reply() {},
      async withClient(fn) {
        return fn(client, controller.signal);
      },
    },
  };
  const running = create().commands.so.subcommands.add.handle(
    {
      command: "so",
      subcommand: "add",
      prefix: ".",
      args: ["@channel"],
      message: { id: 1, chatId: "1", outgoing: true, text: ".so add" },
    },
    context,
  );
  await entered;
  controller.abort();
  releaseResolve();
  await running;
  assert.equal(linkedReads, 0);
  assert.deepEqual(state.channelList, []);
});

test("search keeps a successful fallback upload when temp cleanup fails and preserves topic and rawless peer", async () => {
  let state = {
    schemaVersion: 1,
    defaultChannel: "@source",
    channelList: [{ title: "Source", handle: "@source" }],
    adFilters: [],
  };
  const sent = [],
    logs = [],
    edits = [],
    signal = new AbortController().signal,
    selected = {
      id: 8,
      peerId: "source",
      message: "movie",
      video: { attributes: [{ className: "DocumentAttributeVideo", duration: 60, w: 640, h: 360 }] },
      media: {},
      document: { size: 1 },
    },
    client = {
      async getEntity() {
        return { className: "Channel", megagroup: true };
      },
      async getMessages() {
        return [selected];
      },
      async *iterDownload() {
        yield Buffer.from("video");
      },
      async sendFile(peer, options) {
        sent.push({ peer, options });
      },
    };
  const context = {
    signal,
    log: {
      error(event) {
        logs.push(event);
      },
    },
    storage: {
      json() {
        return {
          async read() {
            return structuredClone(state);
          },
          async update(fn) {
            state = await fn(structuredClone(state));
            return state;
          },
        };
      },
    },
    files: {
      async withTemp(fn) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cleanup-"));
        try {
          await fn(dir, signal);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
        throw new Error("cleanup-secret");
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async withClient(fn) {
        return fn(client, signal);
      },
    },
  };
  await create().commands.so.handle(
    {
      command: "so",
      prefix: ".",
      args: ["movie", "-s"],
      message: {
        id: 1,
        chatId: "-1009007199254740993",
        senderId: "1",
        outgoing: true,
        topicId: 44,
        text: ".so movie -s",
      },
    },
    context,
  );
  assert.equal(sent.length, 1, JSON.stringify({ edits, logs }));
  assert.equal(sent[0].peer.toString(), "-1009007199254740993");
  assert.equal(sent[0].options.topMsgId, 44);
  assert.ok(logs.includes("search_temp_cleanup_failed"));
  assert.doesNotMatch(edits.at(-1), /错误/);
});

test("search export uses an exact rawless bigint peer", async () => {
  const signal = new AbortController().signal,
    sent = [],
    edits = [],
    state = { schemaVersion: 1, defaultChannel: "@a", channelList: [{ title: "A", handle: "@a" }], adFilters: [] },
    context = {
      signal,
      log: { error() {} },
      storage: {
        json() {
          return {
            async read() {
              return state;
            },
          };
        },
      },
      telegram: {
        async edit(_m, text) {
          edits.push(text);
        },
        async withClient(fn) {
          return fn(
            {
              async sendFile(peer) {
                sent.push(peer);
              },
            },
            signal,
          );
        },
      },
    };
  await create().commands.so.subcommands.export.handle(
    {
      command: "so",
      subcommand: "export",
      prefix: ".",
      args: [],
      message: { id: 1, chatId: "-1009007199254740993", outgoing: true, text: ".so export" },
    },
    context,
  );
  assert.equal(sent.length, 1, JSON.stringify(edits));
  assert.equal(sent[0].toString(), "-1009007199254740993");
});

test("search retains the complete legacy default advertisement filter set", async () => {
  let supplied;
  const settings = create().settings({
    storage: {
      json(_name, defaults) {
        supplied = defaults;
        return {
          async read() {
            return structuredClone(defaults);
          },
        };
      },
    },
  });
  const values = await settings.getValues();
  for (const word of ["淘宝", "现金", "六合彩", "挖矿", "医疗", "A货", "办证", "黑客", "科学上网", "梯子"])
    assert.ok(values.adFilters.includes(word));
  assert.equal(values.adFilters.length, supplied.adFilters.length);
});
