"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { Api, utils } = require(path.join(core, "node_modules/teleproto"));
const { downloadFile } = require(path.join(core, "node_modules/teleproto/client/downloads"));
const { MediaAbortError } = require(path.join(core, "node_modules/teleproto/network/MediaScheduler"));
const built = buildPlugin({
  id: "getstickers",
  packageRoot: path.resolve(__dirname, "../getstickers"),
  entry: "v2.ts",
});
const createGetStickers = require(path.join(built.artifactDir, "index.cjs")).default;
const MAX_ITEM = 20 * 1024 * 1024;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

function document(size = 4, { id = 1n, accessHash = 2n, mimeType = "image/webp", stickerSet } = {}) {
  return Object.assign(Object.create(Api.Document.prototype), {
    id,
    accessHash,
    fileReference: Buffer.from("ref"),
    mimeType,
    size,
    attributes: [
      Object.assign(Object.create(Api.DocumentAttributeSticker.prototype), {
        alt: "😀",
        stickerset: stickerSet || new Api.InputStickerSetShortName({ shortName: "local_pack" }),
      }),
    ],
  });
}

function zipFiles(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, "ZIP end record");
  const files = new Map();
  let central = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index++) {
    assert.equal(buffer.readUInt32LE(central), 0x02014b50);
    const method = buffer.readUInt16LE(central + 10),
      length = buffer.readUInt32LE(central + 20);
    const nameLength = buffer.readUInt16LE(central + 28),
      extraLength = buffer.readUInt16LE(central + 30);
    const commentLength = buffer.readUInt16LE(central + 32),
      local = buffer.readUInt32LE(central + 42);
    const name = buffer.subarray(central + 46, central + 46 + nameLength).toString();
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const bytes = buffer.subarray(start, start + length);
    files.set(
      name,
      method === 0 ? Buffer.from(bytes) : method === 8 ? inflateRawSync(bytes) : assert.fail("ZIP compression"),
    );
    central += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telebox-getstickers-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController(),
    edits = [],
    logs = [],
    sent = [],
    conversions = [],
    requests = [],
    locations = [],
    peers = [];
  const doc = options.document || document();
  const documents = options.documents || [doc];
  let downloads = 0;
  const client = {
    async invoke(request) {
      requests.push(request);
      await request.resolve(client, utils);
      assert.ok(request.getBytes().length > 0);
      if (options.invoke) return options.invoke(request, controller);
      return (
        options.result || {
          set: { shortName: "local_pack" },
          documents,
          packs: [{ emoticon: "😀", documents: documents.map(item => item.id) }],
        }
      );
    },
    async downloadFile(location, settings) {
      downloads += 1;
      locations.push(location);
      assert.ok(location.getBytes().length > 0);
      if (options.download) return options.download(location, settings, controller);
      await fs.writeFile(settings.outputFile, options.downloadBytes || "RIFF");
    },
    async sendFile(peer, settings) {
      peers.push(peer);
      if (options.send) return options.send(settings);
      sent.push(await fs.readFile(settings.file));
    },
  };
  const context = {
    signal: controller.signal,
    log: {
      info(event) {
        logs.push(event);
      },
      error(event) {
        logs.push(event);
      },
    },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async getReply() {
        return { raw: { document: doc } };
      },
      async withClient(operation) {
        return operation(client, controller.signal);
      },
    },
    files: {
      async withTemp(operation) {
        const directory = await fs.mkdtemp(path.join(root, "job-"));
        try {
          return await operation(directory, controller.signal);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    },
    processes: {
      async run(_command, args) {
        conversions.push(args);
        if (options.convert) return options.convert(args);
        await fs.writeFile(args.at(-1), "GIF89a");
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    },
  };
  let deleted = 0;
  return {
    root,
    controller,
    edits,
    logs,
    sent,
    conversions,
    requests,
    locations,
    peers,
    get downloads() {
      return downloads;
    },
    get deleted() {
      return deleted;
    },
    run() {
      return createGetStickers().commands.getstickers.handle(
        {
          command: "getstickers",
          prefix: ".",
          args: [],
          message: {
            id: 1,
            chatId: "1",
            text: ".getstickers",
            outgoing: true,
            replyToId: 3,
            raw: {
              peerId: options.rawPeer === undefined ? "peer" : options.rawPeer,
              async delete() {
                deleted++;
                if (options.deleteFailure) throw new Error("delete failed");
              },
            },
          },
        },
        context,
      );
    },
  };
}

function transport(getFile) {
  return { session: { dcId: 1 }, _media: { opts: { partSize: 1024 * 1024 }, getFile } };
}

test("failed conversion packages the original sticker and its matching manifest entry", async t => {
  const f = await fixture(t, {
    convert: async args => {
      await fs.writeFile(args.at(-1), "partial private-converter-output");
      throw Object.assign(new Error("private-converter-error"), { code: "EXIT_NONZERO" });
    },
  });
  await f.run();
  assert.equal(f.sent.length, 1);
  const files = zipFiles(f.sent[0]);
  assert.deepEqual([...files.keys()].sort(), ["000.webp", "pack.txt"]);
  assert.equal(files.get("000.webp").toString(), "RIFF");
  assert.deepEqual(JSON.parse(files.get("pack.txt").toString()), { image_file: "000.webp", emojis: "😀" });
  assert.doesNotMatch(JSON.stringify({ edits: f.edits, logs: f.logs }), /private-converter/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("large sticker-set and document ids retain precision and serialize through Teleproto", async t => {
  const setId = "9007199254741999",
    setHash = "-9007199254742999";
  const docId = "9007199254743999",
    docHash = "-9007199254744999";
  const doc = document(4, { id: docId, accessHash: docHash, stickerSet: { id: setId, access_hash: setHash } });
  const f = await fixture(t, { document: doc });
  await f.run();
  const input = f.requests[0].stickerset;
  assert.ok(input instanceof Api.InputStickerSetID);
  assert.equal(String(input.id), setId);
  assert.equal(String(input.accessHash), setHash);
  assert.ok(f.locations[0] instanceof Api.InputDocumentFileLocation);
  assert.equal(String(f.locations[0].id), docId);
  assert.equal(String(f.locations[0].accessHash), docHash);
  assert.equal(f.sent.length, 1);
});

test("missing raw peer falls back to the precise envelope chat id", async t => {
  const f = await fixture(t, { rawPeer: null });
  await f.run();
  assert.equal(String(f.peers[0]), "1");
  assert.equal(f.sent.length, 1);
});

test("cancellation while GetStickerSet is in flight prevents every download and failure notice", async t => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, {
    invoke: async () => {
      entered.resolve();
      await release.promise;
      return { set: { shortName: "local_pack" }, documents: [document()], packs: [] };
    },
  });
  const running = f.run();
  await entered.promise;
  f.controller.abort(new Error("cancel query"));
  release.resolve();
  await running;
  assert.equal(f.downloads, 0);
  assert.equal(f.logs.includes("getstickers_failed"), false);
  assert.doesNotMatch(f.edits.join("\n"), /下载失败/);
});

test("all original sticker formats select the matching converter and archive gif output", async t => {
  const formats = [
    ["image/webp", "webp"],
    ["application/x-tgsticker", "tgs"],
    ["video/webm", "mp4"],
  ];
  for (const [mimeType, extension] of formats) {
    const doc = document(4, { mimeType });
    const f = await fixture(t, { document: doc });
    await f.run();
    assert.ok(f.conversions[0].some(argument => String(argument).endsWith(`.${extension}`)));
    assert.deepEqual([...zipFiles(f.sent[0]).keys()].sort(), ["000.gif", "pack.txt"]);
  }
});

test("a short download is rejected before conversion or archive delivery", async t => {
  const f = await fixture(t, { document: document(8), downloadBytes: "RIFF" });
  await f.run();
  assert.equal(f.conversions.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted, 0);
  assert.match(f.edits.at(-1), /下载失败/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("upload owns the archive until settlement and only successful delivery deletes the command", async t => {
  let archive;
  const success = await fixture(t, {
    send: async settings => {
      archive = settings.file;
      assert.equal((await fs.stat(settings.file)).isFile(), true);
    },
  });
  await success.run();
  assert.equal(success.deleted, 1);
  await assert.rejects(fs.stat(archive), { code: "ENOENT" });
  const failed = await fixture(t, {
    send: async settings => {
      assert.equal((await fs.stat(settings.file)).isFile(), true);
      throw new Error("upload failed");
    },
  });
  await failed.run();
  assert.equal(failed.deleted, 0);
  assert.match(failed.edits.at(-1), /下载失败/);
  assert.deepEqual(await fs.readdir(failed.root), []);
});

test("upload cancellation prevents command deletion and emits no failure notice", async t => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, {
    send: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const running = f.run();
  await entered.promise;
  f.controller.abort(new Error("cancel upload"));
  release.resolve();
  await running;
  assert.equal(f.deleted, 0);
  assert.equal(f.logs.includes("getstickers_failed"), false);
  assert.doesNotMatch(f.edits.join("\n"), /下载失败/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("successful upload with command cleanup failure remains successful and logs a fixed event", async t => {
  const f = await fixture(t, { deleteFailure: true });
  await f.run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.deleted, 1);
  assert.equal(f.logs.includes("getstickers_command_cleanup_failed"), true);
  assert.equal(f.logs.includes("getstickers_failed"), false);
  assert.doesNotMatch(f.edits.join("\n"), /下载失败/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("announced oversized stickers are rejected before starting their download", async t => {
  const f = await fixture(t, { document: document(MAX_ITEM + 1) });
  await f.run();
  assert.equal(f.downloads, 0);
  assert.equal(f.conversions.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /下载失败/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("actual Teleproto download stops at the first chunk exceeding the sticker limit", async t => {
  let chunks = 0;
  const remote = transport(async () => (++chunks <= 25 ? Buffer.alloc(1024 * 1024, 1) : Buffer.alloc(0)));
  const f = await fixture(t, { download: (location, settings) => downloadFile(remote, location, settings) });
  await f.run();
  assert.equal(chunks, 21, "20 MiB plus the first excess 1 MiB transport chunk");
  assert.equal(f.conversions.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /下载失败/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("a sticker exactly at the size limit downloads, converts and produces a valid archive", async t => {
  let chunks = 0;
  const remote = transport(async () => (++chunks <= 20 ? Buffer.alloc(1024 * 1024, 1) : Buffer.alloc(0)));
  const f = await fixture(t, {
    document: document(MAX_ITEM),
    download: (location, settings) => downloadFile(remote, location, settings),
  });
  await f.run();
  assert.equal(chunks, 21);
  assert.equal(f.conversions.length, 1);
  assert.equal(f.sent.length, 1);
  const files = zipFiles(f.sent[0]);
  assert.deepEqual([...files.keys()].sort(), ["000.gif", "pack.txt"]);
  assert.equal(files.get("000.gif").toString(), "GIF89a");
  assert.deepEqual(JSON.parse(files.get("pack.txt").toString()), { image_file: "000.gif", emojis: "😀" });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("cancelling an active Teleproto download stops the transport before temp cleanup", async t => {
  let started,
    release,
    cancelled = false;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const remote = transport(async (_dc, _location, _offset, _size, signal) => {
    started();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cancelled = true;
        signal.removeEventListener("abort", onAbort);
        reject(new MediaAbortError());
      };
      release = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(Buffer.alloc(0));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  const f = await fixture(t, { download: (location, settings) => downloadFile(remote, location, settings) });
  const running = f.run();
  await ready;
  f.controller.abort(new Error("cancelled by test"));
  let watchdog;
  try {
    const completed = await Promise.race([
      running.then(() => true),
      new Promise(resolve => {
        watchdog = setTimeout(() => resolve(false), 300);
      }),
    ]);
    assert.equal(completed, true, "download must settle when the plugin is cancelled");
    assert.equal(cancelled, true);
    assert.equal(f.conversions.length, 0);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    clearTimeout(watchdog);
    release();
    await running;
  }
});

test("download completion racing with cancellation does not start a converter", async t => {
  const f = await fixture(t, {
    download: async (_location, settings, controller) => {
      await fs.writeFile(settings.outputFile, "RIFF");
      controller.abort(new Error("cancelled after download"));
    },
  });
  await f.run();
  assert.equal(f.conversions.length, 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("cancelling an active converter waits for process settlement before temp cleanup", async t => {
  let started, release;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, {
    convert: async () => {
      started();
      await new Promise((resolve, reject) => {
        release = resolve;
        f.controller.signal.addEventListener("abort", () => reject(f.controller.signal.reason), { once: true });
      });
    },
  });
  const running = f.run();
  await ready;
  f.controller.abort(new Error("cancel converter"));
  await running;
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
  release();
});

test("PluginHost unload cancels a pending download and settles its temporary file scope", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-getstickers-unload-")));
  let started,
    release = () => {},
    cancelled = false;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const remote = transport(async (_dc, _location, _offset, _size, signal) => {
    started();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cancelled = true;
        reject(new MediaAbortError());
      };
      release = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(Buffer.alloc(0));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  const doc = document();
  const client = {
    async invoke() {
      return { set: { shortName: "local_pack" }, documents: [doc], packs: [] };
    },
    downloadFile(location, settings) {
      return downloadFile(remote, location, settings);
    },
    async sendFile() {
      assert.fail("cancelled download must not send an archive");
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024 },
    logger: { info() {}, error() {} },
    telegram: {
      async edit() {},
      async reply() {},
      async invoke() {},
      async getReply() {
        return { raw: { document: doc } };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.load(createGetStickers());
  const running = host
    .dispatchPrimary({
      id: 1,
      chatId: "1",
      senderId: "1",
      outgoing: true,
      text: ".getstickers",
      replyToId: 3,
      raw: { peerId: "peer" },
    })
    .catch(error => error);
  try {
    assert.equal(await Promise.race([ready.then(() => true), running.then(() => false)]), true);
    assert.equal((await host.unload("getstickers", 1000)).completed, true);
    await running;
    assert.equal(cancelled, true);
    assert.equal(host.snapshot().plugins, 0);
    assert.deepEqual(await fs.readdir(path.join(root, ".temp/getstickers")), []);
  } finally {
    release();
    await running;
  }
});
