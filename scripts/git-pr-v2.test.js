"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const packageRoot = process.env.GIT_PR_PACKAGE_ROOT || path.resolve(__dirname, "../git_PR");
const { artifactDir } = buildPlugin({ id: "git_PR", packageRoot, entry: "v2.ts" });
const createGitPr = require(path.join(artifactDir, "index.cjs")).default;
const base = { id: 1, chatId: "123", senderId: "123", outgoing: true, saved: true, text: ".git help" };

async function fixture(t, responder, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-git-pr-v2-")));
  const edits = [],
    replies = [],
    requests = [],
    logs = [];
  let replyCalls = 0;
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info(event, fields) {
        logs.push({ event, fields });
      },
      error() {},
    },
    http: {
      async fetch(url, init) {
        requests.push({ url: String(url), init });
        return responder(String(url), init, requests.length);
      },
    },
    telegram: {
      async edit(message, text, messageOptions) {
        if (options.failSuccessReceipt && /成功合并/.test(text)) throw options.failSuccessReceipt;
        edits.push({ message, text, options: messageOptions });
      },
      async reply(message, text, messageOptions) {
        replyCalls++;
        if (options.failReplyOnce && replyCalls === 1) throw new Error("send detail");
        replies.push({ message, text, options: messageOptions });
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {},
      async withClient() {
        assert.fail("unexpected client");
      },
    },
  });
  await host.load(createGitPr());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  const run = (text, extra = {}) => host.dispatchPrimary({ ...base, text, ...extra });
  await run(".git login mail user top-secret");
  return { host, edits, replies, requests, logs, run };
}

test("help and token setup stay local while settings expose only a secret marker", async t => {
  const f = await fixture(t, async () => assert.fail("unexpected HTTP"));
  await f.run(".git login e u rejected-secret", { saved: false, chatId: "-100" });
  await f.run(".git help", { saved: false, chatId: "-100" });
  assert.match(f.edits.at(-1).text, /Git PR 管理/);
  assert.doesNotMatch(JSON.stringify(await f.host.readSettings("git_PR")), /top-secret|rejected-secret/);
  assert.equal((await f.host.readSettings("git_PR")).secretSet.git_token, true);
  assert.equal(f.requests.length, 0);
});

test("repos uses bounded managed HTTP and preserves escaped paginated output after a partial send", async t => {
  const repositories = Array.from({ length: 100 }, (_, i) => ({
    full_name: `owner/repo-${i}-${"<&".repeat(45)}`,
    permissions: { push: true },
  }));
  const f = await fixture(t, async () => Response.json(repositories), { failReplyOnce: true });
  await f.run(".git repos", { saved: false, chatId: "-100" });
  const request = f.requests[0];
  assert.equal(request.init.headers.Authorization, "Bearer top-secret");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "manual");
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.ok(f.edits.at(-1).text.length <= 4096);
  assert.match(f.edits.at(-1).text, /&lt;&amp;/);
  assert.match(f.replies.at(-1).text, /发送中断/);
  assert.ok(f.logs.some(value => value.event === "pagination_delivery_interrupted"));
  assert.doesNotMatch([...f.edits, ...f.replies].map(value => value.text).join("\n"), /top-secret|send detail/);
});

test("prs restores mergeability details and hides failed detail diagnostics", async t => {
  const f = await fixture(t, async url => {
    if (url.endsWith("pulls?state=open&per_page=50"))
      return Response.json([
        { number: 1, title: "<ready>", user: { login: "alice" } },
        { number: 2, title: "blocked", user: { login: "bob" } },
        { number: 3, title: "unknown", user: { login: "cat" } },
      ]);
    if (url.endsWith("/1")) return Response.json({ mergeable: true });
    if (url.endsWith("/2")) return Response.json({ mergeable: false, mergeable_state: "<dirty>" });
    return Response.json({ message: "private top-secret detail" }, { status: 503 });
  });
  await f.run(".git prs owner/repo", { saved: false, chatId: "-100" });
  const text = f.edits.at(-1).text;
  assert.match(text, /#1[\s\S]*✅ 可合并/);
  assert.match(text, /#2[\s\S]*⛔ 不可合并（&lt;dirty&gt;）/);
  assert.match(text, /#3[\s\S]*❓ 未知/);
  assert.doesNotMatch(text, /private|top-secret/);
});

test("mergeall merges only mergeable PRs in number order and reports partial success safely", async t => {
  const puts = [];
  const f = await fixture(t, async (url, init) => {
    if (url.endsWith("pulls?state=open&per_page=100"))
      return Response.json([{ number: 3 }, { number: 1 }, { number: 2 }]);
    if (init.method === "GET") return Response.json({ mergeable: !url.endsWith("/2") });
    puts.push(url);
    return url.includes("/1/merge")
      ? Response.json({ merged: true })
      : Response.json({ message: "top-secret provider" }, { status: 422 });
  });
  await f.run(".git mergeall owner/repo");
  assert.deepEqual(
    puts.map(url => Number(url.match(/pulls\/(\d+)\/merge/)[1])),
    [1, 3],
  );
  assert.match(f.edits.at(-1).text, /成功：1/);
  assert.match(f.edits.at(-1).text, /失败：1（#3）/);
  assert.doesNotMatch(f.edits.at(-1).text, /top-secret|provider/);
});

test("oversized responses cancel their body and cancellation stops later HTTP work", async t => {
  let cancelled = false;
  const f = await fixture(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await f.run(".git repos");
  assert.equal(cancelled, true);
  assert.match(f.edits.at(-1).text, /API 返回内容过大/);
  assert.doesNotMatch(f.edits.at(-1).text, /top-secret/);
  assert.equal(f.requests.length, 1);
});

test("unload cancels a hanging response reader, waits for cleanup, and starts no merge", async t => {
  let readStartedResolve, cancelStartedResolve, releaseCleanup;
  const readStarted = new Promise(resolve => {
    readStartedResolve = resolve;
  });
  const cancelStarted = new Promise(resolve => {
    cancelStartedResolve = resolve;
  });
  const cleanup = new Promise(resolve => {
    releaseCleanup = resolve;
  });
  const f = await fixture(t, async (url, init) => {
    if (url.endsWith("pulls?state=open&per_page=100")) return Response.json([{ number: 1 }]);
    return new Response(
      new ReadableStream({
        pull() {
          readStartedResolve();
          return new Promise(() => {});
        },
        cancel() {
          cancelStartedResolve();
          return cleanup;
        },
      }),
    );
  });
  const dispatch = f.run(".git mergeall owner/repo");
  await readStarted;
  let unloaded = false;
  const unloading = f.host.unload("git_PR", 1000).then(report => {
    unloaded = true;
    return report;
  });
  await cancelStarted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, false);
  releaseCleanup();
  assert.equal((await unloading).completed, true);
  await dispatch;
  assert.equal(f.requests.filter(request => request.init.method === "PUT").length, 0);
  assert.equal(f.edits.length, 1);
  assert.match(f.edits[0].text, /登录信息已保存/);
});

test("untrusted transport errors never expose message, name, code, token, path, or URL", async t => {
  const malicious = Object.assign(new Error("top-secret /Users/cat/private https://internal.invalid"), {
    name: "TokenError",
    code: "TOKEN_top-secret",
  });
  const f = await fixture(t, async () => {
    throw malicious;
  });
  await f.run(".git repos", { saved: false, chatId: "-100" });
  assert.equal(f.edits.at(-1).text, "操作失败，请稍后重试");
  assert.doesNotMatch(f.edits.at(-1).text, /top-secret|Users|internal|TokenError|TOKEN/);
});

test("a failed Telegram receipt after a confirmed merge does not report the merge as failed", async t => {
  const receipt = Object.assign(new Error("top-secret receipt path"), { name: "ReceiptError", code: "TOKEN" });
  const f = await fixture(
    t,
    async (_url, init) => {
      assert.equal(init.method, "PUT");
      return Response.json({ merged: true, message: "provider top-secret" });
    },
    { failSuccessReceipt: receipt },
  );
  await f.run(".git merge owner/repo 7");
  assert.equal(f.requests.length, 1);
  assert.equal(f.edits.filter(value => /操作失败|合并失败/.test(value.text)).length, 0);
  assert.doesNotMatch(f.edits.map(value => value.text).join("\n"), /top-secret|ReceiptError|TOKEN/);
});
