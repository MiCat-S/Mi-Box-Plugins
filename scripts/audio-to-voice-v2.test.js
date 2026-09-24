"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api, utils } = require(path.join(core, "node_modules/teleproto"));
const { returnBigInt: integer } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "audio_to_voice",
  packageRoot: path.resolve(__dirname, "../audio_to_voice"),
  entry: "v2.ts",
});
const artifact = require(path.join(artifactDir, "index.cjs"));

function waveSample() {
  const samples = 800;
  const result = Buffer.alloc(44 + samples * 2);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8_000, 24);
  result.writeUInt32LE(16_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    result.writeInt16LE(Math.round(Math.sin(index / 8) * 4_000), 44 + index * 2);
  }
  return result;
}

function audioMessage({
  id = 50,
  mimeType = "application/octet-stream",
  duration = 7,
  voice,
  size = waveSample().length,
} = {}) {
  const attribute = new Api.DocumentAttributeAudio({ duration, ...(voice === undefined ? {} : { voice }) });
  const document = new Api.Document({
    id: integer(id),
    accessHash: integer(id + 1),
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType,
    size: integer(size),
    thumbs: [],
    videoThumbs: [],
    dcId: 1,
    attributes: [attribute],
  });
  return new Api.Message({
    id,
    peerId: new Api.PeerChannel({ channelId: integer("9007199254740993") }),
    date: 0,
    message: ".audio_to_voice",
    media: new Api.MessageMediaDocument({ document }),
  });
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-audio-to-voice-v2-")));
  const converter = path.join(root, "fake-ffmpeg");
  await fs.writeFile(converter, '#!/bin/sh\nfor output do :; done\nprintf "OggSfixture" > "$output"\n');
  await fs.chmod(converter, 0o700);
  const sample = options.sample ?? waveSample();
  const edits = [],
    sends = [],
    logs = [];
  let replyReads = 0;
  let deletes = 0;
  let downloads = 0;
  let resolverCalls = 0;
  let sentOutput;
  let client;
  const commandRaw = options.commandRaw ?? {
    peerId: new Api.PeerChannel({ channelId: integer("9007199254740993") }),
    async delete({ revoke }) {
      const request = new Api.messages.DeleteMessages({ id: [80], revoke });
      await request.resolve(client, utils);
      assert.ok(request.getBytes().length > 0);
      deletes++;
      if (options.deleteFailure) throw new Error("DELETE_DENIED_SECRET");
    },
  };
  const expectedSource = options.expectedSource ?? options.replyRaw ?? commandRaw;
  client = {
    async *iterDownload(media) {
      downloads++;
      assert.equal(media, expectedSource.media);
      if (options.downloadStarted) options.downloadStarted();
      if (options.downloadGate) await options.downloadGate;
      yield sample.subarray(0, 44);
      yield sample.subarray(44);
    },
    async sendFile(peer, sendOptions) {
      const output = await fs.readFile(sendOptions.file);
      assert.equal(output.subarray(0, 4).toString(), "OggS");
      const attribute = sendOptions.attributes[0];
      assert.ok(attribute instanceof Api.DocumentAttributeAudio);
      assert.ok(attribute.getBytes().length > 0);
      sentOutput = sendOptions.file;
      sends.push({ peer, options: sendOptions, attribute });
      if (options.sendFailure) throw new Error("SEND_FILE_SECRET");
      return { id: 100 };
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    tempRoot: path.join(root, "temp"),
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024 },
    logger: {
      info(event) {
        logs.push(event);
      },
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
      async invoke() {
        assert.fail("unexpected generic invoke");
      },
      async getReply() {
        replyReads++;
        return options.replyRaw ? { raw: options.replyRaw } : undefined;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  const definition = artifact.default({
    resolveFfmpeg: async () => {
      resolverCalls++;
      return converter;
    },
  });
  await host.load(definition);
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  const run = (message = {}) =>
    host.dispatchPrimary({
      id: 80,
      chatId: "-1009007199254740993",
      senderId: "1",
      outgoing: true,
      text: ".audio_to_voice",
      raw: commandRaw,
      ...message,
    });
  return {
    root,
    host,
    edits,
    sends,
    logs,
    commandRaw,
    run,
    replyReads: () => replyReads,
    deletes: () => deletes,
    downloads: () => downloads,
    resolverCalls: () => resolverCalls,
    sentOutput: () => sentOutput,
  };
}

test("audio_to_voice keeps the original missing-audio prompt instead of treating empty invocation as help", async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.edits.at(-1).text, "请回复一个音乐文件");
  assert.equal(f.sends.length, 0);
});

test("audio_to_voice explicit help stays local without media or process access", async t => {
  const f = await fixture(t);
  await f.run({ text: ".audio_to_voice h" });
  assert.match(f.edits.at(-1).text, /音频转语音/);
  assert.equal(f.replyReads(), 0);
  assert.equal(f.resolverCalls(), 0);
  assert.equal(f.downloads(), 0);
});

test("audio_to_voice converts a real PCM sample from an actual replied Telegram document", async t => {
  const source = audioMessage();
  const f = await fixture(t, { replyRaw: source, expectedSource: source });
  await f.run({ replyToId: source.id });

  assert.equal(f.sends.length, 1, JSON.stringify({ edits: f.edits, logs: f.logs }));
  assert.equal(f.sends[0].peer.channelId.toString(), "9007199254740993");
  assert.equal(f.sends[0].options.replyTo, source.id);
  assert.equal(f.sends[0].options.voiceNote, true);
  assert.equal(f.sends[0].options.forceDocument, false);
  assert.equal(f.sends[0].attribute.duration, 7);
  assert.equal(f.sends[0].attribute.voice, true);
  assert.equal(f.sends[0].attribute.waveform.length, 0);
  assert.equal(f.deletes(), 1);
  await assert.rejects(fs.stat(f.sentOutput()), { code: "ENOENT" });
});

test("audio_to_voice falls back to audio on the command message and clears its caption after sending", async t => {
  const source = audioMessage({ id: 80 });
  const invalidReply = new Api.Message({ id: 70, peerId: source.peerId, date: 0, message: "not audio" });
  const f = await fixture(t, { commandRaw: source, replyRaw: invalidReply, expectedSource: source });
  await f.run({ replyToId: invalidReply.id });

  assert.equal(f.replyReads(), 1);
  assert.equal(f.sends.length, 1, JSON.stringify({ edits: f.edits, logs: f.logs }));
  assert.equal(f.sends[0].options.replyTo, 80);
  assert.equal(f.edits.at(-1).text, "");
  assert.equal(f.deletes(), 0);
});

test("audio_to_voice treats command deletion as best-effort after a successful upload", async t => {
  const source = audioMessage({ mimeType: "audio/wav", voice: false });
  const f = await fixture(t, { replyRaw: source, expectedSource: source, deleteFailure: true });
  await f.run({ replyToId: source.id });

  assert.equal(f.sends.length, 1, JSON.stringify({ edits: f.edits, logs: f.logs }));
  assert.equal(f.deletes(), 1);
  assert.ok(f.logs.includes("audio_to_voice_receipt_cleanup_failed"));
  assert.equal(
    f.edits.some(({ text }) => /音频转换失败/.test(text)),
    false,
  );
});

test("audio_to_voice rejects an oversized declared document before FFmpeg or download", async t => {
  const source = audioMessage({ mimeType: "audio/wav", size: 50 * 1024 * 1024 + 1 });
  const f = await fixture(t, { replyRaw: source, expectedSource: source });
  await f.run({ replyToId: source.id });

  assert.equal(f.resolverCalls(), 0);
  assert.equal(f.downloads(), 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.edits.at(-1).text, "音频转换失败，请确认回复的是音频且服务器已安装 FFmpeg");
});

test("audio_to_voice unload during download starts no process or late Telegram send", async t => {
  let entered;
  const downloadStarted = new Promise(resolve => {
    entered = resolve;
  });
  let release;
  const downloadGate = new Promise(resolve => {
    release = resolve;
  });
  const source = audioMessage({ mimeType: "audio/wav" });
  const f = await fixture(t, { replyRaw: source, expectedSource: source, downloadStarted: entered, downloadGate });
  const running = f.run({ replyToId: source.id });
  await downloadStarted;
  const unloading = f.host.unload("audio_to_voice", 2000);
  release();
  const [dispatchResult, unloadResult] = await Promise.allSettled([running, unloading]);

  assert.ok(["fulfilled", "rejected"].includes(dispatchResult.status));
  assert.equal(unloadResult.status, "fulfilled");
  assert.equal(unloadResult.value.completed, true);
  assert.equal(f.resolverCalls(), 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(
    f.edits.map(({ text }) => text),
    ["正在转换音频…"],
  );
});

test("audio_to_voice keeps upload failures fixed and removes temporary output", async t => {
  const source = audioMessage({ mimeType: "audio/wav" });
  const f = await fixture(t, { replyRaw: source, expectedSource: source, sendFailure: true });
  await f.run({ replyToId: source.id });

  assert.equal(f.sends.length, 1);
  assert.equal(f.deletes(), 0);
  assert.ok(f.logs.includes("audio_to_voice_failed"));
  assert.equal(f.edits.at(-1).text, "音频转换失败，请确认回复的是音频且服务器已安装 FFmpeg");
  assert.doesNotMatch(JSON.stringify(f.edits), /SEND_FILE_SECRET/);
  await assert.rejects(fs.stat(f.sentOutput()), { code: "ENOENT" });
});

test("audio_to_voice streams a real PCM sample exactly and enforces the input byte ceiling", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-audio-input-v2-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sample = waveSample();
  const output = path.join(root, "input-audio");
  const client = {
    async *iterDownload() {
      yield sample.subarray(0, 44);
      yield sample.subarray(44);
    },
  };
  await artifact.downloadBounded(client, {}, output, new AbortController().signal, sample.length);
  assert.deepEqual(await fs.readFile(output), sample);

  const limited = path.join(root, "limited-audio");
  await assert.rejects(artifact.downloadBounded(client, {}, limited, new AbortController().signal, 44), /too large/);
  assert.equal((await fs.stat(limited)).size, 44);
});

test("audio_to_voice cancellation during a write prevents the next simulated GetFile request", async t => {
  const controller = new AbortController();
  let writes = 0;
  let closes = 0;
  let nextCalls = 0;
  let getFileCalls = 0;
  let returns = 0;
  let receivedSignal;
  t.mock.method(fs, "open", async () => ({
    async write(chunk, _offset, length) {
      writes++;
      controller.abort();
      return { bytesWritten: length, buffer: chunk };
    },
    async close() {
      closes++;
    },
  }));
  const client = {
    iterDownload(_media, params) {
      receivedSignal = params.signal;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          nextCalls++;
          if (params.signal?.aborted) throw new Error("MEDIA_ABORTED_BEFORE_GET_FILE");
          getFileCalls++;
          return getFileCalls === 1 ? { done: false, value: Buffer.alloc(4096) } : { done: true };
        },
        async return() {
          returns++;
          return { done: true };
        },
      };
    },
  };

  await assert.rejects(artifact.downloadBounded(client, {}, "/unused", controller.signal), { name: "AbortError" });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(writes, 1);
  assert.equal(nextCalls, 1);
  assert.equal(getFileCalls, 1);
  assert.equal(returns, 1);
  assert.equal(closes, 1);
});

test("audio_to_voice retains the hardened FFmpeg argv", () => {
  assert.deepEqual(artifact.ffmpegArguments("/tmp/input", "/tmp/output.ogg"), [
    "-nostdin",
    "-y",
    "-i",
    "/tmp/input",
    "-vn",
    "-acodec",
    "libopus",
    "-b:a",
    "64k",
    "-ar",
    "48000",
    "-ac",
    "1",
    "/tmp/output.ogg",
  ]);
});
