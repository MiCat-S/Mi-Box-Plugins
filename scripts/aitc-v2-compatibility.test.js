"use strict";
// Behavioral compatibility tests for aitc AITC01..05: real legacy SQLite migration,
// raw argument tails, plain-text sanitization, defaults/reserved aliases, info pagination.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const Database = require(path.join(core, "node_modules/better-sqlite3"));

function create(id) {
  const { artifactDir } = buildPlugin({ id, packageRoot: path.resolve(__dirname, `../${id}`), entry: "v2.ts" });
  delete require.cache[require.resolve(path.join(artifactDir, "index.cjs"))];
  return require(path.join(artifactDir, "index.cjs")).default();
}
function aiConfig() {
  return {
    configs: {
      main: {
        tag: "main",
        url: "https://api.example.test/v1",
        key: "central-secret",
        type: "openai-compatible",
        stream: false,
        responses: false,
        models: { chat: "central-model" },
      },
    },
    currentChatTag: "main",
    currentChatModel: "central-model",
    currentChatReasoningEffort: "auto",
    currentChatServiceTier: "auto",
    currentSearchTag: "",
    currentSearchModel: "",
    currentSearchReasoningEffort: "auto",
    currentSearchServiceTier: "auto",
    currentImageTag: "",
    currentImageModel: "",
    currentVideoTag: "",
    currentVideoModel: "",
    timeout: 30,
    prompt: "",
    collapse: true,
    imagePreview: true,
    videoPreview: true,
    videoAudio: false,
    videoDuration: 5,
    telegraphToken: "",
    telegraph: { enabled: false, limit: 5, list: [] },
  };
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aitc-compat-")));
  if (options.ai !== null && options.ai !== false) {
    await fs.mkdir(path.join(root, "ai"));
    await fs.writeFile(path.join(root, "ai/config.json"), JSON.stringify(options.ai ?? aiConfig()));
  }
  if (options.legacyJson) {
    await fs.mkdir(path.join(root, "aitc"), { recursive: true });
    await fs.writeFile(path.join(root, "aitc/config.json"), JSON.stringify(options.legacyJson));
  }
  if (options.sqlite) {
    await fs.mkdir(path.join(root, "aitc"), { recursive: true });
    const db = new Database(path.join(root, "aitc/aitc_config.db"));
    db.exec(
      "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    );
    const insert = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(options.sqlite)) insert.run(key, value);
    db.close();
  }
  const edits = [],
    replies = [],
    requests = [];
  let reply,
    response = options.response ?? { choices: [{ message: { content: "translated" } }] };
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        requests.push({ url: new URL(url), init });
        return Response.json(typeof response === "function" ? response() : response);
      },
    },
    telegram: {
      async edit(message, text, opts) {
        edits.push({ text, opts });
      },
      async reply(message, text) {
        replies.push({ text, message });
      },
      async invoke() {},
      async getReply() {
        return reply;
      },
      async withClient() {
        assert.fail("unexpected native call");
      },
    },
  });
  const read = async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
  if (options.ai !== null) await host.load(create("ai"));
  if (options.beforeAitc) await options.beforeAitc(root);
  await host.load(create("aitc"));
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    replies,
    requests,
    read,
    setReply(value) {
      reply = value;
    },
    setResponse(value) {
      response = value;
    },
    run: (text, message = {}) =>
      host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text, ...message }),
  };
}

// ---------------------------------------------------------------------------
// AITC01: legacy SQLite migration
// ---------------------------------------------------------------------------
test("AITC01 migrates the legacy SQLite prompt/presets/temp and provider, erasing the key exactly once", async t => {
  const f = await fixture(t, {
    ai: false,
    sqlite: {
      aitc_api_key: "legacy-secret",
      aitc_api_url: "https://legacy.example.test",
      aitc_model: "legacy-model",
      aitc_prompt: "legacy long prompt",
      aitc_prompts: JSON.stringify({ casual: "Use a casual voice" }),
      aitc_temperature: "0.7",
    },
  });
  const central = await f.read("ai/config.json");
  assert.equal(central.configs.aitc.key, "legacy-secret");
  assert.equal(central.configs.aitc.models.chat, "legacy-model");
  assert.equal(central.currentChatTag, "aitc");
  const local = await f.read("aitc/config.json");
  assert.equal(local.prompt, "legacy long prompt");
  assert.equal(local.prompts.casual, "Use a casual voice");
  assert.equal(local.temperature, 0.7);
  assert.equal(local.apiKey, "", "the secret is erased after a successful central import");
  assert.equal(local.providerMigrated, true);
  assert.equal(local.sqliteMigrated, true);
  assert.equal(f.requests.length, 0, "migration performs no network operation");
  // The legacy SQLite secret row is really gone, and reloads never resurrect it.
  const inspect = new Database(path.join(f.root, "aitc/aitc_config.db"), { readonly: true });
  assert.equal(
    inspect.prepare("SELECT value FROM config WHERE key = 'aitc_api_key'").get(),
    undefined,
    "legacy key row erased",
  );
  inspect.close();
  for (let round = 0; round < 2; round++) {
    assert.equal((await f.host.unload("aitc", 1000)).completed, true);
    await f.host.load(create("aitc"));
    assert.equal((await f.read("aitc/config.json")).apiKey, "", `reload ${round + 1} keeps the JSON key empty`);
  }
  const again = await f.read("ai/config.json");
  assert.deepEqual(Object.keys(again.configs), ["aitc"]);
  assert.equal(again.configs.aitc.key, "legacy-secret");
});

test("AITC01 an existing V2 aiMigrated flag never skips an unprocessed SQLite key", async t => {
  const f = await fixture(t, {
    legacyJson: {
      prompt: "v2 prompt",
      prompts: {},
      temperature: 0.2,
      apiKey: "",
      apiUrl: "",
      model: "",
      aiMigrated: true,
    },
    sqlite: { aitc_api_key: "sqlite-secret", aitc_api_url: "https://sqlite.example.test", aitc_model: "sqlite-model" },
  });
  const local = await f.read("aitc/config.json");
  assert.equal(local.providerMigrated, true);
  assert.equal(local.apiKey, "");
  const central = await f.read("ai/config.json");
  assert.equal(central.configs.aitc.key, "sqlite-secret");
  const inspect = new Database(path.join(f.root, "aitc/aitc_config.db"), { readonly: true });
  assert.equal(inspect.prepare("SELECT value FROM config WHERE key = 'aitc_api_key'").get(), undefined);
  inspect.close();
});

test("AITC01 a failed SQLite erase keeps the secret and retries without duplicating the provider", async t => {
  const f = await fixture(t, {
    sqlite: { aitc_api_key: "legacy-secret", aitc_api_url: "https://legacy.example.test", aitc_model: "legacy-model" },
    beforeAitc: async root => {
      await fs.chmod(path.join(root, "aitc/aitc_config.db"), 0o444);
    },
  });
  const failed = await f.read("aitc/config.json");
  assert.equal(failed.providerMigrated, false, "an erase failure must not mark completion");
  assert.equal(failed.apiKey, "");
  const before = new Database(path.join(f.root, "aitc/aitc_config.db"), { readonly: true });
  assert.equal(
    before.prepare("SELECT value FROM config WHERE key = 'aitc_api_key'").get().value,
    "legacy-secret",
    "key retained for retry",
  );
  before.close();
  await fs.chmod(path.join(f.root, "aitc/aitc_config.db"), 0o644);
  assert.equal((await f.host.unload("aitc", 1000)).completed, true);
  await f.host.load(create("aitc"));
  const after = await f.read("aitc/config.json");
  assert.equal(after.providerMigrated, true);
  const central = await f.read("ai/config.json");
  assert.deepEqual(
    Object.keys(central.configs).sort(),
    ["aitc", "main"],
    "the retry imports the provider without duplication",
  );
});

test("AITC01 a key-only legacy DB migrates with the original default model and API root", async t => {
  const f = await fixture(t, { ai: false, sqlite: { aitc_api_key: "only-key" } });
  const central = await f.read("ai/config.json");
  assert.equal(central.configs.aitc.key, "only-key");
  assert.equal(central.configs.aitc.models.chat, "gpt-4o-mini");
  assert.equal(new URL(central.configs.aitc.url).host, "api.openai.com");
});

test("AITC01 keeps the secret for retry when ai is unavailable and migrates non-secret settings", async t => {
  const f = await fixture(t, {
    ai: null,
    sqlite: {
      aitc_api_key: "legacy-secret",
      aitc_api_url: "https://legacy.example.test",
      aitc_model: "legacy-model",
      aitc_prompt: "legacy prompt",
      aitc_temperature: "0.9",
    },
  });
  const before = await f.read("aitc/config.json");
  assert.equal(before.prompt, "legacy prompt");
  assert.equal(before.temperature, 0.9);
  assert.equal(before.providerMigrated, false);
  const retained = new Database(path.join(f.root, "aitc/aitc_config.db"), { readonly: true });
  assert.equal(
    retained.prepare("SELECT value FROM config WHERE key = 'aitc_api_key'").get().value,
    "legacy-secret",
    "the SQLite secret is retained until the central import succeeds",
  );
  retained.close();
  // Install ai and retry: the provider is imported and the secret erased.
  await f.host.load(create("ai"));
  assert.equal((await f.host.unload("aitc", 1000)).completed, true);
  await f.host.load(create("aitc"));
  const after = await f.read("aitc/config.json");
  assert.equal(after.apiKey, "");
  assert.equal(after.providerMigrated, true);
  const central = await f.read("ai/config.json");
  assert.equal(central.configs.aitc.key, "legacy-secret");
  assert.equal(central.configs.aitc.models.chat, "legacy-model");
});

test("AITC01 a corrupt legacy DB is a retryable error, not a completed migration", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aitc-corrupt-")));
  await fs.mkdir(path.join(root, "aitc"), { recursive: true });
  await fs.writeFile(path.join(root, "aitc/aitc_config.db"), "this is not sqlite");
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient() {},
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(host.load(create("aitc")), /LEGACY_UNREADABLE/);
});

test("AITC01 a completed migration never reads the legacy DB again", async t => {
  const f = await fixture(t, {
    ai: false,
    sqlite: { aitc_api_key: "legacy-secret", aitc_api_url: "https://legacy.example.test", aitc_model: "legacy-model" },
  });
  assert.equal((await f.read("aitc/config.json")).providerMigrated, true);
  // Destroy the legacy DB: any future read would now throw LEGACY_UNREADABLE.
  await fs.writeFile(path.join(f.root, "aitc/aitc_config.db"), "destroyed");
  assert.equal((await f.host.unload("aitc", 1000)).completed, true);
  await f.host.load(create("aitc"));
  await f.run(".aitc hello");
  assert.match(f.edits.at(-1).text, /translated/, "a normal call still succeeds after the DB is destroyed");
});

test("AITC01 a concurrent settings write during migration is preserved over the legacy value", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aitc-concurrent-")));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "aitc"), { recursive: true });
  await fs.writeFile(path.join(root, "aitc/aitc_config.db"), "legacy");
  await fs.writeFile(path.join(root, "aitc/config.json"), JSON.stringify({ prompts: {}, temperature: 0.9 }));
  const config = {
    apiKey: "",
    apiUrl: "",
    model: "",
    prompt: "default prompt",
    prompts: {},
    temperature: 0.9,
    aiMigrated: false,
    sqliteMigrated: false,
    providerMigrated: false,
  };
  let latched = false;
  const context = {
    signal: new AbortController().signal,
    log: { info() {}, error() {} },
    files: { dataPath: (name = "aitc_config.db") => path.join(root, "aitc", name) },
    storage: {
      json: () => ({
        read: async () => ({ ...config }),
        update: async mutator => {
          // Deterministic latch: a settings write lands after the presence snapshot, before the migration update.
          if (!latched) {
            latched = true;
            config.prompt = "user concurrent prompt";
          }
          Object.assign(config, await mutator({ ...config }));
          return { ...config };
        },
      }),
      sqlite: () => ({
        read: async callback =>
          callback({ prepare: () => ({ all: () => [{ key: "aitc_prompt", value: "legacy prompt" }] }) }),
      }),
    },
    services: { available: () => false },
  };
  await create("aitc").setup(context);
  assert.equal(config.prompt, "user concurrent prompt", "the concurrent user prompt wins over the legacy value");
});

test("AITC01 differing JSON and SQLite providers are both preserved in central ai", async t => {
  const f = await fixture(t, {
    legacyJson: {
      apiKey: "json-key",
      apiUrl: "https://json.example.test",
      model: "json-model",
      prompt: "json prompt",
      prompts: {},
      temperature: 0.2,
      aiMigrated: false,
    },
    sqlite: { aitc_api_key: "sqlite-key", aitc_api_url: "https://sqlite.example.test", aitc_model: "sqlite-model" },
  });
  assert.equal((await f.read("aitc/config.json")).providerMigrated, true);
  const central = await f.read("ai/config.json");
  const byKey = Object.values(central.configs).filter(
    provider => provider.key === "json-key" || provider.key === "sqlite-key",
  );
  assert.equal(byKey.length, 2, "both credentials are imported, none silently dropped");
  const inspect = new Database(path.join(f.root, "aitc/aitc_config.db"), { readonly: true });
  assert.equal(inspect.prepare("SELECT value FROM config WHERE key = 'aitc_api_key'").get(), undefined);
  inspect.close();
});

test("AITC01 does not create an empty legacy DB and prefers existing user settings", async t => {
  const f = await fixture(t, {
    legacyJson: {
      apiKey: "",
      apiUrl: "",
      model: "",
      prompt: "my custom prompt",
      prompts: { mine: "keep me" },
      temperature: 0.4,
      aiMigrated: false,
    },
  });
  assert.equal(
    await fs.stat(path.join(f.root, "aitc/aitc_config.db")).then(
      () => true,
      () => false,
    ),
    false,
    "no legacy DB is created",
  );
  const local = await f.read("aitc/config.json");
  assert.equal(local.prompt, "my custom prompt");
  assert.equal(local.prompts.mine, "keep me");
  assert.equal(local.temperature, 0.4);
  assert.equal(local.providerMigrated, true);
});

test(
  "AITC01 cancellation during the central import aborts and keeps the secret for retry",
  { timeout: 10_000 },
  async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aitc-cancel-")));
    t.after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, "aitc"), { recursive: true });
    await fs.writeFile(path.join(root, "aitc/aitc_config.db"), "legacy");
    const config = {
      apiKey: "legacy-secret",
      apiUrl: "https://legacy.example.test",
      model: "legacy-model",
      prompt: "legacy prompt",
      prompts: {},
      temperature: 0.2,
      aiMigrated: false,
    };
    const controller = new AbortController();
    let enteredResolve;
    const entered = new Promise(resolve => {
      enteredResolve = resolve;
    });
    const context = {
      signal: controller.signal,
      log: { info() {}, error() {} },
      files: { dataPath: (name = "aitc_config.db") => path.join(root, "aitc", name) },
      storage: {
        json: () => ({
          read: async () => config,
          update: async mutator => {
            Object.assign(config, await mutator({ ...config }));
            return config;
          },
        }),
        sqlite: () => ({
          read: async callback =>
            callback({
              prepare: () => ({
                all: () => [
                  { key: "aitc_api_key", value: "legacy-secret" },
                  { key: "aitc_api_url", value: "https://legacy.example.test" },
                  { key: "aitc_model", value: "legacy-model" },
                ],
              }),
            }),
        }),
      },
      services: {
        available: () => true,
        call: () =>
          new Promise((_resolve, reject) => {
            enteredResolve();
            if (controller.signal.aborted) {
              reject(controller.signal.reason);
              return;
            }
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          }),
      },
    };
    const pending = create("aitc").setup(context);
    await entered; // handshake: the import is definitely in flight before we abort
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(pending, error => error?.name === "AbortError");
    assert.equal(config.apiKey, "legacy-secret", "the secret survives a cancelled import for a later retry");
    assert.ok(!config.providerMigrated);
  },
);

// ---------------------------------------------------------------------------
// AITC02: raw argument tails
// ---------------------------------------------------------------------------
test("AITC02 preserves multi-line and double-space tails in prompt, preset and input", async t => {
  const f = await fixture(t);
  await f.run(".aitc prompt first line\n  second   line");
  let local = await f.read("aitc/config.json");
  assert.equal(local.prompt, "first line\n  second   line");
  await f.run(".aitc spn code use  code\n  block");
  local = await f.read("aitc/config.json");
  assert.equal(local.prompts.code, "use  code\n  block");
  await f.run(".aitc code hello\n  world  now");
  const body = JSON.parse(f.requests.at(-1).init.body);
  assert.equal(body.messages[0].content, "use  code\n  block", "preset systemPrompt keeps whitespace");
  assert.equal(body.messages[1].content, "hello\n  world  now", "preset input keeps whitespace");
  await f.run(".aitc raw\n  input  text");
  const body2 = JSON.parse(f.requests.at(-1).init.body);
  assert.equal(body2.messages[1].content, "raw\n  input  text", "default input keeps whitespace");
});

// ---------------------------------------------------------------------------
// AITC03: plain-text sanitization
// ---------------------------------------------------------------------------
test("AITC03 decodes entities, strips control characters and stays literal", async t => {
  const f = await fixture(t, {
    response: () => ({
      choices: [
        {
          message: { content: "&lt;b&gt;A&lt;/b&gt; &#65; &#x1F600;\r\n\u0007tail &#1114112; &#99999999999999999999;" },
        },
      ],
    }),
  });
  await f.run(".aitc hi");
  const page = f.edits.at(-1).text;
  assert.ok(page.includes("&lt;b&gt;A&lt;/b&gt;"), "entities decode then re-escape to literal HTML");
  assert.ok(page.includes("A 😀"), "numeric and hex entities decode");
  assert.ok(page.includes("tail"));
  assert.ok(!page.includes("\r") && !page.includes("\u0007"), "control characters are removed");
  assert.ok(!page.includes("&#65;") && !page.includes("&#x1F600;"), "entities are not left undecoded");
  assert.ok(page.includes("&amp;#1114112;"), "an out-of-range entity stays literal without throwing");
  assert.ok(page.includes("&amp;#99999999999999999999;"), "a huge numeric entity stays literal");
});

// ---------------------------------------------------------------------------
// AITC04: default prompt and reserved aliases
// ---------------------------------------------------------------------------
test("AITC04 uses the original long default prompt and refuses reserved preset names", async t => {
  const f = await fixture(t);
  const local = await f.read("aitc/config.json");
  assert.match(local.prompt, /Only output the translated content!!!/);
  assert.ok(local.prompt.length > 200, "the original long default prompt is restored");
  for (const name of ["_set_prompt", "help", "h", "info", "key", "spn", "aitc"]) {
    await f.run(`.aitc spn ${name} attempt`);
    assert.match(f.edits.at(-1).text, /需要有效名称和内容|冲突|无效/, name);
  }
  const after = await f.read("aitc/config.json");
  for (const name of ["_set_prompt", "help", "info", "key", "spn", "aitc"])
    assert.equal(after.prompts[name], undefined);
  await f.run(".aitc temp 1foo");
  assert.match(f.edits.at(-1).text, /无效的温度值/);
});

test("AITC04 explicit JSON fields (even default-looking values) win over the legacy SQLite values", async t => {
  const f = await fixture(t, {
    legacyJson: {
      prompt: "user prompt",
      prompts: {},
      temperature: 0.2,
      apiKey: "",
      apiUrl: "",
      model: "",
      aiMigrated: false,
    },
    sqlite: { aitc_prompt: "legacy prompt", aitc_temperature: "0.5" },
  });
  const local = await f.read("aitc/config.json");
  assert.equal(local.prompt, "user prompt", "an explicit JSON prompt wins even if it looks like the default");
  assert.equal(local.temperature, 0.2, "an explicit JSON temperature of 0.2 wins");
});

test("AITC04 legacy values apply only for fields absent from the JSON", async t => {
  const f = await fixture(t, {
    legacyJson: { prompts: {}, apiKey: "", apiUrl: "", model: "", aiMigrated: false },
    sqlite: { aitc_prompt: "legacy prompt", aitc_temperature: "0.5", aitc_prompts: JSON.stringify({ legacy: "L" }) },
  });
  const local = await f.read("aitc/config.json");
  assert.equal(local.prompt, "legacy prompt");
  assert.equal(local.temperature, 0.5);
  assert.equal(local.prompts.legacy, "L");
});

// ---------------------------------------------------------------------------
// AITC05: info pagination and no secret disclosure
// ---------------------------------------------------------------------------
test("AITC05 info paginates long prompts/presets and never shows secrets", async t => {
  const prompts = {};
  for (let index = 0; index < 60; index++) prompts[`preset${String(index).padStart(2, "0")}`] = `value ${index}`;
  const f = await fixture(t, {
    legacyJson: {
      prompt: "P".repeat(20_000),
      prompts,
      temperature: 0.2,
      apiKey: "legacy-secret",
      apiUrl: "",
      model: "",
      aiMigrated: true,
    },
  });
  await f.run(".aitc info");
  const pages = [...f.edits.map(entry => entry.text), ...f.replies.map(entry => entry.text)];
  assert.ok(f.replies.length >= 1, "info paginates across messages");
  const all = pages.join("\n");
  assert.ok(all.includes("P".repeat(100)), "the long prompt is present");
  for (let index = 0; index < 60; index++)
    assert.ok(all.includes(`preset${String(index).padStart(2, "0")}`), `preset${index} visible`);
  assert.ok(!all.includes("legacy-secret"), "secrets are never shown");
  for (const page of pages) assert.ok(page.length > 0 && page.length <= 3500, `bounded page (${page.length})`);
});
