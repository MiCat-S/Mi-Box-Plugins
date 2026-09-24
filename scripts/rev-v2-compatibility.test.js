"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { Api, utils } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js")),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({ id: "rev", packageRoot: path.resolve(__dirname, "../rev"), entry: "v2.ts" }),
  entry = path.join(artifactDir, "index.cjs");
function plugin() {
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}

async function mediaFixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-rev-"))),
    controller = new AbortController(),
    edits = [],
    sends = [],
    logs = [],
    processes = [];
  let deletes = 0;
  const source = options.source ?? {
      id: 8,
      media: { key: "photo" },
      photo: {},
      document: options.document,
      text: "caption",
      entities: [],
    },
    raw = {
      peerId: "peer",
      async delete() {
        deletes++;
        if (options.deleteFails) throw new Error("private delete");
      },
    },
    context = {
      signal: controller.signal,
      log: {
        error(event, fields) {
          logs.push({ event, fields });
        },
      },
      files: {
        async withTemp(operation) {
          const dir = await fs.mkdtemp(path.join(root, "job-"));
          let value;
          try {
            value = await operation(dir, controller.signal);
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
          if (options.tempCleanupFails) throw new Error("private temp");
          return value;
        },
      },
      processes: {
        async run(command, args, runOptions) {
          processes.push({ command, args, options: runOptions });
          if (options.process) return options.process(command, args, runOptions);
          await fs.writeFile(args.at(-1), Buffer.from("output"));
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      },
      telegram: {
        async edit(_message, text, sendOptions) {
          edits.push({ text, options: sendOptions });
          if (options.edit) await options.edit(text);
        },
        async getReply() {
          return { id: source.id, text: source.text ?? "", raw: source };
        },
        async withClient(operation) {
          const client = {
            async *iterDownload(_media, params) {
              if (options.iterDownload) yield* options.iterDownload(params);
              else yield Buffer.from("input");
            },
            async sendFile(peer, value) {
              if (options.sendFile) await options.sendFile(peer, value);
              sends.push({ peer, value });
            },
          };
          return operation(client, controller.signal);
        },
      },
    };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (args = [], message = {}) =>
    plugin().commands.rev.handle(
      {
        command: "rev",
        prefix: ".",
        args,
        message: {
          id: 17,
          chatId: "1",
          outgoing: true,
          text: ".rev " + args.join(" "),
          replyToId: 8,
          topicId: 9,
          raw,
          ...message,
        },
      },
      context,
    );
  return { controller, edits, sends, logs, processes, run, deletes: () => deletes };
}

test("rev production artifact keeps complete active-prefix help and serializes replied text entities", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-rev-host-"))),
    edits = [],
    requests = [],
    bold = new Api.MessageEntityBold({ offset: 0, length: 2 }),
    reply = { id: 8, text: "ab", raw: { entities: [bold] } },
    client = {
      async getInputEntity() {
        return new Api.InputPeerSelf();
      },
      async invoke(request) {
        await request.resolve(client, utils);
        request.getBytes();
        requests.push(request);
      },
    };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!"],
    processes: { timeoutMs: 180000, maxOutputBytes: 512 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {
        assert.fail("reply");
      },
      async invoke() {
        assert.fail("port invoke");
      },
      async getReply() {
        return reply;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(plugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: "!rev help" });
  assert.match(edits.at(-1), /!rev h c/);
  await host.dispatchPrimary({
    id: 2,
    chatId: "1",
    senderId: "1",
    outgoing: true,
    text: "!rev",
    replyToId: 8,
    raw: { peerId: new Api.PeerUser({ userId: returnBigInt(1) }) },
  });
  assert.ok(requests[0] instanceof Api.messages.EditMessage);
  assert.equal(requests[0].message, "ba");
  assert.ok(requests[0].entities[0] instanceof Api.MessageEntityBold);
});

test("rev media keeps original filters, caption, reply and topic while cleanup failure cannot reverse success", async t => {
  const f = await mediaFixture(t, { deleteFails: true });
  await f.run(["v", "c"]);
  assert.equal(f.processes.length, 1);
  assert.ok(f.processes[0].args.includes("vflip,negate"));
  assert.ok(f.processes[0].options.signal instanceof AbortSignal);
  assert.equal(f.sends[0].value.caption, "noitpac");
  assert.equal(f.sends[0].value.replyTo, 8);
  assert.equal(f.sends[0].value.topMsgId, 9);
  assert.equal(f.deletes(), 1);
  assert.ok(f.logs.some(value => value.event === "rev_command_cleanup_failed"));
  assert.ok(!f.logs.some(value => value.event === "rev_failed"));
  assert.equal(f.edits.at(-1).text, "✅ 媒体已处理完成");
  const temp = await mediaFixture(t, { tempCleanupFails: true });
  await temp.run([]);
  assert.equal(temp.sends.length, 1);
  assert.equal(temp.deletes(), 1);
  assert.ok(temp.logs.some(value => value.event === "rev_temp_cleanup_failed"));
  assert.ok(!temp.logs.some(value => value.event === "rev_failed"));
});

test("rev rejects declared oversized input before download or process", async t => {
  const f = await mediaFixture(t, { document: { size: 50 * 1024 * 1024 + 1, mimeType: "image/png" } });
  await f.run([]);
  assert.equal(f.sends.length, 0);
  assert.equal(f.processes.length, 0);
  assert.match(f.edits.at(-1).text, /媒体处理失败/);
  assert.ok(f.logs.some(value => value.event === "rev_failed"));
});

test("rev aborts hanging download with no process, upload, delete or late feedback", async t => {
  let started;
  const ready = new Promise(resolve => (started = resolve)),
    f = await mediaFixture(t, {
      iterDownload: async function* (params) {
        started();
        await new Promise((resolve, reject) =>
          params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true }),
        );
      },
    }),
    running = f.run([]);
  await ready;
  const before = f.edits.length;
  f.controller.abort();
  await running;
  assert.equal(f.processes.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.deletes(), 0);
  assert.equal(f.edits.length, before);
});

test("rev abort during noncooperative upload prevents delete and late feedback", async t => {
  let started, release;
  const ready = new Promise(resolve => (started = resolve)),
    gate = new Promise(resolve => (release = resolve)),
    f = await mediaFixture(t, {
      async sendFile() {
        started();
        await gate;
      },
    }),
    running = f.run([]);
  await ready;
  const before = f.edits.length;
  f.controller.abort();
  release();
  await running;
  assert.equal(f.sends.length, 1);
  assert.equal(f.deletes(), 0);
  assert.equal(f.edits.length, before);
});

test("rev bounds ffmpeg file protocols and disk output for image, GIF and WebM branches", async t => {
  const cases = [
    [{ id: 1, media: {}, photo: {}, text: "" }, args => assert.ok(args.includes("hflip"))],
    [
      { id: 2, media: {}, document: { size: 1, mimeType: "image/gif", attributes: [] }, text: "" },
      args => {
        assert.ok(args.includes("-filter_complex"));
        assert.ok(args.includes("-loop"));
      },
    ],
    [
      { id: 3, media: {}, document: { size: 1, mimeType: "video/webm", attributes: [] }, text: "" },
      args => {
        assert.equal(args[args.indexOf("-c:v") + 1], "libvpx-vp9");
        assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuva420p");
      },
    ],
  ];
  for (const [source, branch] of cases) {
    const f = await mediaFixture(t, { source });
    await f.run([]);
    const call = f.processes[0],
      args = call.args;
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
    assert.equal(args[args.indexOf("-fs") + 1], String(50 * 1024 * 1024));
    assert.equal(call.options.cwd, path.dirname(args.at(-1)));
    assert.ok(args[args.indexOf("-i") + 1].startsWith(call.options.cwd + path.sep));
    branch(args);
  }
});

test("rev passes reversed media caption entities through the native upload field", async t => {
  const f = await mediaFixture(t, {
    source: {
      id: 8,
      media: {},
      photo: {},
      text: "abcd",
      entities: [new Api.MessageEntityBold({ offset: 0, length: 2 })],
    },
  });
  await f.run([]);
  const options = f.sends[0].value;
  assert.equal(options.caption, "dcba");
  assert.equal(options.entities, undefined);
  assert.ok(options.formattingEntities[0] instanceof Api.MessageEntityBold);
  assert.deepEqual([options.formattingEntities[0].offset, options.formattingEntities[0].length], [2, 2]);
  assert.ok(options.formattingEntities[0].getBytes().length > 0);
});
