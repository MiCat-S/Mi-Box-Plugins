"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
let root, factory;
test.before(async () => {
  root = await fs.mkdtemp(path.join(core, "temp/dig-parity-"));
  const built = buildPlugin({
    id: "dig",
    packageRoot: path.resolve(__dirname, "../dig"),
    entry: "v2.ts",
    rootDir: core,
  });
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
});
test.after(async () => fs.rm(root, { recursive: true, force: true }));

function direct(output, options = {}) {
  const controller = new AbortController(),
    edits = [],
    replies = [],
    logs = [],
    processCalls = [],
    httpCalls = [];
  const context = {
    signal: controller.signal,
    log: {
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    processes: {
      async run(command, args, limits) {
        processCalls.push({ command, args, limits });
        if (options.processError) throw options.processError;
        if (options.process) return options.process(controller);
        return { stdout: Buffer.from(output) };
      },
    },
    http: {
      async withResponse(url, init, consume, requestOptions) {
        httpCalls.push({ url, init, requestOptions });
        return consume(await options.respond(url, httpCalls.length, controller), controller.signal);
      },
    },
    telegram: {
      async edit(_message, text, settings) {
        if (options.editError?.(text)) throw new Error("private edit failure");
        edits.push({ text, settings });
      },
      async reply(_message, text, settings) {
        if (typeof options.replyError === "function" && options.replyError(text))
          throw new Error("private reply failure");
        if (options.replyError === true) throw new Error("private reply failure");
        replies.push({ text, settings });
      },
    },
  };
  const run = (args = ["example.com", "A"]) =>
    factory().commands.dig.handle(
      {
        command: "dig",
        prefix: ".",
        args,
        message: { id: 1, chatId: "-1001234567890123456", outgoing: true, text: `.dig ${args.join(" ")}` },
      },
      context,
    );
  return { controller, edits, replies, logs, processCalls, httpCalls, run };
}

test("real Host routes help and rejects unsafe arguments without process or HTTP work", async t => {
  let native = 0,
    http = 0;
  const host = new PluginHost({
    storageRoot: await fs.mkdtemp(path.join(root, "host-")),
    prefixes: ["!"],
    logger: { info() {}, error() {} },
    http: {
      fetch: async () => {
        http++;
        throw new Error("must not fetch");
      },
    },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {
        native++;
      },
      async getReply() {},
      async withClient() {
        native++;
      },
    },
  });
  await host.load(factory());
  t.after(() => host.shutdown(1000));
  assert.equal(
    await host.dispatchPrimary({
      id: 1,
      chatId: "-1001234567890123456",
      senderId: "1",
      outgoing: true,
      text: "!dig help",
    }),
    true,
  );
  assert.equal(
    await host.dispatchPrimary({
      id: 2,
      chatId: "-1001234567890123456",
      senderId: "1",
      outgoing: true,
      text: "!dig example.com +trace",
    }),
    true,
  );
  assert.equal(native, 0);
  assert.equal(http, 0);
});

test("location requests enforce public addresses, same-host redirects, and bounded readers", async () => {
  let cancelled = 0;
  const f = direct("1.1.1.1\n", {
    respond: (url, n) =>
      n === 1
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(16385));
              },
              cancel() {
                cancelled++;
              },
            }),
          )
        : Response.json({ country: "US", org: "AS13335 Cloudflare" }),
  });
  await f.run();
  assert.equal(cancelled, 1);
  assert.equal(f.httpCalls.length, 2);
  for (const call of f.httpCalls) {
    assert.equal(call.requestOptions.timeoutMs, 3000);
    assert.equal(call.requestOptions.denyPrivateAddresses, true);
    assert.deepEqual(call.requestOptions.redirects, { allowedHosts: [new URL(call.url).hostname], maxRedirects: 2 });
  }
  assert.match(f.edits.at(-1).text, /US · AS13335/);
});

test("location reader accepts the exact 16 KiB boundary", async () => {
  const prefix = '{"country":"US","padding":"',
    suffix = '"}';
  const body = prefix + "x".repeat(16384 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  assert.equal(Buffer.byteLength(body), 16384);
  const f = direct("1.1.1.1\n", { respond: () => new Response(body) });
  await f.run();
  assert.equal(f.httpCalls.length, 1);
  assert.match(f.edits.at(-1).text, /US/);
});

test("aborting a hung location reader starts no fallback and sends no result", async () => {
  let started,
    cancelled = 0;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const f = direct("1.1.1.1\n", {
    respond: () =>
      new Response(
        new ReadableStream({
          start() {
            started();
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
  });
  const running = f.run();
  await ready;
  f.controller.abort();
  await running;
  assert.equal(cancelled, 1);
  assert.equal(f.httpCalls.length, 1);
  assert.deepEqual(
    f.edits.map(value => value.text),
    ["正在查询 DNS…"],
  );
});

test("a later page failure preserves the already delivered DNS result", async () => {
  const output = Array.from({ length: 70 }, (_, i) => `${i} ${"x".repeat(120)}`).join("\n");
  let failed = false;
  const f = direct(output, {
    respond: () => Response.json({ bogon: true }),
    replyError: text => !text.includes("已发送") && !failed++,
  });
  await f.run(["example.com", "TXT"]);
  assert.equal(f.edits.length, 2, "progress and first result page remain");
  assert.match(f.edits[1].text, /DNS 查询结果/);
  assert.equal(
    f.edits.some(value => value.text.includes("DNS 查询失败")),
    false,
  );
  assert.match(f.replies.at(-1).text, /已发送 1\/\d+ 页，后续页发送中断/);
  assert.deepEqual(f.logs.at(-1), { event: "dig_result_delivery_failed", fields: undefined });
  assert.doesNotMatch(JSON.stringify(f.logs), /private reply failure/);
});

test("an interrupted notice failure is fixed best-effort after a published page", async () => {
  const output = Array.from({ length: 70 }, (_, i) => `${i} ${"x".repeat(120)}`).join("\n");
  const f = direct(output, { respond: () => Response.json({ bogon: true }), replyError: true });
  await f.run(["example.com", "TXT"]);
  assert.equal(f.edits.length, 2);
  assert.equal(
    f.edits.some(value => value.text.includes("DNS 查询失败")),
    false,
  );
  assert.deepEqual(f.logs.slice(-2), [
    { event: "dig_result_delivery_failed", fields: undefined },
    { event: "dig_interrupted_notice_failed", fields: undefined },
  ]);
});

test("zero published result pages return to the normal fixed failure path", async () => {
  const output = Array.from({ length: 70 }, (_, i) => `${i} ${"x".repeat(120)}`).join("\n");
  const f = direct(output, {
    respond: () => Response.json({ bogon: true }),
    editError: text => text.includes("DNS 查询结果"),
  });
  await f.run(["example.com", "TXT"]);
  assert.match(f.edits.at(-1).text, /DNS 查询失败.*查询执行失败，请稍后重试/s);
  assert.equal(f.replies.length, 0);
});

test("successful pagination preserves every escaped Unicode record", async () => {
  const output = Array.from({ length: 70 }, (_, i) => `${i} <&😀${"x".repeat(120)}`).join("\n");
  const f = direct(output, { respond: () => Response.json({ bogon: true }) });
  await f.run(["example.com", "TXT"]);
  const pages = [f.edits[1].text, ...f.replies.map(value => value.text)];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  const content = pages.map(page => page.match(/<pre>([\s\S]*)<\/pre>/)[1]).join("");
  assert.equal(
    content,
    output.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]),
  );
});

test("exact argv is retained and cancellation after the helper starts prevents HTTP and results", async () => {
  const f = direct("", {
    process: async controller => {
      controller.abort();
      return { stdout: Buffer.from("1.1.1.1\n") };
    },
    respond: () => {
      throw new Error("must not fetch");
    },
  });
  await f.run(["_sip._tcp.example.com", "SRV", "@2001:4860:4860::8888"]);
  assert.deepEqual(f.processCalls[0], {
    command: "/usr/bin/dig",
    args: ["@2001:4860:4860::8888", "_sip._tcp.example.com", "SRV", "+short"],
    limits: { timeoutMs: 10000, maxOutputBytes: 32768 },
  });
  assert.equal(f.httpCalls.length, 0);
  assert.deepEqual(
    f.edits.map(value => value.text),
    ["正在查询 DNS…"],
  );
});

test("native process details never enter Telegram feedback", async () => {
  const error = Object.assign(new Error("token=/private/path SECRET"), {
    name: "SECRET_NAME",
    cause: new Error("SECRET_CAUSE"),
  });
  const f = direct("", { respond: () => Response.json({}), processError: error });
  await f.run();
  const visible = JSON.stringify({ edits: f.edits, logs: f.logs });
  for (const secret of ["SECRET", "/private/path", "token="]) assert.equal(visible.includes(secret), false);
  assert.match(f.edits.at(-1).text, /查询执行失败，请稍后重试/);
});
