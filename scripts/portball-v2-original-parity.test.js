"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs/promises");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js")),
  { Api } = require(path.join(core, "node_modules/teleproto")),
  { returnBigInt } = require(path.join(core, "node_modules/teleproto/Helpers.js"));
let create;
test.before(() => {
  const b = buildPlugin({
    id: "portball",
    packageRoot: process.env.PORTBALL_PACKAGE_ROOT || path.resolve(__dirname, "../portball"),
    entry: "v2.ts",
    rootDir: core,
  });
  create = require(path.join(b.artifactDir, b.manifest.entry)).default;
});
function fixture(opt = {}) {
  const controller = new AbortController(),
    edits = [],
    sent = [],
    logs = [],
    invoked = [];
  const chat = new Api.Channel({ id: returnBigInt("100"), accessHash: returnBigInt("1"), title: "group" }),
    target = new Api.User({ id: returnBigInt("200"), accessHash: returnBigInt("2"), firstName: "A<&", lastName: "B" }),
    me = new Api.User({ id: returnBigInt("1"), self: true });
  const raw = {
    peerId: new Api.PeerChannel({ channelId: returnBigInt("100") }),
    async delete() {
      if (opt.deleteError) throw new Error("PRIVATE_DELETE");
    },
  };
  const client = {
    async getEntity(value) {
      return String(value) === "200" ? target : chat;
    },
    async getMe() {
      return me;
    },
    async getInputEntity() {
      return new Api.InputPeerUser({ userId: target.id, accessHash: target.accessHash });
    },
    async invoke(request) {
      invoked.push(request);
      if (request instanceof Api.channels.GetParticipant) {
        const own = request.participant instanceof Api.InputPeerSelf;
        return {
          participant: own
            ? opt.noPermission
              ? new Api.ChannelParticipant({ userId: me.id, date: 1 })
              : new Api.ChannelParticipantCreator({
                  userId: me.id,
                  adminRights: new Api.ChatAdminRights({ banUsers: true }),
                })
            : opt.adminTarget
              ? new Api.ChannelParticipantAdmin({
                  userId: target.id,
                  date: 1,
                  adminRights: new Api.ChatAdminRights({}),
                })
              : new Api.ChannelParticipant({ userId: target.id, date: 1 }),
        };
      }
      if (opt.onBan) opt.onBan(controller);
      return {};
    },
    async sendMessage(peer, value) {
      sent.push({ peer, value });
    },
  };
  const context = {
    signal: controller.signal,
    tasks: {
      run(_label, operation) {
        return operation(controller.signal);
      },
    },
    log: {
      error(event, fields) {
        logs.push({ event, fields });
      },
    },
    telegram: {
      async edit(_m, text, o) {
        edits.push({ text, o });
      },
      async getReply() {
        return { id: 2, chatId: "-100100", senderId: "200", outgoing: false, text: "target" };
      },
      async withClient(operation) {
        return operation(client, controller.signal);
      },
    },
  };
  const message = {
    id: 1,
    chatId: "-100100",
    senderId: "1",
    outgoing: true,
    replyToId: 2,
    text: ".portball spam 5m",
    raw,
  };
  const run = (args = ["spam", "5m"]) =>
    create().commands.portball.handle({ message, args, prefix: ".", command: "portball" }, context);
  return { controller, edits, sent, logs, invoked, run };
}
test("validates duration and reply locally with dynamic help", async () => {
  const f = fixture();
  await f.run(["59"]);
  assert.match(f.edits[0].text, /\.portball/);
  assert.equal(f.invoked.length, 0);
});
test("checks own ban permission and target membership before EditBanned", async () => {
  const denied = fixture({ noPermission: true });
  await denied.run();
  assert.equal(
    denied.invoked.some(x => x instanceof Api.channels.EditBanned),
    false,
  );
  assert.deepEqual(denied.logs, [{ event: "portball_failed", fields: undefined }]);
  const admin = fixture({ adminTarget: true });
  await admin.run();
  assert.equal(
    admin.invoked.some(x => x instanceof Api.channels.EditBanned),
    false,
  );
});
test("applies exact mute rights and escapes the original success receipt", async () => {
  const f = fixture();
  const before = Math.floor(Date.now() / 1000);
  await f.run(["spam<&", "5m"]);
  const ban = f.invoked.find(x => x instanceof Api.channels.EditBanned);
  assert.ok(ban);
  assert.ok(ban.bannedRights.untilDate >= before + 300 && ban.bannedRights.untilDate <= before + 301);
  assert.equal(ban.bannedRights.viewMessages, false);
  assert.equal(ban.bannedRights.sendMessages, true);
  assert.match(f.sent[0].value.message, /A&lt;&amp; B/);
  assert.match(f.sent[0].value.message, /spam&lt;&amp;/);
});
test("cancellation after moderation publishes no receipt or cleanup", async () => {
  const f = fixture({ onBan: controller => controller.abort() });
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.logs, []);
});
test("command deletion failure does not replace successful moderation", async () => {
  const f = fixture({ deleteError: true });
  await f.run();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.logs, [{ event: "portball_command_cleanup_failed", fields: undefined }]);
  assert.equal(f.edits.length, 0);
});
test("real Host unload cancels the managed five-second error cleanup", async t => {
  const root = await fs.mkdtemp(path.join(core, "temp/portball-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let deleted = 0;
  const host = new PluginHost({
    storageRoot: root,
    prefixes: ["!"],
    logger: { info() {}, error() {} },
    telegram: { async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {} },
  });
  await host.load(create());
  await host.dispatchPrimary({
    id: 9,
    chatId: "-1001",
    senderId: "1",
    outgoing: true,
    replyToId: 8,
    text: "!portball 59",
    raw: {
      message: "!portball 59",
      async delete() {
        deleted++;
      },
    },
  });
  const report = await host.unload("portball", 1000);
  assert.equal(report.completed, true);
  assert.equal(deleted, 0);
  await host.shutdown(1000);
});
test("the real EditBanned request resolves and serializes through teleproto", async () => {
  const f = fixture();
  await f.run();
  const request = f.invoked.find(x => x instanceof Api.channels.EditBanned);
  assert.ok(request);
  await request.resolve(
    {
      async getInputEntity(value) {
        return value instanceof Api.Channel
          ? new Api.InputChannel({ channelId: value.id, accessHash: value.accessHash })
          : new Api.InputPeerUser({ userId: value.id, accessHash: value.accessHash });
      },
    },
    require(path.join(core, "node_modules/teleproto/Utils.js")),
  );
  const bytes = request.getBytes();
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.length > 20);
});
test("real RPC errors use fixed errorMessage mappings", () => {
  const b = buildPlugin({
      id: "portball",
      packageRoot: path.resolve(__dirname, "../portball"),
      entry: "v2.ts",
      rootDir: core,
    }),
    mod = require(path.join(b.artifactDir, b.manifest.entry)),
    errors = require(path.join(core, "node_modules/teleproto/errors")),
    request = new Api.channels.EditBanned({});
  assert.equal(mod.category(new errors.ChatAdminRequiredError({ request })), "需要管理员权限");
  assert.equal(mod.category(new errors.RPCError("PRIVATE", request, 400)), "请确认目标、群组类型和管理员权限");
});
