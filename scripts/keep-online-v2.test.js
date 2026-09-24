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
  id: "keep_online",
  packageRoot: path.resolve(__dirname, "../keep_online"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, { getMe = async () => ({ id: 9007199254740993n }), prefixes = ["."], root } = {}) {
  const ownedRoot = !root;
  root ??= await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-keep-online-v2-")));
  const edits = [],
    logs = [],
    calls = [];
  const host = new PluginHost({
    storageRoot: root,
    prefixes,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event, fields) {
        logs.push({ level: "error", event, fields });
      },
    },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {
        assert.fail("unexpected reply lookup");
      },
      async withClient(operation, signal) {
        calls.push({ signal });
        return operation({ getMe }, signal);
      },
    },
  });
  await host.load(create());
  let closed = false;
  t.after(async () => {
    if (!closed) assert.equal((await host.shutdown(1000)).completed, true);
    if (ownedRoot) await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    logs,
    calls,
    close: async timeout => {
      const result = await host.shutdown(timeout);
      closed = result.completed;
      return result;
    },
    run: text =>
      host.dispatchPrimary({ id: 1, chatId: "9007199254740993", senderId: "9007199254740993", outgoing: true, text }),
    fire: async () => {
      const jobs = [...host.scheduler.jobs.values()];
      assert.equal(jobs.length, 1);
      jobs[0].fireOnTick();
      while (host.scheduler.snapshot().running) await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test("keep_online is a pure factory with one host-owned 55-second job", async t => {
  const first = create(),
    second = create();
  assert.notEqual(first, second);
  assert.equal(first.jobs.keep_online.cron, "55 * * * * *");
  assert.equal(first.setup, undefined);
  assert.equal(first.cleanup, undefined);
  const f = await fixture(t);
  assert.deepEqual(f.host.scheduler.snapshot(), { jobs: 1, running: 0 });
  await assert.rejects(fs.stat(path.join(f.root, "keep_online/keep_online.txt")), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("status help uses the active prefix and reflects a successful probe immediately", async t => {
  const f = await fixture(t, { prefixes: ["<&"] });
  await f.run("<&keep_online");
  assert.match(f.edits.at(-1).text, /等待首次探测/);
  assert.match(f.edits.at(-1).text, /&lt;&amp;keep_online/);
  assert.match(f.edits.at(-1).text, /assets\/keep_online\/keep_online\.txt/);
  assert.match(f.edits.at(-1).text, /keep_online\/keep_online\.sh\?raw=true/);
  assert.deepEqual(f.edits.at(-1).options, { parseMode: "html" });
  await f.fire();
  await f.run("<&keep_online");
  assert.match(f.edits.at(-1).text, /最近成功：<code>/);
  assert.doesNotMatch(f.edits.at(-1).text, /等待首次探测/);
});

test("probe validates the Telegram session before writing an integer timestamp with private mode", async t => {
  const f = await fixture(t);
  const before = Math.floor(Date.now() / 1000);
  await f.fire();
  const file = path.join(f.root, "keep_online/keep_online.txt");
  const timestamp = await fs.readFile(file, "utf8");
  assert.match(timestamp, /^\d+$/);
  assert.ok(Number(timestamp) >= before && Number(timestamp) <= Math.floor(Date.now() / 1000));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(f.calls.length, 1);
});

test("status survives plugin reload by reading the managed probe file", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-keep-online-reload-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await fixture(t, { root });
  await first.fire();
  assert.equal((await first.close(1000)).completed, true);
  const second = await fixture(t, { root });
  await second.run(".keep_online");
  assert.match(second.edits.at(-1).text, /最近成功：<code>/);
  assert.doesNotMatch(second.edits.at(-1).text, /等待首次探测/);
});

test("failed probes neither advance status nor expose client failures", async t => {
  const secret = "private session credential";
  const f = await fixture(t, {
    getMe: async () => {
      throw new Error(secret);
    },
  });
  await f.fire();
  await f.run(".keep_online");
  assert.match(f.edits.at(-1).text, /等待首次探测/);
  assert.equal(JSON.stringify({ edits: f.edits, logs: f.logs }).includes(secret), false);
  assert.ok(f.logs.some(item => item.event === "keep_online_probe_failed"));
  await assert.rejects(fs.stat(path.join(f.root, "keep_online/keep_online.txt")), { code: "ENOENT" });
});

test("unload waits for an active probe, cancels it and prevents a late timestamp", async t => {
  const started = deferred(),
    release = deferred();
  const f = await fixture(t, {
    getMe: async () => {
      started.resolve();
      await release.promise;
      return { id: 1n };
    },
  });
  const firing = f.fire();
  await started.promise;
  try {
    const report = await f.host.unload("keep_online", 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
    assert.equal(f.calls[0].signal.aborted, true);
  } finally {
    release.resolve();
  }
  await firing;
  assert.equal((await f.close(1000)).completed, true);
  await assert.rejects(fs.stat(path.join(f.root, "keep_online/keep_online.txt")), { code: "ENOENT" });
  assert.equal(f.edits.length, 0);
});

test("bundled watchdog reads the V2 managed probe path", async () => {
  const script = await fs.readFile(path.resolve(__dirname, "../keep_online/keep_online.sh"), "utf8");
  assert.match(script, /file="\/root\/telebox\/assets\/keep_online\/keep_online\.txt"/);
  assert.doesNotMatch(script, /temp\/keep_online\/keep_online\.txt/);
});
