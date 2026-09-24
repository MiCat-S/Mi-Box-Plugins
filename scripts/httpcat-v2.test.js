"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "httpcat",
  packageRoot: path.resolve(__dirname, "../httpcat"),
  entry: "v2.ts",
});
const createHttpcat = require(path.join(artifactDir, "index.cjs")).default;
const envelope = { id: 7, chatId: "123", senderId: "123", outgoing: true, text: ".httpcat 404", raw: { peerId: {} } };

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-httpcat-v2-")));
  const edits = [],
    errors = [],
    sent = [],
    requests = [];
  const fetcher = options.fetch || (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const client = {
    sendFile: async (...args) => {
      sent.push(args);
      await options.sendFile?.();
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: options.prefixes,
    logger: {
      info() {},
      error(event) {
        errors.push(event);
      },
    },
    http: {
      fetch: async (url, init) => {
        requests.push({ url: new URL(url), init });
        return fetcher(url, init);
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
        return undefined;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(createHttpcat());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    errors,
    host,
    sent,
    requests,
    run: (text, extra = {}) => host.dispatchPrimary({ ...envelope, text, ...extra }),
  };
}
test("httpcat validates code and sends bounded image through borrowed client", async t => {
  let deleted = 0;
  const f = await fixture(t);
  await f.run(".httpcat 404", {
    raw: {
      peerId: { id: "peer" },
      delete: async () => {
        deleted += 1;
      },
    },
  });
  assert.equal(f.requests[0].url.pathname, "/404");
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].id, "peer");
  assert.equal(f.sent[0][1].replyTo, 7);
  assert.equal(deleted, 1);
  assert.equal(f.edits.at(-1).text, "正在获取 HTTP 404 猫猫图片...");
});
test("httpcat rejects invalid status and failed responses without leaking details", async t => {
  const f = await fixture(t, { fetch: async () => new Response("secret", { status: 404 }) });
  await f.run(".httpcat 12");
  assert.equal(f.requests.length, 0);
  await f.run(".httpcat 404");
  assert.match(f.edits.at(-1).text, /失败/);
  assert.doesNotMatch(JSON.stringify(f.edits), /secret/);
});

test("httpcat preserves the original any-three-digit code syntax", async t => {
  const f = await fixture(t);
  await f.run(".httpcat 600");
  assert.equal(f.requests[0].url.pathname, "/600");
  assert.equal(f.sent.length, 1);
});

test("httpcat accepts short stream chunks and rejects empty or oversized media", async t => {
  const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const short = await fixture(t, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        }),
      ),
  });
  await short.run(".httpcat 200");
  assert.equal(short.sent[0][1].file.size, 3);
  const empty = await fixture(t, { fetch: async () => new Response(new Uint8Array()) });
  await empty.run(".httpcat 204");
  assert.equal(empty.sent.length, 0);
  assert.equal(empty.edits.at(-1).text, "图片获取失败或为空");
  const oversized = await fixture(t, { fetch: async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1)) });
  await oversized.run(".httpcat 200");
  assert.equal(oversized.sent.length, 0);
  assert.deepEqual(oversized.errors, ["httpcat.failed"]);
});

test("httpcat actively cancels and releases a hanging response reader on unload", async t => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const f = await fixture(t, { fetch: async () => new Response(stream) });
  const running = f.run(".httpcat 200");
  while (!stream.locked) await new Promise(resolve => setImmediate(resolve));
  const unloading = f.host.unload("httpcat");
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.edits.map(item => item.text),
    ["正在获取 HTTP 200 猫猫图片..."],
  );
});

test("httpcat treats deletion failure as best effort after a successful send", async t => {
  const f = await fixture(t);
  await f.run(".httpcat 418", {
    raw: {
      peerId: {},
      delete: async () => {
        throw Object.assign(new Error("private"), { code: "SECRET" });
      },
    },
  });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.errors, ["httpcat.delete_failed"]);
  assert.equal(
    f.edits.some(item => /失败/.test(item.text)),
    false,
  );
});

test("httpcat cancellation during upload never deletes or emits late failure feedback", async t => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  let deleted = 0;
  const f = await fixture(t, {
    sendFile: async () => {
      started.resolve();
      await release.promise;
    },
  });
  const running = f.run(".httpcat 200", {
    raw: {
      peerId: {},
      delete: async () => {
        deleted += 1;
      },
    },
  });
  await started.promise;
  const unloading = f.host.unload("httpcat");
  release.resolve();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(deleted, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.edits.some(item => /失败/.test(item.text)),
    false,
  );
});

test("httpcat help escapes the active prefix through the shared renderer", async t => {
  const f = await fixture(t, { prefixes: ["<&"] });
  await f.run("<&httpcat nope");
  assert.match(f.edits.at(-1).text, /<code>&lt;&amp;httpcat \[状态码\]<\/code>/);
  assert.equal(f.requests.length, 0);
});
