"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const sharp = require(path.join(core, "node_modules/sharp"));
const { artifactDir } = buildPlugin({
  id: "yvlu-media-test",
  packageRoot: path.resolve(__dirname, "../yvlu"),
  entry: "v2/media.ts",
});
const { generateQuote, downloadMediaBuffer, convertVideo } = require(path.join(artifactDir, "index.cjs"));

function quoteContext(buffer) {
  const signal = new AbortController().signal;
  return {
    signal,
    http: {
      async withResponse(_url, _init, use) {
        return use(new Response(buffer, { status: 200, headers: { "content-type": "image/png" } }), signal);
      },
    },
  };
}

test("quote output accepts a real local PNG within the pixel budget", async () => {
  const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#123456" } })
    .png()
    .toBuffer();
  const result = await generateQuote(quoteContext(png), {});
  assert.equal(result.ext, "png");
  assert.deepEqual(result.buffer, png);
});

test("quote output rejects a compressed image above the decoded pixel budget", async () => {
  const png = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
  await assert.rejects(generateQuote(quoteContext(png), {}), /pixel|limit|尺寸/i);
});

test("native media buffers are rejected before retaining more than 20 MiB", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yvlu-media-"));
  const signal = new AbortController().signal;
  const context = {
    signal,
    files: {
      async withTemp(use) {
        return use(directory, signal);
      },
    },
    telegram: {
      async withClient(operation) {
        return operation(
          {
            async downloadMedia() {
              return Buffer.alloc(20 * 1024 * 1024 + 1);
            },
          },
          signal,
        );
      },
    },
  };
  await assert.rejects(downloadMediaBuffer(context, {}), /20 MiB/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("abort actively cancels a hanging quote response reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const context = {
    signal: controller.signal,
    http: {
      async withResponse(_url, _init, use) {
        return use(new Response(stream, { status: 200, headers: { "content-type": "image/png" } }), controller.signal);
      },
    },
  };
  const running = generateQuote(context, {});
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("abort is passed into a hanging native media download", async () => {
  const controller = new AbortController(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "yvlu-abort-"));
  let received;
  const context = {
    signal: controller.signal,
    files: {
      async withTemp(use) {
        return use(directory, controller.signal);
      },
    },
    telegram: {
      async withClient(operation) {
        return operation(
          {
            downloadMedia(_target, options) {
              received = options.signal;
              return new Promise((_resolve, reject) =>
                options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
              );
            },
          },
          controller.signal,
        );
      },
    },
  };
  const running = downloadMediaBuffer(context, {});
  while (!received) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(received, controller.signal);
  await fs.rm(directory, { recursive: true, force: true });
});

test("ffmpeg sparse output above the limit is rejected after stat and before read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yvlu-convert-")),
    executable = path.join(directory, "ffmpeg");
  await fs.writeFile(executable, "#!/bin/sh\n");
  await fs.chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = directory;
  const signal = new AbortController().signal;
  const context = {
    signal,
    files: {
      async withTemp(use) {
        return use(directory, signal);
      },
    },
    processes: {
      async run(_file, args) {
        const output = args.at(-1);
        const handle = await fs.open(output, "w");
        await handle.truncate(20 * 1024 * 1024 + 1);
        await handle.close();
      },
    },
  };
  try {
    await assert.rejects(convertVideo(context, Buffer.from("input"), false), /20 MiB/);
  } finally {
    process.env.PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
