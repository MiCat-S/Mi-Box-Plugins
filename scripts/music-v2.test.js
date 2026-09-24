"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));
const { artifactDir } = buildPlugin({ id: "music", packageRoot: path.resolve(__dirname, "../music"), entry: "v2.ts" }),
  create = require(path.join(artifactDir, "index.cjs")).default;
async function fixture(t, { provider = true, ai = true, legacy, providerError } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "music-v2-")));
  if (legacy) {
    await fs.mkdir(path.join(root, "music"), { recursive: true });
    await fs.writeFile(path.join(root, "music", "music_config.json"), JSON.stringify(legacy));
  }
  const edits = [],
    calls = [],
    imports = [],
    logs = [];
  let deleted = 0;
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    telegram: {
      async edit(_m, text, options) {
        edits.push({ text, options });
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op({}, signal);
      },
    },
  });
  if (ai)
    await host.load(
      definePlugin({
        apiVersion: 1,
        id: "ai",
        description: "mock",
        commands: {},
        services: {
          chat: {
            description: "mock",
            handle() {
              return "歌曲名: 晴天\n歌手: 周杰伦\n专辑: 叶惠美";
            },
          },
          import_provider: {
            description: "mock",
            handle(input) {
              imports.push(input);
              return { tag: "music" };
            },
          },
        },
      }),
    );
  if (provider)
    await host.load(
      definePlugin({
        apiVersion: 1,
        id: "yt-dlp",
        description: "mock",
        commands: {},
        services: {
          download_mp3: {
            description: "mock",
            handle(input, _c, signal) {
              signal.throwIfAborted();
              calls.push(input);
              if (providerError) throw providerError;
              return { title: "晴天", artist: "周杰伦", duration: 269 };
            },
          },
        },
      }),
    );
  await host.load(create());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    calls,
    imports,
    logs,
    deleted: () => deleted,
    run: (text, extra = {}) =>
      host.dispatchPrimary({
        id: 1,
        chatId: "1",
        senderId: "1",
        outgoing: true,
        saved: true,
        text,
        raw: {
          peerId: {},
          async delete() {
            deleted++;
          },
        },
        ...extra,
      }),
  };
}
test("music delegates recognized search and direct URLs exclusively to yt-dlp.download_mp3", async t => {
  const f = await fixture(t);
  await f.run(".music 想听晴天");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].query, "周杰伦 晴天 lyrics");
  assert.deepEqual(f.calls[0].preferred, { title: "晴天", artist: "周杰伦", album: "叶惠美" });
  assert.equal(f.deleted(), 1);
  await f.run(".music https://youtu.be/dQw4w9WgXcQ");
  assert.equal(f.calls[1].query, "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(f.calls[1].preferred, undefined);
});
test("music remains loadable without provider and never starts its own process or HTTP engine", async t => {
  const f = await fixture(t, { provider: false });
  await f.run(".music song");
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /需要 yt-dlp 插件/);
});
test("secret settings stay in Saved Messages and are passed only inside the service request", async t => {
  const f = await fixture(t);
  await f.run(".music set cookie top-secret", { saved: false, chatId: "-100" });
  await f.run(".music set proxy http://user:pass@example.com", { saved: false, chatId: "-100" });
  assert.match(f.edits.at(-1).text, /只能在收藏夹/);
  await f.run(".music set cookie top-secret");
  await f.run(".music set proxy http://user:pass@example.com");
  await f.run(".music set quality 192kbps");
  await f.run(".music 周杰伦 - 晴天");
  assert.equal(f.calls[0].options.cookie, "top-secret");
  assert.equal(f.calls[0].options.proxy, "http://user:pass@example.com");
  assert.equal(f.calls[0].options.quality, "192k");
  assert.doesNotMatch(f.edits.map(x => x.text).join("\n"), /top-secret|user:pass/);
});
test("raw canonical and injected-alias routes preserve multiline Netscape cookies while settings mask secrets", async t => {
  const f = await fixture(t);
  const direct = ".music set cookie # Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tdirect";
  await f.run(direct, { raw: { peerId: {}, message: direct } });
  let state = JSON.parse(await fs.readFile(path.join(f.root, "music", "config.json"), "utf8"));
  assert.equal(state.cookie, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tdirect");
  f.host.replaceAliases({ mc: "music set cookie" });
  const aliased = ".mc # Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\talias";
  await f.run(aliased, { raw: { peerId: {}, message: aliased } });
  state = JSON.parse(await fs.readFile(path.join(f.root, "music", "config.json"), "utf8"));
  assert.equal(state.cookie, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\talias");
  await f.host.patchSettings("music", { proxy: "http://user:panel-secret@example.com" });
  const visible = await f.host.readSettings("music");
  assert.equal(visible.secretSet.cookie, true);
  assert.equal(visible.secretSet.proxy, true);
  assert.equal(visible.values.cookie, undefined);
  assert.equal(visible.values.proxy, undefined);
  assert.doesNotMatch(JSON.stringify(visible), /alias|panel-secret|user:/);
});
test("malicious provider errors use a fixed log code and never expose name or message", async t => {
  const secret = Object.assign(new Error("private token and path"), { name: "SecretTokenError" }),
    f = await fixture(t, { providerError: secret });
  await f.run(".music song");
  assert.match(f.edits.at(-1).text, /音乐下载失败/);
  assert.doesNotMatch(JSON.stringify(f.logs), /SecretTokenError|private|token|path/);
  assert.deepEqual(f.logs.at(-1), { event: "music_download_failed", fields: { code: "FAILED" } });
});
test("legacy music config migrates through ai.import_provider, scrubs the key, and preserves download settings", async t => {
  const legacy = {
    music_ytdlp_cookie: "cookie",
    music_ytdlp_proxy: "https://proxy.example",
    music_audio_quality: "320k",
    settings: { apikey: "legacy-key" },
    music_gemini_model: "gemini-old",
    unknown: "keep",
  };
  const f = await fixture(t, { legacy });
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].key, "legacy-key");
  const scrubbed = JSON.parse(await fs.readFile(path.join(f.root, "music", "music_config.json"), "utf8"));
  assert.equal(scrubbed.settings.apikey, "");
  const state = JSON.parse(await fs.readFile(path.join(f.root, "music", "config.json"), "utf8"));
  assert.equal(state.cookie, "cookie");
  assert.equal(state.proxy, "https://proxy.example");
  assert.equal(state.quality, "320k");
  assert.equal(state.aiMigrated, true);
  assert.equal(state.legacyAi, undefined);
});
test("download cancellation does not delete the command receipt or emit stale failure", async t => {
  let entered, release;
  const gate = new Promise(r => {
    release = r;
  });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "music-cancel-"))),
    edits = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op({}, signal);
      },
    },
  });
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "yt-dlp",
      description: "mock",
      commands: {},
      services: {
        download_mp3: {
          description: "mock",
          async handle(_i, _c, signal) {
            entered = Promise.resolve();
            await gate;
            signal.throwIfAborted();
          },
        },
      },
    }),
  );
  await host.load(create());
  let deleted = 0;
  const pending = host.dispatchPrimary({
    id: 1,
    chatId: "1",
    senderId: "1",
    outgoing: true,
    text: ".music x",
    raw: {
      peerId: {},
      async delete() {
        deleted++;
      },
    },
  });
  while (!entered) await new Promise(r => setImmediate(r));
  const unloading = host.unload("music", 1000);
  release();
  assert.equal((await unloading).completed, true);
  await pending;
  assert.equal(deleted, 0);
  assert.doesNotMatch(edits.at(-1), /失败/);
  await host.shutdown(1000);
  await fs.rm(root, { recursive: true, force: true });
});
