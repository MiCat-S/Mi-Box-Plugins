"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const Database = require(path.join(core, "node_modules/better-sqlite3"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { definePlugin } = require(path.join(core, "dist/v2/sdk.js"));
const { artifactDir } = buildPlugin({
    id: "yt-dlp",
    packageRoot: path.resolve(__dirname, "../yt-dlp"),
    entry: "v2.ts",
  }),
  artifact = require(path.join(artifactDir, "index.cjs"));
const musicArtifact = buildPlugin({ id: "music", packageRoot: path.resolve(__dirname, "../music"), entry: "v2.ts" }),
  createMusic = require(path.join(musicArtifact.artifactDir, "index.cjs")).default;
async function tools(root, mode = "ok") {
  const yt = path.join(root, "fake-yt-dlp"),
    ff = path.join(root, "fake-ffmpeg");
  const output =
    mode === "empty"
      ? ":"
      : mode === "large"
        ? "dd if=/dev/zero of=track.mp3 bs=1048576 count=20 2>/dev/null"
        : mode === "slow"
          ? `touch ${JSON.stringify(path.join(root, "download-started"))}; sleep 30`
          : mode === "malicious"
            ? 'printf "private token path" >&2; exit 7'
            : "printf audio > track.mp3; printf cover > track.jpg";
  const entry =
    mode === "live"
      ? '{"id":"live123","title":"Live","duration":120,"is_live":true}'
      : mode === "noresult"
        ? ""
        : mode === "ambiguous"
          ? '{"id":"first11","title":"One","duration":120},{"id":"second22","title":"Two","duration":120}'
          : '{"id":"fixed12345","title":"Track <x>","uploader":"Artist","duration":120,"filesize":1024}';
  const script = `#!/bin/sh\nfor arg in "$@"; do case "$arg" in *proxy-secret*|*cookie-secret*) exit 91;; esac; done\ncase " $* " in *" --dump-single-json "*) printf '%s\\n' '{"entries":[${entry}]}' ;; *) case " $* " in *ytsearch1:*) exit 92;; esac; ${output} ;; esac\n`;
  const ffmpeg = `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(root, "ffmpeg-args"))}\n${mode === "slowffmpeg" ? `touch ${JSON.stringify(path.join(root, "ffmpeg-started"))}; sleep 30` : ""}\ninput=''\nprevious=''\nlast=''\nfor arg in "$@"; do if [ "$previous" = '-i' ]; then input="$arg"; fi; previous="$arg"; last="$arg"; done\ncp "$input" "$last"\n`;
  await fs.writeFile(yt, script, { mode: 0o700 });
  await fs.writeFile(ff, ffmpeg, { mode: 0o700 });
  return { ytDlp: yt, ffmpeg: ff };
}
async function fixture(t, mode = "ok") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "yt-v2-"))),
    tool = await tools(root, mode),
    edits = [],
    files = [],
    logs = [];
  let deleted = 0;
  const client = {
    async sendFile(peer, value) {
      files.push({ peer, value, audio: await fs.readFile(value.file) });
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {
      info() {},
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 512 * 1024 },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op(client, signal);
      },
    },
  });
  await host.load(artifact.default({ locateTools: async () => tool }));
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "probe",
      description: "probe",
      commands: {
        probe: {
          description: "probe",
          async handle({ message }, context) {
            await context.services.call(
              "yt-dlp",
              "download_mp3",
              {
                query: "song",
                message,
                preferred: { title: "Preferred Title", artist: "Preferred Artist", album: "Preferred Album" },
                options: {
                  cookie: "SID=cookie-secret",
                  proxy: "http://user:proxy-secret@example.com",
                  quality: "192k",
                  maxDurationSeconds: 900,
                  maxUploadBytes: 1048576,
                },
              },
              context.signal,
            );
          },
        },
      },
    }),
  );
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    edits,
    files,
    logs,
    deleted: () => deleted,
    run: (text, extra = {}) =>
      host.dispatchPrimary({
        id: 1,
        chatId: "1",
        senderId: "1",
        outgoing: true,
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
test("yt-dlp command uses managed processes/temp files and sends bounded audio metadata", async t => {
  const f = await fixture(t);
  await f.run(".yt https://youtu.be/dQw4w9WgXcQ", { replyToId: 77, topicId: 88 });
  assert.equal(f.files.length, 1);
  assert.equal(f.files[0].audio.toString(), "audio");
  assert.equal(f.files[0].value.replyTo, 77);
  assert.equal(f.files[0].value.topMsgId, 88);
  assert.equal(f.files[0].value.attributes[0].duration, 120);
  assert.match(f.files[0].value.attributes[0].title, /Track _x_/);
  assert.ok(f.files[0].value.attributes.every(attribute => attribute.getBytes().length > 0));
  assert.equal(f.deleted(), 1);
  await assert.rejects(fs.access(path.join(f.root, "ffmpeg-args")), { code: "ENOENT" });
});
test("playlist search wrapper selects one fixed video while live, empty, and ambiguous results fail", async t => {
  for (const mode of ["live", "noresult", "ambiguous"]) {
    const f = await fixture(t, mode);
    await f.run(".yt song");
    assert.equal(f.files.length, 0);
    assert.match(f.edits.at(-1), /下载失败/);
  }
});
test("real Host routes music through yt-dlp.download_mp3 without another download implementation", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "music-yt-service-"))),
    tool = await tools(root),
    files = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 512 * 1024 },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient(op, signal) {
        return op(
          {
            async sendFile(_peer, value) {
              files.push(await fs.readFile(value.file));
            },
          },
          signal,
        );
      },
    },
  });
  await host.load(artifact.default({ locateTools: async () => tool }));
  await host.load(createMusic());
  await host.dispatchPrimary({
    id: 1,
    chatId: "1",
    senderId: "1",
    outgoing: true,
    saved: true,
    text: ".music Track - Artist",
    raw: { peerId: {}, async delete() {} },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].toString(), "audio");
  assert.equal((await host.shutdown(2000)).completed, true);
  await fs.rm(root, { recursive: true, force: true });
});
test("download service keeps secrets out of argv and writes every preferred ID3 tag through managed FFmpeg", async t => {
  const f = await fixture(t);
  await f.run(".probe");
  assert.equal(f.files.length, 1);
  assert.equal(f.files[0].audio.toString(), "audio");
  assert.equal(path.basename(f.files[0].value.file), "track.mp3");
  assert.ok(f.files[0].value.thumb.endsWith("track.jpg"));
  const args = (await fs.readFile(path.join(f.root, "ffmpeg-args"), "utf8")).split("\n");
  for (const expected of [
    "-map",
    "0",
    "-c",
    "copy",
    "title=Preferred Title",
    "artist=Preferred Artist",
    "album=Preferred Album",
  ])
    assert.ok(args.includes(expected), expected);
  assert.doesNotMatch(args.join("\n"), /proxy-secret|cookie-secret/);
});
test("empty or oversized final output is rejected and never sent", async t => {
  const f = await fixture(t, "empty");
  await f.run(".yt song");
  assert.equal(f.files.length, 0);
  assert.match(f.edits.at(-1), /下载失败/);
  assert.equal(f.deleted(), 0);
});
test("workspace growth beyond the derived budget is rejected before upload", async t => {
  const f = await fixture(t, "large");
  await assert.rejects(f.run(".probe"), /WORKSPACE_LIMIT/);
  assert.equal(f.files.length, 0);
});
test("legacy Gemini sqlite imports before erasure and failed imports retry after reload", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "yt-migrate-"))),
    db = new Database(path.join(root, "ytdlp_gemini_config.db"));
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO config VALUES (?, ?)");
  insert.run("ytdlp_gemini_api_key", "legacy-secret");
  insert.run("ytdlp_gemini_base_url", "https://generativelanguage.googleapis.com");
  insert.run("ytdlp_gemini_model", "gemini-old");
  db.close();
  let fail = true;
  const imports = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 512 * 1024 },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(
    definePlugin({
      apiVersion: 1,
      id: "ai",
      description: "mock",
      commands: {},
      services: {
        import_provider: {
          description: "mock",
          handle(input) {
            imports.push(input);
            if (fail) throw new Error("temporary");
            return { tag: "yt-dlp" };
          },
        },
      },
    }),
  );
  await host.load(artifact.default({ locateTools: async () => assert.fail() }));
  let state = JSON.parse(await fs.readFile(path.join(root, "yt-dlp", "config.json"), "utf8").catch(() => "{}"));
  assert.notEqual(state.legacyAiMigrated, true);
  const before = new Database(path.join(root, "ytdlp_gemini_config.db"), { readonly: true });
  assert.equal(
    before.prepare("SELECT value FROM config WHERE key=?").get("ytdlp_gemini_api_key").value,
    "legacy-secret",
  );
  before.close();
  assert.equal((await host.unload("yt-dlp", 1000)).completed, true);
  fail = false;
  await host.load(artifact.default({ locateTools: async () => assert.fail() }));
  state = JSON.parse(await fs.readFile(path.join(root, "yt-dlp", "config.json"), "utf8"));
  assert.equal(state.legacyAiMigrated, true);
  assert.equal(state.importedAiTag, "yt-dlp");
  const verify = new Database(path.join(root, "ytdlp_gemini_config.db"), { readonly: true });
  assert.equal(verify.prepare("SELECT value FROM config WHERE key=?").get("ytdlp_gemini_api_key").value, "");
  verify.close();
  assert.equal(imports.length, 2);
  assert.equal(imports[0].key, "legacy-secret");
  assert.equal((await host.shutdown(1000)).completed, true);
  await fs.rm(root, { recursive: true, force: true });
});
test("unload cancels the managed download process before upload or receipt deletion", async t => {
  const f = await fixture(t, "slow");
  const pending = f.run(".yt song");
  const marker = path.join(f.root, "download-started");
  for (let i = 0; i < 100; i++) {
    try {
      await fs.access(marker);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await fs.access(marker);
  assert.equal((await f.host.unload("yt-dlp", 2000)).completed, true);
  await pending;
  assert.equal(f.files.length, 0);
  assert.equal(f.deleted(), 0);
});
test("unload cancels metadata FFmpeg before replacing or uploading the file", async t => {
  const f = await fixture(t, "slowffmpeg"),
    pending = f.run(".probe"),
    marker = path.join(f.root, "ffmpeg-started");
  for (let i = 0; i < 100; i++) {
    try {
      await fs.access(marker);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await fs.access(marker);
  assert.equal((await f.host.unload("yt-dlp", 2000)).completed, true);
  await assert.rejects(pending);
  assert.equal(f.files.length, 0);
});
test("native process diagnostics never enter logs or user output", async t => {
  const f = await fixture(t, "malicious");
  await f.run(".yt song");
  assert.match(f.edits.at(-1), /下载失败/);
  assert.doesNotMatch(JSON.stringify(f.logs) + f.edits.join("\n"), /private token path|ProcessExecutionError/);
  assert.deepEqual(f.logs.at(-1), { event: "yt_dlp_download_failed", fields: { code: "FAILED" } });
});
test("post-send temp cleanup failure returns delivered success while upload failure still rejects", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "yt-cleanup-"))),
    work = path.join(root, "work");
  await fs.mkdir(work);
  const signal = new AbortController().signal,
    logs = [];
  let sends = 0;
  const context = {
    signal,
    log: {
      info(event) {
        logs.push(event);
      },
    },
    files: {
      async withTemp(use) {
        const value = await use(work, signal);
        assert.deepEqual(value, { title: "Track", artist: "Artist", duration: 120 });
        throw Object.assign(new Error("private cleanup path"), { name: "SecretCleanupError" });
      },
    },
    processes: {
      async run(_command, args, options) {
        if (args.includes("--dump-single-json"))
          return {
            stdout: Buffer.from('{"entries":[{"id":"fixed12345","title":"Track","uploader":"Artist","duration":120}]}'),
            stderr: Buffer.alloc(0),
          };
        await fs.writeFile(path.join(options.cwd, "track.mp3"), "audio");
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    },
    telegram: {
      async withClient(use) {
        return use(
          {
            async sendFile() {
              sends++;
            },
          },
          signal,
        );
      },
    },
  };
  const message = { id: 1, chatId: "1", senderId: "1", outgoing: true, text: "", raw: { peerId: {} } };
  const options = { cookie: "", proxy: "", quality: "", maxDurationSeconds: 900, maxUploadBytes: 1048576 };
  const result = await artifact.downloadAndSend(context, message, "song", options, undefined, signal, {
    locateTools: async () => ({ ytDlp: "/fake/yt-dlp", ffmpeg: "/fake/ffmpeg" }),
  });
  assert.deepEqual(result, { title: "Track", artist: "Artist", duration: 120 });
  assert.equal(sends, 1);
  assert.deepEqual(logs, ["yt_dlp_temp_cleanup_failed"]);
  sends = 0;
  context.files.withTemp = async use => {
    try {
      return await use(work, signal);
    } finally {
      throw new Error("cleanup");
    }
  };
  context.telegram.withClient = use =>
    use(
      {
        async sendFile() {
          sends++;
          throw new Error("upload failed");
        },
      },
      signal,
    );
  await assert.rejects(
    artifact.downloadAndSend(context, message, "song", options, undefined, signal, {
      locateTools: async () => ({ ytDlp: "/fake/yt-dlp", ffmpeg: "/fake/ffmpeg" }),
    }),
  );
  assert.equal(sends, 1);
  await fs.rm(root, { recursive: true, force: true });
});
