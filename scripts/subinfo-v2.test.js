"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "subinfo",
  packageRoot: path.resolve(__dirname, "../subinfo"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

test("subinfo decodes subscription and counts protocols", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-subinfo-v2-")));
  const edits = [];
  const payload = Buffer.from("vmess://one\ntrojan://two\nss://three\n").toString("base64");
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: { fetch: async () => new Response(payload, { status: 200 }) },
    telegram: {
      async edit(m, text, options) {
        edits.push({ text, options });
      },
      async reply() {},
      async invoke() {},
      async getReply() {},
      async withClient() {},
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({
    id: 1,
    chatId: "chat",
    senderId: "owner",
    outgoing: true,
    text: ".subinfo https://example.com/sub",
  });
  assert.match(edits.at(-1).text, /节点总数: 3/);
  assert.match(edits.at(-1).text, /vmess: 1/);
  assert.match(edits.at(-1).text, /trojan: 1/);
  assert.match(edits.at(-1).text, /节点列表/);
});

test("subinfo accepts a replied subscription URL and reports regions", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-subinfo-reply-")));
  const edits = [];
  const payload = Buffer.from("ss://x#香港节点\ntrojan://x#Tokyo-1").toString("base64");
  const host = new PluginHost({
    storageRoot: root,
    logger: { info() {}, error() {} },
    http: { fetch: async () => new Response(payload) },
    telegram: {
      async edit(m, text, options) {
        edits.push({ text, options });
      },
      async reply() {},
      async invoke() {},
      async getReply() {
        return { id: 2, chatId: "chat", text: "订阅 https://example.com/sub" };
      },
      async withClient() {},
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  await host.dispatchPrimary({ id: 1, chatId: "chat", senderId: "owner", outgoing: true, text: ".subinfo" });
  assert.match(edits.at(-1).text, /节点总数: 2/);
  assert.match(edits.at(-1).text, /香港: 1/);
  assert.match(edits.at(-1).text, /Tokyo-1/);
});

async function inspect(payload) {
  const pages = [];
  const emit = async (_, text) => pages.push(text);
  await create().commands.subinfo.handle(
    {
      args: ["https://example.com/sub"],
      message: { id: 1, chatId: "1" },
    },
    {
      signal: new AbortController().signal,
      http: {
        async withResponse(url, init, consume) {
          return consume(new Response(payload), new AbortController().signal);
        },
      },
      telegram: { edit: emit, reply: emit },
    },
  );
  return pages.slice(1);
}

test("subinfo extracts VMess and SSR remarks without displaying encoded credentials", async () => {
  const secret = "private-password-do-not-display";
  const vmess = Buffer.from(JSON.stringify({ ps: "Tokyo <&>", id: secret, add: "private.example" })).toString("base64");
  const anonymous = Buffer.from(JSON.stringify({ id: secret })).toString("base64");
  const ssr = Buffer.from(
    `private.example:443:origin:aes-256-cfb:plain:${secret}/?remarks=${Buffer.from("香港 SSR").toString("base64url")}`,
  ).toString("base64url");
  const pages = await inspect(
    `vmess://${vmess}\nvmess://${anonymous}\nssr://${ssr}\nss://${Buffer.from(secret).toString("base64")}`,
  );
  const text = pages.join("");
  assert.match(text, /Tokyo &lt;&amp;&gt;/);
  assert.match(text, /VMESS 2/);
  assert.match(text, /香港 SSR/);
  assert.match(text, /SS 4/);
  for (const value of [secret, anonymous, vmess, ssr, "private.example"]) assert.ok(!text.includes(value));
});

test("subinfo classifies decoded names rather than credentials or substrings", async () => {
  const text = (
    await inspect(
      "trojan://us-password@hk.example#Australia\nss://jp-password@de.example#business\nvless://x#%E9%A6%99%E6%B8%AF\nss://x#broken%ZZ",
    )
  ).join("");
  assert.match(text, /澳大利亚: 1/);
  assert.match(text, /香港: 1/);
  assert.match(text, /其他: 2/);
  assert.doesNotMatch(text, /美国:|日本:|德国:/);
  assert.match(text, /broken%ZZ/);
});

test("subinfo paginates every node and preserves escaped Unicode names", async () => {
  const names = Array.from({ length: 65 }, (_, i) => `${i} <&😀${"x".repeat(100)}`);
  const pages = await inspect(names.map(name => `ss://secret#${encodeURIComponent(name)}`).join("\n"));
  assert.ok(pages.length > 1);
  assert.ok(pages.every(text => text.length <= 4096));
  const combined = pages.join("");
  for (const [index] of names.entries()) assert.ok(combined.includes(`${index + 1}. ${index} &lt;&amp;😀`));
});

test("subinfo parses Clash YAML names and protocols without exposing configuration fields", async () => {
  const text = (
    await inspect(`proxies:
  - name: "香港 <&> 01"
    type: ss
    server: private.example
    password: secret-password
  - name: Tokyo
    type: trojan
    password: other-secret
  - type: vless
    uuid: secret-uuid
`)
  ).join("");
  assert.match(text, /节点总数: 3/);
  assert.match(text, /ss: 1\ntrojan: 1\nvless: 1/);
  assert.match(text, /香港 &lt;&amp;&gt; 01/);
  assert.match(text, /VLESS 3/);
  assert.match(text, /日本: 1/);
  assert.doesNotMatch(text, /private\.example|secret-password|other-secret|secret-uuid/);
});

test("subinfo accepts JSON Clash configuration and counts safe unfamiliar protocols", async () => {
  const text = (
    await inspect(
      JSON.stringify({
        proxies: [
          { type: "anytls", name: "SG-1", password: "secret" },
          { type: "constructor", name: "test" },
        ],
      }),
    )
  ).join("");
  assert.match(text, /节点总数: 2/);
  assert.match(text, /anytls: 1\nconstructor: 1/);
  assert.match(text, /新加坡: 1/);
  assert.doesNotMatch(text, /secret/);
});

test("subinfo rejects malformed Clash nodes without dumping their contents", async () => {
  for (const payload of [
    "proxies: secret",
    "proxies: [null]",
    "proxies: [{type: {password: secret}}]",
    'proxies: [{type: "ss<script>"}]',
    "proxies: [",
  ]) {
    assert.deepEqual(await inspect(payload), ["订阅读取或解析失败，请稍后重试"]);
  }
});

test("subinfo supports remaining legacy URI protocol families", async () => {
  const protocols = ["hy", "socks5", "http", "https", "shadowtls", "naive"];
  const text = (await inspect(protocols.map(p => `${p}://secret@private.example`).join("\n"))).join("");
  assert.match(text, /节点总数: 6/);
  for (const protocol of protocols) assert.ok(text.includes(`${protocol}: 1`));
  assert.doesNotMatch(text, /secret|private\.example/);
});

test("subinfo reports bounded traffic and expiry information from subscription headers", async () => {
  const pages = [];
  const now = Date.now();
  await create().commands.subinfo.handle(
    {
      args: ["https://example.com/sub"],
      message: { id: 1, chatId: "1" },
    },
    {
      signal: new AbortController().signal,
      http: {
        async withResponse(url, init, consume) {
          const response = new Response("ss://x#node", {
            headers: {
              "subscription-userinfo": `upload=1024; download=2048; total=4096; expire=${Math.floor((now + 86400000) / 1000)}`,
            },
          });
          return consume(response, new AbortController().signal);
        },
      },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
      },
    },
  );
  assert.match(pages.at(-1), /上传: 1\.00 KiB/);
  assert.match(pages.at(-1), /已用: 3\.00 KiB/);
  assert.match(pages.at(-1), /剩余: 1\.00 KiB/);
  assert.match(pages.at(-1), /到期:/);
});

test("subinfo distinguishes missing, unlimited and invalid traffic fields", async () => {
  const { trafficSummary } = require(path.join(artifactDir, "index.cjs"));
  assert.match(trafficSummary(null), /未提供/);
  assert.match(trafficSummary("upload=1;download=2;total=0;expire=0"), /未设限/);
  assert.match(trafficSummary("expire=99999999999999999999"), /无效时间/);
});

test("subinfo keeps legacy cha alias, batch URLs and extended regions", async () => {
  const edits = [],
    replies = [],
    fetched = [];
  const context = {
    signal: new AbortController().signal,
    log: { error() {} },
    http: {
      async withResponse(url, init, consume) {
        fetched.push(url);
        return consume(new Response(`ss://x#${url.endsWith("/a") ? "HKG" : "Malaysia"}`), new AbortController().signal);
      },
    },
    telegram: {
      async edit(_, text) {
        edits.push(text);
      },
      async reply(_, text) {
        replies.push(text);
      },
      async getReply() {},
    },
  };
  await create().commands.cha.handle(
    {
      args: ["https://example.com/a", "https://example.com/b"],
      message: { id: 1, chatId: "1", text: "", outgoing: true },
    },
    context,
  );
  assert.deepEqual(
    fetched.filter(url => /\/(?:a|b)$/.test(url)),
    ["https://example.com/a", "https://example.com/b"],
  );
  assert.match(edits.at(-1), /节点总数/);
  assert.match(edits.at(-1), /HKG/);
  assert.match(replies.join(""), /Malaysia/);
  const detailed = [];
  await create().commands.subinfo.handle(
    { args: ["https://example.com/a"], message: { id: 2, chatId: "1", text: "", outgoing: true } },
    {
      ...context,
      telegram: {
        ...context.telegram,
        async edit(_, text) {
          detailed.push(text);
        },
        async reply(_, text) {
          detailed.push(text);
        },
      },
    },
  );
  assert.match(detailed.join(""), /香港: 1/);
});

test("subinfo preserves the first page when a continuation fails", async () => {
  const edits = [],
    replies = [],
    logs = [];
  const names = Array.from({ length: 80 }, (_, i) => `node-${i}-${"x".repeat(100)}`);
  await create().commands.subinfo.handle(
    { args: ["https://example.com/sub"], message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      log: {
        error(name, data) {
          logs.push({ name, data });
        },
      },
      http: {
        async withResponse(url, init, consume) {
          return consume(new Response(names.map(n => `ss://x#${n}`).join("\n")), new AbortController().signal);
        },
      },
      telegram: {
        async edit(_, text) {
          edits.push(text);
        },
        async reply(_, text) {
          replies.push(text);
          if (replies.length === 1) throw new Error("SECRET continuation");
        },
        async getReply() {},
      },
    },
  );
  assert.match(edits.at(-1), /订阅信息/);
  assert.doesNotMatch(edits.join("") + replies.join(""), /订阅读取或解析失败|SECRET/);
  assert.equal(logs[0].data.category, "Error");
});

test("subinfo txt uploads a report to the exact rawless peer before deleting command", async () => {
  const calls = [];
  const client = {
    async sendFile(peer, options) {
      calls.push(["send", peer.toString(), options]);
    },
    async deleteMessages(peer, ids) {
      calls.push(["delete", peer.toString(), ids]);
    },
  };
  await create().commands.cha.handle(
    {
      args: ["txt", "https://example.com/sub"],
      message: { id: 7, chatId: "9007199254740997", text: "", outgoing: true },
    },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume) {
          return consume(new Response("ss://x#A%26B%2F%3Cx%3E"), new AbortController().signal);
        },
      },
      telegram: {
        async edit() {},
        async reply() {},
        async getReply() {},
        async withClient(use) {
          return use(client, new AbortController().signal);
        },
      },
    },
  );
  assert.deepEqual(
    calls.map(c => c.slice(0, 2)),
    [
      ["send", "9007199254740997"],
      ["delete", "9007199254740997"],
    ],
  );
  assert.match(calls[0][2].file.toString(), /A&B\/<x>/);
  assert.doesNotMatch(calls[0][2].file.toString(), /&amp;|&lt;|&gt;/);
});

test("subinfo cancellation actively cancels and unlocks a hanging response body", async () => {
  const controller = new AbortController();
  let cancelled = false,
    lockedDuringCancel = false;
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      lockedDuringCancel = body.locked;
    },
  });
  const work = create().commands.subinfo.handle(
    { args: ["https://example.com/sub"], message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: controller.signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume) {
          return consume(new Response(body), controller.signal);
        },
      },
      telegram: { async edit() {}, async reply() {}, async getReply() {} },
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("stop"));
  await work;
  assert.equal(cancelled, true);
  assert.equal(lockedDuringCancel, true);
  assert.equal(body.locked, false);
});

test("subinfo batch keeps successful reports when one subscription fails", async () => {
  const pages = [];
  await create().commands.subinfo.handle(
    {
      args: ["https://example.com/bad", "https://example.com/good"],
      message: { id: 1, chatId: "1", text: "", outgoing: true },
    },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume) {
          if (url.endsWith("/bad")) throw new Error("SECRET upstream");
          return consume(new Response("ss://x#Tokyo"), new AbortController().signal);
        },
      },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
        async getReply() {},
      },
    },
  );
  assert.match(pages.join(""), /example\.com\/bad/);
  assert.match(pages.join(""), /Tokyo/);
  assert.doesNotMatch(pages.join(""), /SECRET/);
});

test("subinfo restores bounded mapping and same-origin website discovery without forwarding subscription paths", async () => {
  const calls = [],
    pages = [];
  const subscription = "https://panel.example/subscribe/SECRET-token?auth=SECRET";
  await create().commands.subinfo.handle(
    { args: [subscription], message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume, options) {
          calls.push({ url: String(url), init, options });
          let response;
          if (String(url).includes("raw.githubusercontent.com"))
            response = new Response("panel.example=Mapped Airport");
          else if (String(url) === "https://panel.example/auth/login")
            response = new Response("missing", { status: 404 });
          else if (String(url) === "https://panel.example/")
            response = new Response("<title>登录 — Site Airport</title>");
          else
            response = new Response("ss://x#Tokyo", {
              headers: { "content-disposition": "attachment; filename=Header Airport" },
            });
          return consume(response, new AbortController().signal);
        },
      },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
        async getReply() {},
      },
    },
  );
  assert.match(pages.at(-1), /Mapped Airport/);
  assert.deepEqual(
    calls.slice(0, 3).map(call => call.url),
    [
      "https://raw.githubusercontent.com/Hyy800/Quantumult-X/refs/heads/Nana/ymys.txt",
      "https://panel.example/auth/login",
      "https://panel.example/",
    ],
  );
  assert.ok(calls.every(call => call.options.timeoutMs <= 15000));
  assert.ok(calls.every(call => call.options.denyPrivateAddresses === true));
  assert.deepEqual(calls[1].options.redirects.allowedHosts, ["panel.example"]);
  assert.ok(calls.slice(0, 3).every(call => !call.url.includes("SECRET")));
});

test("subinfo paginates long identity fields even when the subscription has no nodes", async () => {
  const pages = [];
  const longName = Array.from({ length: 900 }, (_, index) => `M${index}`).join(" ");
  await create().commands.subinfo.handle(
    { args: ["https://panel.example/sub"], message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume) {
          let response;
          if (String(url).includes("raw.githubusercontent.com")) response = new Response(`panel.example=${longName}`);
          else if (String(url) === "https://panel.example/auth/login")
            response = new Response(`<title>${"T".repeat(5000)}</title>`);
          else response = new Response("plain text with no nodes");
          return consume(response, new AbortController().signal);
        },
      },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
        async getReply() {},
      },
    },
  );
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 4096));
  assert.match(pages.join(""), /M0/);
  assert.match(pages.join(""), /M899/);
  assert.match(pages.join(""), /节点总数: 0/);
});

test("subinfo no-URL help uses the invocation prefix and documents every mode", async () => {
  const pages = [];
  await create().commands.subinfo.handle(
    { args: [], prefix: "!!", message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
        async getReply() {},
      },
    },
  );
  assert.match(pages.join(""), /!!subinfo txt/);
  assert.match(pages.join(""), /!!cha txt/);
  assert.match(pages.join(""), /多个链接/);
});

test("subinfo paginates a heavily escaped URL in a batch failure", async () => {
  const pages = [];
  const long = `https://example.com/sub?${"&".repeat(1000)}tail=1`;
  assert.ok(long.length <= 2048);
  await create().commands.subinfo.handle(
    { args: [long, "https://example.com/bad"], message: { id: 1, chatId: "1", text: "", outgoing: true } },
    {
      signal: new AbortController().signal,
      log: { error() {} },
      http: {
        async withResponse(url, init, consume) {
          if (String(url).includes("raw.githubusercontent.com"))
            return consume(new Response(""), new AbortController().signal);
          if (String(url).endsWith("/auth/login"))
            return consume(new Response("<title>Panel</title>"), new AbortController().signal);
          throw new Error("fixed failure");
        },
      },
      telegram: {
        async edit(_, text) {
          pages.push(text);
        },
        async reply(_, text) {
          pages.push(text);
        },
        async getReply() {},
      },
    },
  );
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 4096));
  assert.match(pages.join(""), /tail=1/);
  assert.match(pages.join(""), /example\.com\/bad/);
});
