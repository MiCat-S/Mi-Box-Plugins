"use strict";
// Behavioral compatibility tests for the two aban V2 parity fixes:
//   1) `.aban` help must reuse the original managed 10s cleanup.
//   2) A failed status/result edit must not block the business action, while
//      cancellation must still propagate instead of being swallowed.
// The tests use the real factory / PluginHost and a simulated Telegram client.
// They never delete real messages or restrict real users.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
const timers = require("node:timers/promises");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildSync } = require(path.join(core, "node_modules/esbuild"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { Api } = require(path.join(core, "node_modules/teleproto"));
const { returnBigInt: integer } = require(path.join(core, "node_modules/teleproto/Helpers.js"));

let root, factory, createRuntime;

test.before(async () => {
  root = await fs.mkdtemp(path.join(core, "temp/aban-compat-"));
  const built = buildPlugin({
    id: "aban",
    packageRoot: path.resolve(__dirname, "../aban"),
    entry: "v2.ts",
    rootDir: core,
  });
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
  // Build the runtime seam with the same bundler configuration as the plugin build.
  buildSync({
    entryPoints: [path.resolve(__dirname, "../aban/v2/runtime.ts")],
    outfile: path.join(root, "runtime.cjs"),
    bundle: true,
    platform: "node",
    packages: "external",
  });
  createRuntime = require(path.join(root, "runtime.cjs")).createAbanRuntime;
});
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const user = (id = 2) =>
  new Api.User({ id: integer(id), accessHash: integer(30), firstName: "Target", lastName: "User", username: "target" });
const input = (id = 2) => new Api.InputPeerUser({ userId: integer(id), accessHash: integer(30) });
const message = (text = ".ban 2") => ({
  id: 9,
  message: text,
  isGroup: true,
  isChannel: true,
  peerId: new Api.PeerChannel({ channelId: integer(100) }),
  className: "Message",
});

// Runtime seam context: captures edits, logs, managed tasks and native deletes.
function runtimeEnv(options = {}) {
  const controller = new AbortController();
  const edits = [],
    logs = [],
    deletes = [],
    tasks = [],
    invokes = [];
  const client = {
    getMe: async () => user(1),
    getEntity: async value => user(Number(value) || 2),
    getInputEntity: async value => input(Number(value?.id ?? value) || 2),
    getDialogs: async () => [],
    invoke: async request => {
      invokes.push(request);
      if (request instanceof Api.channels.GetParticipant) {
        const self = request.participant instanceof Api.InputPeerSelf;
        return {
          participant: self
            ? new Api.ChannelParticipantCreator({ userId: integer(1) })
            : new Api.ChannelParticipant({ userId: integer(2) }),
          users: [user()],
        };
      }
      if (request instanceof Api.messages.GetFullChat) {
        return {
          fullChat: { participants: { participants: [new Api.ChatParticipantCreator({ userId: integer(1) })] } },
          users: [user()],
        };
      }
      return { offset: 0 };
    },
    deleteMessages: async (...args) => {
      deletes.push(args);
    },
  };
  const ctx = {
    signal: controller.signal,
    log: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    tasks: {
      run: (name, fn) => {
        const record = { name };
        const promise = controller.signal.aborted
          ? Promise.reject(controller.signal.reason)
          : Promise.resolve().then(() => fn(controller.signal));
        record.promise = promise;
        tasks.push(record);
        return promise;
      },
    },
    storage: { json: () => ({ read: async () => ({ cache: {} }), update: async mutator => mutator({ cache: {} }) }) },
    telegram: {
      edit: async (_message, text) => {
        options.onEdit?.(text, controller);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (options.editError) throw options.editError;
        edits.push(text);
      },
      reply: async () => {},
      invoke: async () => {},
      getReply: async () => undefined,
      withClient: async operation => {
        controller.signal.throwIfAborted();
        return operation(client, controller.signal);
      },
    },
  };
  return { client, ctx, controller, edits, logs, deletes, tasks, invokes };
}

// Replace node:timers/promises.setTimeout with an immediate, signal-aware probe
// so the managed delay is observable without waiting ten real seconds.
async function withTimerProbe(run) {
  const original = timers.setTimeout;
  const delays = [];
  timers.setTimeout = (ms, value, options = {}) => {
    delays.push(ms);
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      setImmediate(() => resolve(value));
    });
  };
  try {
    return await run(delays);
  } finally {
    timers.setTimeout = original;
  }
}

const helpInvocation = () => ({
  message: { id: 9, chatId: "-100100", text: ".aban", outgoing: true },
  command: "aban",
  prefix: ".",
  args: [],
});

test(".aban schedules the original managed ten-second cleanup and deletes afterwards", async () => {
  const plugin = factory(),
    env = runtimeEnv();
  await withTimerProbe(async delays => {
    await plugin.commands.aban.handle(helpInvocation(), env.ctx);
    assert.deepEqual(
      env.tasks.map(task => task.name),
      ["aban:delete-result"],
    );
    await Promise.all(env.tasks.map(task => task.promise));
    assert.deepEqual(delays, [10000]);
  });
  assert.equal(env.edits.length, 1);
  assert.match(env.edits[0], /<b>封禁管理<\/b>/);
  assert.equal(env.deletes.length, 1);
  const [peer, ids, options] = env.deletes[0];
  assert.equal(peer.className, "PeerChannel");
  assert.equal(String(peer.channelId), "100");
  assert.deepEqual(ids, [9]);
  assert.deepEqual(options, { revoke: true });
});

test("unloading before the managed cleanup elapses does not delete the help message", async t => {
  const dir = await fs.mkdtemp(path.join(root, "help-unload-"));
  const edits = [],
    deletes = [];
  const client = {
    deleteMessages: async (...args) => {
      deletes.push(args);
    },
  };
  const host = new PluginHost({
    storageRoot: dir,
    logger: { info() {}, error() {} },
    telegram: {
      edit: async (_message, text, _options, signal) => {
        signal.throwIfAborted();
        edits.push(text);
      },
      reply: async () => {},
      getReply: async () => undefined,
      invoke: async () => {},
      withClient: async (operation, signal) => operation(client, signal),
    },
  });
  await host.load(factory());
  t.after(async () => {
    await host.shutdown(1000);
  });
  assert.equal(
    await host.dispatchPrimary({ id: 9, chatId: "-100100", senderId: "1", text: ".aban", outgoing: true }),
    true,
  );
  assert.equal(edits.length, 1);
  assert.equal(deletes.length, 0);
  const report = await host.unload("aban", 1000);
  assert.equal(report.completed, true);
  assert.equal(deletes.length, 0);
});

test("cancelling the plugin scope before the cleanup delay does not delete", async () => {
  const plugin = factory(),
    env = runtimeEnv();
  await plugin.commands.aban.handle(helpInvocation(), env.ctx);
  assert.deepEqual(
    env.tasks.map(task => task.name),
    ["aban:delete-result"],
  );
  env.controller.abort();
  await Promise.allSettled(env.tasks.map(task => task.promise));
  assert.equal(env.deletes.length, 0);
});

test("a failed status edit still runs the business action", async () => {
  const failure = Object.assign(new Error("message is not modified"), { name: "RpcError" });
  const env = runtimeEnv({ editError: failure });
  const runtime = await createRuntime(env.ctx, { message: {}, args: [], command: "kick" });
  await runtime.CommandHandlers.handleBasicCommand(env.client, message(), "kick");
  assert.ok(
    env.invokes.some(request => request instanceof Api.channels.EditBanned),
    "kick RPC must still run",
  );
  assert.ok(env.logs.some(entry => entry.level === "error" && entry.event === "aban:edit-failed"));
  assert.equal(env.tasks.filter(task => task.name === "aban:delete-result").length, 0);
  assert.equal(env.edits.length, 0);
});

test("a failed result edit does not change the completed business outcome", async () => {
  const failure = Object.assign(new Error("message is not modified"), { name: "RpcError" });
  let calls = 0;
  const env = runtimeEnv({
    onEdit: () => {
      calls += 1;
      if (calls === 2) throw failure;
    },
  });
  const runtime = await createRuntime(env.ctx, { message: {}, args: [], command: "ban" });
  await runtime.CommandHandlers.handleBasicCommand(env.client, message(), "ban");
  assert.equal(env.edits.length, 1, "only the status edit succeeded");
  assert.ok(env.invokes.some(request => request instanceof Api.channels.EditBanned));
  assert.ok(env.invokes.some(request => request instanceof Api.channels.DeleteParticipantHistory));
  assert.ok(env.logs.some(entry => entry.level === "error" && entry.event === "aban:edit-failed"));
  assert.ok(!env.edits.some(text => text.includes("操作失败")));
});

test("cancellation during the status edit stops before the next RPC", async () => {
  const plugin = factory(),
    env = runtimeEnv({ onEdit: (_text, controller) => controller.abort() });
  const invocation = {
    message: { id: 9, chatId: "-100100", text: ".ban 2", outgoing: true },
    command: "ban",
    prefix: ".",
    args: ["2"],
  };
  await assert.rejects(plugin.commands.ban.handle(invocation, env.ctx), error => error?.name === "AbortError");
  assert.equal(env.invokes.filter(request => request instanceof Api.channels.EditBanned).length, 0);
  assert.equal(env.invokes.filter(request => request instanceof Api.channels.DeleteParticipantHistory).length, 0);
});

test("smartEdit propagates cancellation instead of swallowing the abort", async () => {
  const env = runtimeEnv();
  env.controller.abort();
  const runtime = await createRuntime(env.ctx, { message: {}, args: [], command: "ban" });
  await assert.rejects(runtime.MessageManager.smartEdit(message(), "x"), error => error?.name === "AbortError");
  assert.equal(env.edits.length, 0);
});
