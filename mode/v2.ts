import { renderHelp as renderPluginHelp } from "./v2/help";
import { readFile } from "node:fs/promises";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
type Mode = "off" | "del" | "bold" | "italic" | "underline" | "mask" | "all";
type Data = {
  schemaVersion: 1;
  legacyImported: boolean;
  chats: Record<string, Mode>;
  whitelist: string[];
  blacklist: string[];
  globalMode: Mode;
  [key: string]: unknown;
};
const modes = new Set<Mode>(["off", "del", "bold", "italic", "underline", "mask", "all"]);
const defaults: Data = {
  schemaVersion: 1,
  legacyImported: false,
  chats: {},
  whitelist: [],
  blacklist: [],
  globalMode: "off",
};
const store = (c: PluginContext) => c.storage.json<Data>("state-v2.json", defaults);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const validMode = (v: unknown): Mode => (typeof v === "string" && modes.has(v as Mode) ? (v as Mode) : "off");
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === "string"))] : []);
const chats = (v: unknown): Record<string, Mode> =>
  v && typeof v === "object"
    ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" && modes.has(x as Mode))) as Record<
        string,
        Mode
      >)
    : {};
async function raw(c: PluginContext, file: string) {
  try {
    const v = JSON.parse(await readFile(c.files.dataPath(file), { encoding: "utf8", signal: c.signal }));
    c.signal.throwIfAborted();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid");
    return v as Record<string, unknown>;
  } catch (e) {
    c.signal.throwIfAborted();
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return {};
    throw new Error("MODE_CONFIG_READ_FAILED");
  }
}
async function migrate(c: PluginContext) {
  const current = await raw(c, "state-v2.json");
  if (current.legacyImported === true && current.schemaVersion === 1) return;
  const legacy = await raw(c, "config.json"),
    merged = { ...legacy, ...current };
  const choose = (k: string) => (Object.hasOwn(current, k) ? current[k] : legacy[k]);
  await store(c).update(
    () =>
      ({
        ...merged,
        schemaVersion: 1,
        legacyImported: true,
        chats: chats(choose("chats")),
        whitelist: ids(choose("whitelist")),
        blacklist: ids(choose("blacklist")),
        globalMode: validMode(choose("globalMode")),
      }) as Data,
  );
}
const tags: Record<Exclude<Mode, "off" | "mask">, [string, string]> = {
  bold: ["<b>", "</b>"],
  italic: ["<i>", "</i>"],
  del: ["<s>", "</s>"],
  underline: ["<u>", "</u>"],
  all: ["<u><b><i><s>", "</s></i></b></u>"],
};
async function style(m: MessageEnvelope, c: PluginContext, selected: Mode) {
  try {
    c.signal.throwIfAborted();
    if (selected === "mask")
      await c.telegram.edit(m, `<spoiler>${esc(m.text.trim())}</spoiler>`, { parseMode: "html" });
    else {
      const [start, end] = tags[selected as Exclude<Mode, "off" | "mask">];
      await c.telegram.edit(m, start + esc(m.text.trim()) + end, { parseMode: "html" });
    }
    c.signal.throwIfAborted();
  } catch {
    if (!c.signal.aborted) c.log.error("mode_message_edit_failed");
  }
}
async function deliverList(c: PluginContext, m: MessageEnvelope, title: string, values: readonly string[]) {
  const source = `${title}：\n<code>${values.length ? esc(values.join("\n")) : "空"}</code>`,
    rendered = await ui.renderRichText(source, ui.PAGE_LABEL_RESERVE),
    pages = rendered.map((p, n) => p + ui.pageLabel(n, rendered.length)),
    result = await ui.deliverPages(pages, c.signal, (p, n) =>
      n ? c.telegram.reply(m, p, { parseMode: "html" }) : c.telegram.edit(m, p, { parseMode: "html" }),
    );
  if (result.interrupted) {
    c.log.info("mode_list_pagination_interrupted", {
      published: result.published,
      total: result.total,
      category: ui.deliveryErrorCategory(result.error),
    });
    if (!result.published) throw result.error;
    try {
      await c.telegram.reply(m, ui.interruptedNotice(result), { parseMode: "html" });
    } catch {}
  }
}
export default function createMode() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "mode",
    description: "管理消息格式模式",
    async setup(c) {
      await migrate(c);
    },
    listeners: [
      {
        ignoreCommands: true,
        async handle(m, c) {
          if (m.edited || !(m.outgoing || m.saved) || !m.text.trim()) return;
          const d = await store(c).read();
          c.signal.throwIfAborted();
          if ((d.whitelist.length && !d.whitelist.includes(m.chatId)) || d.blacklist.includes(m.chatId)) return;
          const local = d.chats[m.chatId] ?? "off",
            selected = local === "off" ? d.globalMode : local;
          if (selected !== "off") await style(m, c, selected);
        },
      },
    ],
    commands: {
      mode: {
        helpArgs: ["help", "h"],
        description: "管理消息格式模式",
        async handle(i, c) {
          const db = store(c),
            d = await db.read();
          c.signal.throwIfAborted();
          const chat = i.message.chatId,
            [a, b] = i.args;
          if (!a) {
            await c.telegram.edit(
              i.message,
              `<b>当前会话模式：</b> <code>${esc(d.chats[chat] ?? "off")}</code>\n<b>全局模式：</b> <code>${esc(d.globalMode)}</code>\n<b>白名单：</b> ${d.whitelist.includes(chat) ? "✔ 是" : "✖ 否"}\n<b>黑名单：</b> ${d.blacklist.includes(chat) ? "✔ 是" : "✖ 否"}`,
              { parseMode: "html" },
            );
            return;
          }
          if (a === "help" || a === "h") {
            await c.telegram.edit(i.message, renderPluginHelp(i.prefix), { parseMode: "html" });
            return;
          }
          if (a === "global") {
            if (!b) {
              await c.telegram.edit(i.message, `<b>全局模式：</b> <code>${esc(d.globalMode)}</code>`, {
                parseMode: "html",
              });
              return;
            }
            const selected = b.toLowerCase();
            if (!modes.has(selected as Mode)) {
              await c.telegram.edit(i.message, renderPluginHelp(i.prefix), { parseMode: "html" });
              return;
            }
            await db.update(v => ({ ...v, globalMode: selected as Mode }));
            c.signal.throwIfAborted();
            await c.telegram.edit(i.message, `全局模式已设置为 ${esc(selected)}`, { parseMode: "html" });
            return;
          }
          if (a === "whitelist" || a === "blacklist") {
            const values = d[a];
            if (b === "list") {
              await deliverList(c, i.message, a === "whitelist" ? "⚪ 白名单" : "⚫ 黑名单", values);
              return;
            }
            if (!["add", "remove", "rm"].includes(b ?? "")) {
              await c.telegram.edit(i.message, renderPluginHelp(i.prefix), { parseMode: "html" });
              return;
            }
            await db.update(v => ({
              ...v,
              [a]: b === "add" ? [...new Set([...v[a], chat])] : v[a].filter(id => id !== chat),
            }));
            c.signal.throwIfAborted();
            await c.telegram.edit(i.message, "设置已更新");
            return;
          }
          const selected = a.toLowerCase();
          if (!modes.has(selected as Mode)) {
            await c.telegram.edit(i.message, renderPluginHelp(i.prefix), { parseMode: "html" });
            return;
          }
          await db.update(v => ({ ...v, chats: { ...v.chats, [chat]: selected as Mode } }));
          c.signal.throwIfAborted();
          await c.telegram.edit(i.message, `当前会话模式已设置为 ${esc(selected)}`);
        },
      },
    },
  });
}
