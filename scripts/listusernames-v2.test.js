"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api, utils } = require(path.join(core, "node_modules/teleproto"));
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "listusernames",
  packageRoot: path.resolve(__dirname, "../listusernames"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;
const envelope = {
  id: 2147483640,
  chatId: "9007199254740993",
  senderId: "123",
  outgoing: true,
  text: ".listusernames",
  raw: { peerId: new Api.PeerUser({ userId: 9007199254740993n }) },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, { chats = [], invoke, sendMessage, prefixes = ["."] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-listusernames-v2-")));
  const edits = [],
    replies = [],
    sends = [],
    invokes = [],
    logs = [];
  const client = {
    async sendMessage(peer, value) {
      sends.push({ peer, value });
      return sendMessage?.(sends.length, peer, value);
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes,
    logger: {
      info(event, fields) {
        logs.push({ level: "info", event, fields });
      },
      error(event, fields) {
        logs.push({ level: "error", event, fields });
      },
    },
    telegram: {
      async edit(message, text, options) {
        edits.push({ message, text, options });
      },
      async reply(message, text, options) {
        replies.push({ message, text, options });
      },
      async invoke(request) {
        invokes.push(request);
        assert.ok(request instanceof Api.channels.GetAdminedPublicChannels);
        await request.resolve({}, utils);
        assert.ok(request.getBytes().length > 0);
        return invoke ? invoke(request) : { chats };
      },
      async getReply() {
        assert.fail("unexpected reply lookup");
      },
      async withClient(operation, signal) {
        return operation(client, signal);
      },
    },
  });
  await host.load(create());
  let closed = false;
  t.after(async () => {
    if (!closed) assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    edits,
    replies,
    sends,
    invokes,
    logs,
    close: async timeout => {
      const value = await host.shutdown(timeout);
      closed = value.completed;
      return value;
    },
    run: (text, extra = {}) => host.dispatchPrimary({ ...envelope, text, ...extra }),
  };
}

test("help uses the active prefix and performs no Telegram query", async t => {
  const f = await fixture(t, { prefixes: ["<&"] });
  await f.run("<&listusernames help");
  assert.match(f.edits[0].text, /listusernames - 列出公开群组\/频道/);
  assert.match(f.edits[0].text, /&lt;&amp;listusernames/);
  assert.match(f.edits[0].text, /所有用户均可使用/);
  assert.deepEqual(f.edits[0].options, { parseMode: "html", linkPreview: false });
  assert.equal(f.invokes.length, 0);
});

test("query preserves original progress, fields, counts, escaping and precise IDs", async t => {
  const f = await fixture(t, {
    chats: [
      { id: 9007199254740993n, title: "A < B", username: "public_one", broadcast: true },
      { id: 42n, title: "", username: "", broadcast: false },
    ],
  });
  await f.run(".listusernames");
  assert.equal(f.edits[0].text, "🔄 <b>正在获取公开群组/频道列表...</b>");
  assert.deepEqual(f.edits[0].options, { parseMode: "html" });
  assert.equal(f.invokes.length, 1);
  assert.equal(
    f.edits[1].text,
    `📋 <b>属于我的公开群组/频道</b>

共找到 <b>2</b> 个公开群组/频道：

<b>1.</b> A &lt; B (📢 频道)
   👤 用户名: <code>@public_one</code>
   🆔 ID: <code>9007199254740993</code>

<b>2.</b> 未知标题 (👥 群组)
   👤 用户名: <code>无用户名</code>
   🆔 ID: <code>42</code>

📊 <b>统计信息：</b>
• 频道数量: 1
• 群组数量: 1
• 总计: 2`,
  );
  assert.deepEqual(f.edits[1].options, { parseMode: "html" });
  assert.equal(f.edits[1].message.chatId, envelope.chatId);
});

test("empty results preserve the original receipt", async t => {
  const f = await fixture(t);
  await f.run(".listusernames");
  assert.equal(f.edits.at(-1).text, "📭 <b>没有找到公开群组/频道</b>\n\n您目前没有拥有任何公开群组或频道");
  assert.deepEqual(f.edits.at(-1).options, { parseMode: "html" });
});

test("all entries survive bounded valid HTML pagination with native reply metadata", async t => {
  const chats = Array.from({ length: 80 }, (_, index) => ({
    id: BigInt("9007199254740" + String(index).padStart(3, "0")),
    title: `<title-${index}>&😀`.repeat(8),
    username: `name_${index}`,
    broadcast: index % 3 === 0,
  }));
  const f = await fixture(t, { chats });
  await f.run(".listusernames");
  const pages = [f.edits.at(-1).text, ...f.sends.map(item => item.value.message)];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  const combined = pages.join("\n");
  for (let index = 0; index < chats.length; index++) assert.match(combined, new RegExp(`title-${index}(?:&|<)`));
  assert.match(combined, /频道数量: 27/);
  assert.match(combined, /群组数量: 53/);
  for (const page of pages)
    for (const tag of ["b", "code"]) {
      assert.equal(
        (page.match(new RegExp(`<${tag}>`, "g")) || []).length,
        (page.match(new RegExp(`</${tag}>`, "g")) || []).length,
      );
    }
  for (const sent of f.sends) {
    assert.equal(sent.peer.userId.toString(), "9007199254740993");
    assert.equal(sent.value.replyTo, envelope.id);
    assert.equal(sent.value.parseMode, "html");
  }
});

test("later-page failure preserves published results, logs safely and never repeats the query", async t => {
  const secret = "private telegram credential";
  const chats = Array.from({ length: 80 }, (_, index) => ({
    id: BigInt(index + 1),
    title: `title-${index}-` + "x".repeat(100),
    username: `name_${index}`,
  }));
  const f = await fixture(t, {
    chats,
    sendMessage(count) {
      if (count === 1) throw new Error(secret);
    },
  });
  await f.run(".listusernames");
  assert.equal(f.invokes.length, 1);
  assert.match(f.edits.at(-1).text, /属于我的公开群组\/频道/);
  assert.doesNotMatch(f.edits.at(-1).text, /获取列表失败/);
  assert.ok(f.logs.some(item => item.event === "listusernames_delivery_interrupted" && item.fields.published === 1));
  assert.match(f.replies.at(-1).text, /已发送 1\//);
  assert.equal(
    JSON.stringify({
      texts: f.edits.map(item => item.text),
      replies: f.replies.map(item => item.text),
      logs: f.logs,
    }).includes(secret),
    false,
  );
});

test("unload waits for a pending native page send and suppresses later pages and errors", async t => {
  const started = deferred(),
    release = deferred();
  const chats = Array.from({ length: 80 }, (_, index) => ({
    id: BigInt(index + 1),
    title: `title-${index}-` + "x".repeat(100),
    username: `name_${index}`,
  }));
  const f = await fixture(t, {
    chats,
    sendMessage: async count => {
      if (count === 1) {
        started.resolve();
        await release.promise;
      }
    },
  });
  const running = f.run(".listusernames");
  await started.promise;
  try {
    const report = await f.host.unload("listusernames", 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
  } finally {
    release.resolve();
  }
  await running;
  assert.equal((await f.close(1000)).completed, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.length, 2);
});

test("query failures are generic and never expose Telegram errors", async t => {
  const secret = "AUTH_KEY_UNREGISTERED private-session";
  const f = await fixture(t, {
    invoke: async () => {
      throw new Error(secret);
    },
  });
  await f.run(".listusernames");
  assert.match(f.edits.at(-1).text, /获取列表失败/);
  assert.equal(JSON.stringify({ texts: f.edits.map(item => item.text), logs: f.logs }).includes(secret), false);
});
