"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { resolveId } = require(path.join(core, "node_modules/teleproto/Utils.js"));

function artifact() {
  const { artifactDir } = buildPlugin({
    id: "convert",
    packageRoot: path.resolve(__dirname, "../convert"),
    entry: "v2.ts",
  });
  const entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default;
}

test("convert runs mocked helpers through the real host and uses an exact native peer", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-convert-compat-")));
  const helper = path.join(root, "media-helper");
  const log = path.join(root, "helper.log");
  await fs.writeFile(
    helper,
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${log}'\ncase "$*" in *format=duration*) printf "12.4";; *) for last do :; done; printf "mp3" > "$last";; esac\n`,
  );
  await fs.chmod(helper, 0o700);
  const sent = [],
    deleted = [],
    edits = [];
  const source = { media: {}, document: { size: 1024n, attributes: [{ fileName: "演唱会.mp4" }] } };
  const client = {
    async downloadMedia(_media, options) {
      assert.ok(options.signal instanceof AbortSignal);
      options.progressCallback(1024n, 1024n);
      await fs.writeFile(options.outputFile, Buffer.alloc(1024));
    },
    async sendFile(peer, options) {
      sent.push({ peer, options });
    },
    async deleteMessages(peer, ids, options) {
      deleted.push({ peer, ids, options });
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 9, raw: source };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(artifact()({ ffmpeg: [helper], ffprobe: [helper] }));
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({
    id: 10,
    chatId: "-1009007199254740993",
    senderId: "7",
    outgoing: true,
    replyToId: 9,
    text: ".convert 新名称",
    raw: {},
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer.toString(), "-1009007199254740993");
  assert.equal(resolveId(sent[0].peer)[1], Api.PeerChannel);
  assert.ok(sent[0].options.attributes[0] instanceof Api.DocumentAttributeAudio);
  assert.equal(sent[0].options.attributes[0].duration, 12);
  assert.deepEqual(deleted[0].ids, [10]);
  const helperLog = await fs.readFile(log, "utf8");
  assert.match(helperLog, /-protocol_whitelist file,pipe/);
  assert.match(helperLog, /-fs 2147483648/);
  assert.match(helperLog, /mibot-convert-compat-[^|]+\/\.temp\/convert\/job-/);
  assert.doesNotMatch(edits.join("\n"), /转换失败/);
});

test("convert aborts an unknown-size download when cumulative progress exceeds the limit", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-convert-large-")));
  let native = 0;
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        assert.doesNotMatch(text, /Input too large/);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 9, raw: { media: {}, document: {} } };
      },
      async withClient(operation, signal) {
        native += 1;
        return operation(
          {
            async downloadMedia(_media, options) {
              options.progressCallback(2147483649n, 0n);
              throw new Error("must stop at progress");
            },
          },
          signal,
        );
      },
    },
  });
  await host.load(artifact()());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({
    id: 10,
    chatId: "7",
    senderId: "7",
    outgoing: true,
    replyToId: 9,
    text: ".convert",
    raw: {},
  });
  assert.equal(native, 1);
});

test("convert rejects oversized helper output even when a helper ignores ffmpeg -fs", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-convert-output-")));
  const helper = path.join(root, "oversized-helper");
  await fs.writeFile(helper, '#!/bin/sh\nfor last do :; done\n/usr/bin/truncate -s 2147483649 "$last"\n');
  await fs.chmod(helper, 0o700);
  let sends = 0;
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        assert.doesNotMatch(text, /Invalid output/);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 9, raw: { media: {}, document: { size: 5n } } };
      },
      async withClient(operation, signal) {
        return operation(
          {
            async downloadMedia(_media, options) {
              options.progressCallback(5n, 5n);
              await fs.writeFile(options.outputFile, "video");
            },
            async sendFile() {
              sends += 1;
            },
          },
          signal,
        );
      },
    },
  });
  await host.load(artifact()({ ffmpeg: [helper], ffprobe: [helper] }));
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({
    id: 10,
    chatId: "7",
    senderId: "7",
    outgoing: true,
    replyToId: 9,
    text: ".convert",
    raw: {},
  });
  assert.equal(sends, 0);
});

test("convert unload during ffprobe does not continue to Telegram upload", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-convert-cancel-")));
  const ffmpeg = path.join(root, "fake-ffmpeg");
  const ffprobe = path.join(root, "fake-ffprobe");
  const marker = path.join(root, "probe-started");
  await fs.writeFile(ffmpeg, '#!/bin/sh\nfor last do :; done\nprintf "mp3" > "$last"\n');
  await fs.writeFile(ffprobe, `#!/bin/sh\nprintf started > '${marker}'\nsleep 30\n`);
  await Promise.all([fs.chmod(ffmpeg, 0o700), fs.chmod(ffprobe, 0o700)]);
  let sends = 0,
    deletions = 0;
  const client = {
    async downloadMedia(_media, options) {
      await fs.writeFile(options.outputFile, "video");
    },
    async sendFile() {
      sends += 1;
    },
    async deleteMessages() {
      deletions += 1;
    },
  };
  const edits = [];
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 9, raw: { media: {}, document: { size: 5n } } };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(artifact()({ ffmpeg: [ffmpeg], ffprobe: [ffprobe] }));
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const dispatch = host.dispatchPrimary({
    id: 10,
    chatId: "7",
    senderId: "7",
    outgoing: true,
    replyToId: 9,
    text: ".convert",
    raw: {},
  });
  for (;;) {
    try {
      await fs.access(marker);
      break;
    } catch {
      await new Promise(setImmediate);
    }
  }
  assert.equal((await host.unload("convert", 2000)).completed, true);
  await dispatch;
  assert.equal(sends, 0);
  assert.equal(deletions, 0);
  assert.doesNotMatch(edits.join("\n"), /转换失败/);
});
