"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core"),
  { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs")),
  { PluginHost } = require(path.join(core, "dist/v2/host.js"));
function plugin() {
  const { artifactDir, manifest } = buildPlugin({
    id: "nodeseek",
    packageRoot: path.resolve(__dirname, "../nodeseek"),
    entry: "v2.ts",
  });
  assert.equal(manifest.id, "nodeseek");
  const entry = path.join(artifactDir, "index.cjs");
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}
test("nodeseek production artifact loads, migrates cookie and signs through scoped HTTP", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-nodeseek-artifact-"))),
    dir = path.join(root, "nodeseek"),
    edits = [],
    requests = [];
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ cookie: "session=fixture-cookie-long-enough", interval: 5 }),
  );
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ success: true, message: "获得 5 鸡腿" });
      },
    },
    telegram: {
      async edit(_m, text) {
        edits.push(text);
      },
      async reply() {
        assert.fail("reply");
      },
      async invoke() {
        assert.fail("invoke");
      },
      async getReply() {
        assert.fail("getReply");
      },
      async withClient() {
        assert.fail("native");
      },
    },
  });
  await host.load(plugin());
  t.after(async () => {
    await host.shutdown(2000);
    await fs.rm(root, { recursive: true, force: true });
  });
  const data = JSON.parse(await fs.readFile(path.join(dir, "data.json"), "utf8")),
    config = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
  assert.equal(data.cookie, "session=fixture-cookie-long-enough");
  assert.equal(config.cookie, undefined);
  assert.equal((await host.readSettings("nodeseek")).secretSet.cookie, true);
  await host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".nodeseek now" });
  assert.equal(requests.length, 1);
  assert.equal(new Headers(requests[0].init.headers).get("Cookie"), "session=fixture-cookie-long-enough");
  assert.match(edits.at(-1), /签到成功/);
});
