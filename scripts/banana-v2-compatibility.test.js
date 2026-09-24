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
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { resolveId } = require(path.join(core, "node_modules/teleproto/Utils.js"));

function bananaPlugin() {
  const { artifactDir } = buildPlugin({
    id: "banana",
    packageRoot: path.resolve(__dirname, "../banana"),
    entry: "v2.ts",
  });
  const entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}

test("banana preserves output media type and treats command deletion as best effort", async t => {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-banana-compat-")));
  const edits = [];
  const errors = [];
  const files = [];
  const deletions = [];
  const peer = "-1009007199254740993";
  const reply = { id: 77, raw: { media: { photo: {} } } };
  const client = {
    async *iterDownload() {
      yield Buffer.from("input-image");
    },
    async sendFile(target, options) {
      files.push({ target, options });
    },
    async deleteMessages(target, ids, options) {
      deletions.push({ target, ids, options });
      throw new Error("delete denied");
    },
  };
  const host = new PluginHost({
    storageRoot,
    logger: {
      info() {},
      error(event) {
        errors.push(event);
      },
    },
    http: { fetch: async () => new Response("", { status: 500 }) },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
        if (text.startsWith("<b>提示：</b>")) throw new Error("edit denied");
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return reply;
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  const ai = definePlugin({
    apiVersion: 2,
    id: "ai",
    description: "test image provider",
    commands: {},
    services: {
      image: {
        description: "image",
        async handle() {
          return [{ data: Buffer.from("jpeg-output"), mimeType: "image/jpeg", revisedPrompt: "更亮" }];
        },
      },
      selection: {
        description: "selection",
        async handle() {
          return { image: { tag: "test", model: "image" } };
        },
      },
    },
  });
  await host.load(ai);
  await host.load(bananaPlugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  await host.dispatchPrimary({
    id: 123,
    chatId: "-1009007199254740993",
    senderId: "42",
    outgoing: true,
    replyToId: 77,
    text: ".banana 调亮",
    raw: {},
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].target.toString(), peer);
  const [channelId, peerType] = resolveId(files[0].target);
  assert.equal(channelId.toString(), "9007199254740993");
  assert.equal(peerType, Api.PeerChannel);
  assert.match(files[0].options.file.name, /\.jpg$/);
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].target.toString(), peer);
  assert.deepEqual(deletions[0].ids, [123]);
  assert.deepEqual(deletions[0].options, { revoke: true });
  assert.doesNotMatch(edits.at(-1).text, /图片编辑失败/);
  assert.match(edits.at(-1).text, /提示.*调亮/s);
  assert.deepEqual(errors, ["banana_command_delete_failed", "banana_command_fallback_edit_failed"]);
});

test("banana stops native sends and skips deletion when cancelled during the first upload", async t => {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-banana-cancel-")));
  let uploadStarted;
  let releaseUpload;
  const started = new Promise(resolve => {
    uploadStarted = resolve;
  });
  const release = new Promise(resolve => {
    releaseUpload = resolve;
  });
  const sends = [];
  const deletions = [];
  const edits = [];
  const client = {
    async *iterDownload() {
      yield Buffer.from("input-image");
    },
    async sendFile(peer, options) {
      sends.push({ peer, options });
      uploadStarted();
      await release;
    },
    async deleteMessages(...args) {
      deletions.push(args);
    },
  };
  const host = new PluginHost({
    storageRoot,
    logger: { info() {}, error() {} },
    http: { fetch: async () => new Response("", { status: 500 }) },
    telegram: {
      async edit(_message, text) {
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 77, raw: { media: { photo: {} } } };
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(
    definePlugin({
      apiVersion: 2,
      id: "ai",
      description: "test image provider",
      commands: {},
      services: {
        image: {
          description: "image",
          async handle() {
            return [
              { data: Buffer.from("first"), mimeType: "image/png" },
              { data: Buffer.from("second"), mimeType: "image/png" },
            ];
          },
        },
      },
    }),
  );
  await host.load(bananaPlugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  const dispatch = host.dispatchPrimary({
    id: 124,
    chatId: "-1009007199254740993",
    senderId: "42",
    outgoing: true,
    replyToId: 77,
    text: ".banana 调亮",
    raw: { peerId: { channelId: 1 } },
  });
  await started;
  const unloading = host.unload("banana", 2000);
  releaseUpload();
  assert.equal((await unloading).completed, true);
  await dispatch;

  assert.equal(sends.length, 1);
  assert.equal(deletions.length, 0);
  assert.doesNotMatch(edits.join("\n"), /图片编辑失败/);
});
