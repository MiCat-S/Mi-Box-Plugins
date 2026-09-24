"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fsp = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { resolveId } = require(path.join(core, "node_modules/teleproto/Utils"));
function load() {
  const { artifactDir } = buildPlugin({ id: "cy", packageRoot: path.resolve(__dirname, "../cy"), entry: "v2.ts" });
  delete require.cache[require.resolve(path.join(artifactDir, "index.cjs"))];
  return require(path.join(artifactDir, "index.cjs")).default();
}
async function fixture(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mibot-cy-compat-"))),
    edits = [],
    sent = [],
    logs = [],
    limits = [],
    iterTargets = [];
  const client = {
    async *iterMessages(target, value) {
      iterTargets.push(target);
      limits.push(value.limit);
      for (let i = 0; i < 8; i++) yield { text: "兼容测试 兼容测试 cloud plugin" };
    },
    async sendFile(peer, value) {
      sent.push({ peer, value });
      if (options.sendFile) await options.sendFile(peer, value);
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event) {
        logs.push(event);
      },
    },
    telegram: {
      async edit(message, text, settings) {
        edits.push({ message, text, settings });
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke() {},
      async getReply() {},
      async withClient(fn, signal) {
        return fn(client, signal);
      },
    },
  });
  await host.load(load());
  t.after(async () => {
    await host.shutdown(2000);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    sent,
    logs,
    limits,
    iterTargets,
    run: (text, message = {}) =>
      host.dispatchPrimary({ id: 1, chatId: "-10010", senderId: "1", outgoing: true, text, ...message }),
  };
}

test("legacy aliases work and scheduled limit does not replace the immediate 500 default", async t => {
  const f = await fixture(t);
  await f.run(".cy group @target");
  await f.run(".cy at 09:00 1000");
  await f.run(".cy start");
  assert.match(f.edits.at(-1).text, /on/);
  await f.run(".cy stop");
  assert.match(f.edits.at(-1).text, /off/);
  await f.run(".cy");
  assert.equal(f.limits.at(-1), 500);
});

test("word-cloud PNG pixels are passed intact through CustomFile.buffer", async t => {
  const f = await fixture(t);
  await f.run(".cy 100");
  assert.equal(f.sent.length, 1);
  const file = f.sent[0].value.file;
  assert.equal(file.name, "cy-wordcloud.png");
  assert.ok(Buffer.isBuffer(file.buffer));
  assert.equal(file.size, file.buffer.length);
  assert.deepEqual([...file.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("marked numeric chat IDs stay precise without raw peers and cross-chat send has no foreign reply ID", async t => {
  const f = await fixture(t),
    marked = "-1001234567890123456";
  await f.run(".cy 100", { chatId: marked, id: 77 });
  assert.equal(String(f.iterTargets.at(-1)), marked);
  assert.equal(resolveId(f.iterTargets.at(-1))[1].className, "PeerChannel");
  assert.equal(String(f.sent.at(-1).peer), marked);
  assert.equal(f.sent.at(-1).value.replyTo, 77);
  await f.run(`.cy target ${marked}`);
  await f.run(".cy send 100", { chatId: "-10099", id: 88 });
  assert.equal(String(f.iterTargets.at(-1)), marked);
  assert.equal(resolveId(f.iterTargets.at(-1))[1].className, "PeerChannel");
  assert.equal(String(f.sent.at(-1).peer), marked);
  assert.equal(Object.hasOwn(f.sent.at(-1).value, "replyTo"), false);
});

test("send status names its target and cleanup failure cannot reverse a successful upload", async t => {
  const f = await fixture(t);
  await f.run(".cy target @destination");
  await f.run(".cy send 100", {
    raw: {
      async delete() {
        throw new Error("secret cleanup path");
      },
    },
  });
  assert.ok(f.sent.some(x => x.peer === "@destination"));
  assert.ok(f.edits.some(x => /正在发送词云到 @destination/.test(x.text)));
  assert.doesNotMatch(f.edits.at(-1).text, /失败/);
  assert.deepEqual(f.logs, ["cy_status_cleanup_failed"]);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret/);
});

test("job registration remains owned by Host lifecycle", async t => {
  const f = await fixture(t);
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  assert.equal((await f.host.unload("cy", 2000)).completed, true);
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  await f.host.load(load());
  assert.equal(f.host.snapshot().jobs.jobs, 1);
});

test("job cancellation is observed after upload and does not record a completed run", async t => {
  let begin, finish;
  const started = new Promise(resolve => {
      begin = resolve;
    }),
    released = new Promise(resolve => {
      finish = resolve;
    });
  const f = await fixture(t, {
    async sendFile() {
      begin();
      await released;
    },
  });
  const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(),
    get = type => parts.find(x => x.type === type).value,
    current = `${get("hour")}:${get("minute")}`;
  await f.run(".cy target @scheduled");
  await f.run(`.cy time ${current} 100`);
  await f.run(".cy on");
  const scheduler = f.host.scheduler,
    job = [...scheduler.jobs.values()][0],
    ticking = job.fireOnTick();
  await started;
  const unloading = f.host.unload("cy", 2000);
  finish();
  assert.equal((await unloading).completed, true);
  await ticking;
  const state = JSON.parse(await fsp.readFile(path.join(f.root, "cy", "schedule.json"), "utf8"));
  assert.deepEqual(state.lastRunKeys, []);
});
