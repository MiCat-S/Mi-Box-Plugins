"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));
const build = id =>
  require(
    path.join(
      buildPlugin({ id, packageRoot: path.resolve(__dirname, `../${id}`), entry: "v2.ts" }).artifactDir,
      "index.cjs",
    ),
  ).default;
const createAi = build("ai"),
  createCheckapi = build("checkapi");
test("diagnostics restores full compare and three-model benchmark without exposing credentials", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-diag-"))),
    secret = "sk-super-secret-value-123456789",
    calls = [],
    edits = [],
    logs = [];
  await fs.mkdir(path.join(root, "ai"), { recursive: true });
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.openai.com/v1",
          key: secret,
          stream: true,
          responses: false,
          models: { chat: "gpt-4o-mini" },
        },
        router: {
          tag: "router",
          url: "https://openrouter.ai/api/v1",
          key: secret,
          stream: false,
          responses: false,
          models: { chat: "openai/gpt-4.1-mini" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o-mini",
      timeout: 5,
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!"],
    logger: {
      info(event, fields) {
        logs.push({ event, fields });
      },
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    http: {
      fetch: async (url, init) => {
        const target = String(url);
        calls.push({ target, headers: new Headers(init.headers), body: init.body });
        const headers = {
          "content-type": "application/json",
          "x-ratelimit-remaining-tokens": "99",
          "x-quota-secret": secret,
        };
        if (target.includes("billing/subscription"))
          return new Response(
            JSON.stringify({
              plan: { title: "Pro" },
              hard_limit_usd: 20,
              soft_limit_usd: 10,
              system_hard_limit_usd: 30,
              has_payment_method: true,
            }),
            { headers },
          );
        if (target.includes("billing/usage")) return new Response(JSON.stringify({ total_usage: 1234 }), { headers });
        if (target.includes("/auth/key"))
          return new Response(
            JSON.stringify({
              data: {
                label: "router-key",
                credits: 8,
                usage: 2,
                limit: 10,
                rate_limit: { requests: 20, interval: "10s" },
                disabled_providers: ["x"],
              },
            }),
            { headers },
          );
        if (target.endsWith("/models"))
          return new Response(
            JSON.stringify({ data: [{ id: "m1", owned_by: "org", max_tier: "tier-2" }, { id: "m2" }] }),
            { headers },
          );
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            model: body.model,
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { headers },
        );
      },
    },
    telegram: {
      async edit(_m, text, options) {
        edits.push({ text, options });
      },
      async reply(_m, text, options) {
        edits.push({ text, options });
      },
      async invoke() {},
      async getReply() {},
      async withClient() {},
    },
  });
  await host.load(createAi());
  await host.load(createCheckapi());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const send = text => host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "1", outgoing: true, text });
  await send("!checkapi speed main");
  let output = edits.map(x => x.text).join("\n");
  assert.match(output, /gpt-4\.1-mini/);
  assert.match(output, /gpt-4\.1-nano/);
  assert.match(output, /gpt-4o-mini/);
  assert.match(output, /tok\/s/);
  assert.equal(
    calls.filter(call => String(call.body).includes('"max_tokens":50')).length,
    3,
    "auto type resolves from api.openai.com and runs the original three models",
  );
  assert.equal(
    calls.some(call => String(call.body).includes('"stream":true')),
    false,
    "diagnostics forces a non-streaming request without mutating stored config",
  );
  await send("!checkapi compare main router");
  output = edits.map(x => x.text).join("\n");
  assert.match(output, /套餐: Pro/);
  assert.match(output, /近 90 天: \$12\.3400/);
  assert.match(output, /Org: org/);
  assert.match(output, /Token: 入2 出3 计5/);
  assert.match(output, /router-key/);
  assert.match(output, /速率: 20 req \/ 10s/);
  assert.match(output, /x-ratelimit-remaining-tokens: 99/);
  assert.doesNotMatch(output, /x-quota-secret|super-secret/);
  for (const call of calls.filter(call => call.target.includes("api.openai.com")))
    assert.equal(call.headers.get("authorization"), `Bearer ${secret}`);
  assert.doesNotMatch(JSON.stringify({ edits, logs }), new RegExp(secret));
});

test("caller cancellation aborts pending balance reads and starts no later chat probe", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-diag-cancel-"))),
    bodies = [],
    urls = [];
  let consumerContext;
  await fs.mkdir(path.join(root, "ai"), { recursive: true });
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.openai.com/v1",
          key: "secret",
          stream: true,
          responses: false,
          models: { chat: "gpt-4o-mini" },
        },
      },
      currentChatTag: "main",
      currentChatModel: "gpt-4o-mini",
      timeout: 30,
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async url => {
        urls.push(String(url));
        const response = new Response(new ReadableStream({ cancel() {} }));
        bodies.push(response.body);
        return response;
      },
    },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  const consumer = definePlugin({
    apiVersion: 1,
    id: "diag-consumer",
    description: "fixture",
    commands: {},
    setup(ctx) {
      consumerContext = ctx;
    },
  });
  await host.load(createAi());
  await host.load(consumer);
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController(),
    running = consumerContext.services.call("ai", "diagnostics", { action: "full", tag: "main" }, controller.signal);
  while (bodies.length < 4) await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(running);
  assert.equal(
    bodies.every(body => body.locked === false),
    true,
  );
  assert.equal(
    urls.some(url => url.includes("chat/completions")),
    false,
  );
});

test("Gemini, Anthropic, and DeepSeek diagnostics parse successful metadata and sanitize failures", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-diag-providers-"))),
    requests = [];
  let ctx;
  const configs = {};
  for (const [tag, url, type, model] of [
    ["gem", "https://generativelanguage.googleapis.com", "gemini", "gemini-2.5-flash"],
    ["anth", "https://api.anthropic.com", "anthropic", "claude-3.5-haiku-20241022"],
    ["deep", "https://api.deepseek.com", "openai-compatible", "deepseek-chat"],
  ]) {
    configs[tag] = { tag, url, key: `good-${tag}`, type, stream: true, responses: false, models: { chat: model } };
    configs[`${tag}-bad`] = { ...configs[tag], tag: `${tag}-bad`, key: `bad-${tag}` };
  }
  await fs.mkdir(path.join(root, "ai"), { recursive: true });
  await fs.writeFile(path.join(root, "ai/config.json"), JSON.stringify({ configs, timeout: 5 }));
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        const headers = new Headers(init.headers),
          key =
            headers.get("x-api-key") ||
            headers.get("authorization") ||
            new URL(String(url)).searchParams.get("key") ||
            "";
        if (key.includes("bad-"))
          return new Response(JSON.stringify({ error: { message: "raw-secret" } }), { status: 401 });
        const target = String(url),
          body = init.body ? JSON.parse(String(init.body)) : {};
        requests.push({ target, body });
        if (target.includes("generativelanguage") && init.method === "POST")
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "gem-ok" }] } }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4, totalTokenCount: 6 },
            }),
          );
        if (target.includes("generativelanguage"))
          return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }));
        if (target.includes("anthropic") && init.method === "POST")
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "anth-ok" }],
              model: body.model,
              usage: { input_tokens: 3, output_tokens: 5 },
            }),
          );
        if (target.includes("anthropic"))
          return new Response(JSON.stringify({ data: [{ id: "claude-3.5-haiku-20241022" }] }));
        if (target.includes("/user/balance"))
          return new Response(
            JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "7.5" }] }),
          );
        if (target.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "deep-ok" } }],
            model: body.model,
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        );
      },
    },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(createAi());
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "provider-consumer",
      description: "fixture",
      commands: {},
      setup(value) {
        ctx = value;
      },
    }),
  );
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [tag, text, total] of [
    ["gem", "gem-ok", 6],
    ["anth", "anth-ok", 8],
    ["deep", "deep-ok", 3],
  ]) {
    const result = await ctx.services.call("ai", "diagnostics", { action: "full", tag });
    assert.equal(result.chat.ok, true);
    assert.equal(result.chat.text, text);
    assert.equal(result.chat.usage.total, total);
    assert.equal(result.models.ok, true);
  }
  const gemBenchmark = await ctx.services.call("ai", "diagnostics", { action: "benchmark", tag: "gem" }),
    anthBenchmark = await ctx.services.call("ai", "diagnostics", { action: "benchmark", tag: "anth" });
  assert.equal(gemBenchmark.benchmarks[0].model, "gemini-2.5-flash");
  assert.equal(anthBenchmark.benchmarks[0].model, "claude-3.5-haiku-20241022");
  assert.equal(
    requests.some(
      item => item.body?.generationConfig?.maxOutputTokens === 50 && item.target.includes("gemini-2.5-flash"),
    ),
    true,
  );
  assert.equal(
    requests.some(item => item.body?.max_tokens === 50 && item.body?.model === "claude-3.5-haiku-20241022"),
    true,
  );
  assert.equal(
    (await ctx.services.call("ai", "diagnostics", { action: "full", tag: "deep" })).balance.fields.some(
      field => field.value === "7.5",
    ),
    true,
  );
  for (const tag of ["gem-bad", "anth-bad", "deep-bad"]) {
    const result = await ctx.services.call("ai", "diagnostics", { action: "full", tag });
    assert.equal(result.balance.status, "invalid");
    assert.equal(JSON.stringify(result).includes("raw-secret"), false);
  }
});

test("a rejected configured model remains a structured chat section failure", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-diag-model-")));
  let ctx;
  const forbidden = ["gpt-5.6-", "lu", "na"].join("");
  await fs.mkdir(path.join(root, "ai"), { recursive: true });
  await fs.writeFile(
    path.join(root, "ai/config.json"),
    JSON.stringify({
      configs: {
        main: {
          tag: "main",
          url: "https://api.openai.com/v1",
          key: "secret",
          stream: false,
          responses: false,
          models: { chat: forbidden },
        },
      },
      timeout: 5,
    }),
  );
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async url =>
        String(url).endsWith("/models")
          ? new Response(JSON.stringify({ data: [{ id: "safe-model" }] }))
          : new Response(JSON.stringify({ plan: { title: "Pro" } })),
    },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(createAi());
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "model-consumer",
      description: "fixture",
      commands: {},
      setup(value) {
        ctx = value;
      },
    }),
  );
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const result = await ctx.services.call("ai", "diagnostics", { action: "full", tag: "main" });
  assert.equal(result.balance.status, "ok");
  assert.equal(result.models.ok, true);
  assert.deepEqual(result.chat, { ok: false, error: "unavailable", elapsedMs: 0 });
});
