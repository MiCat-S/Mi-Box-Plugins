import { access, readFile } from "node:fs/promises";
import {
  definePlugin,
  requireSdkFeatures,
  ui,
  type MessageEnvelope,
  type PluginContext,
} from "telebox/sdk";
import { renderHelp as renderPluginHelp } from "./v2/help";

type Rule = { id: number; msg: string; redirect?: string };
type Config = {
  schemaVersion: 1;
  users: string[];
  chats: string[];
  userNames: Record<string, string>;
  chatNames: Record<string, string>;
  messages: Rule[];
  legacyMigrated: boolean;
  [key: string]: unknown;
};

const defaults: Config = {
  schemaVersion: 1,
  users: [],
  chats: [],
  userNames: {},
  chatNames: {},
  messages: [],
  legacyMigrated: false,
};
const store = (context: PluginContext) => context.storage.json<Config>("config.json", defaults);
const validUser = (value: string) => /^[1-9][0-9]*$/.test(value);
const validChat = (value: string) => /^-?[1-9][0-9]*$/.test(value);
const htmlEntities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const escape = (value: unknown) => String(value ?? "").replace(
  /[&<>"']/g,
  char => htmlEntities[char]!,
);

function normalize(value: any): Config {
  const source = value?.messages && typeof value.messages === "object" && !Array.isArray(value.messages)
    ? Object.entries(value.messages).map(([msg, redirect], index) => ({
        id: index + 1,
        msg,
        ...(String(redirect) !== msg ? { redirect: String(redirect) } : {}),
      }))
    : Array.isArray(value?.messages) ? value.messages : [];
  const messages: Rule[] = source.flatMap((item: any, index: number) =>
    typeof item?.msg === "string" && item.msg ? [{
      id: Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 ? Number(item.id) : index + 1,
      msg: item.msg,
      ...(typeof item.redirect === "string" && item.redirect ? { redirect: item.redirect } : {}),
    }] : []);
  return {
    ...value,
    schemaVersion: 1,
    users: [...new Set(Array.isArray(value?.users) ? value.users.map(String).filter(validUser) : [])],
    chats: [...new Set(Array.isArray(value?.chats) ? value.chats.map(String).filter(validChat) : [])],
    userNames: value?.userNames && typeof value.userNames === "object" ? value.userNames : {},
    chatNames: value?.chatNames && typeof value.chatNames === "object" ? value.chatNames : {},
    messages,
    legacyMigrated: value?.legacyMigrated === true,
  };
}

async function explicitConfigFields(context: PluginContext): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(context.files.dataPath("config.json"), "utf8"));
    return new Set(raw && typeof raw === "object" ? Object.keys(raw) : []);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function migrate(context: PluginContext) {
  const fields = await explicitConfigFields(context);
  if (normalize(await store(context).read()).legacyMigrated) return;
  let users: any[] = [], chats: any[] = [], messages: any[] = [];
  try {
    await access(context.files.dataPath("sure.db"));
    const database = context.storage.sqlite("sure.db", { readonly: true });
    const check = await database.preflight({
      users: ["uid", "username"],
      chats: ["id", "name"],
      msgs: ["id", "msg", "redirect"],
    }, context.signal);
    if (!check.compatible) throw new Error("INVALID_SURE_DB");
    [users, chats, messages] = await Promise.all([
      database.read(db => db.prepare("SELECT uid, username FROM users ORDER BY uid").safeIntegers(true).all() as any, context.signal),
      database.read(db => db.prepare("SELECT id, name FROM chats ORDER BY id").safeIntegers(true).all() as any, context.signal),
      database.read(db => db.prepare("SELECT id, msg, redirect FROM msgs ORDER BY id").safeIntegers(true).all() as any, context.signal),
    ]);
  } catch (error) {
    context.signal.throwIfAborted();
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await store(context).update(value => {
    const current = normalize(value);
    if (current.legacyMigrated) return current;
    return normalize({
      ...current,
      users: fields.has("users") ? current.users : users.map(item => String(item.uid)),
      chats: fields.has("chats") ? current.chats : chats.map(item => String(item.id)),
      userNames: {
        ...Object.fromEntries(users.map(item => [String(item.uid), String(item.username ?? item.uid)])),
        ...current.userNames,
      },
      chatNames: {
        ...Object.fromEntries(chats.map(item => [String(item.id), String(item.name ?? item.id)])),
        ...current.chatNames,
      },
      messages: fields.has("messages") ? current.messages : messages,
      legacyMigrated: true,
    });
  }, context.signal);
}

async function output(context: PluginContext, message: MessageEnvelope, text: string) {
  const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE))
    .map((page, index, all) => page + ui.pageLabel(index, all.length));
  const result = await ui.deliverPages(pages, context.signal, (page, index) =>
    index
      ? context.telegram.reply(message, page, { parseMode: "html" })
      : context.telegram.edit(message, page, { parseMode: "html" }));
  if (!result.interrupted) return;
  context.log.info("sure.pagination.interrupted", {
    published: result.published,
    total: result.total,
    category: ui.deliveryErrorCategory(result.error),
  });
  if (!result.published) throw result.error;
  try {
    await context.telegram.reply(message, ui.interruptedNotice(result), { parseMode: "html" });
  } catch {}
}

function isOwnerMessage(message: MessageEnvelope, ownerId: string) {
  if (message.senderId === ownerId) return true;
  const raw = message.raw as any;
  return message.outgoing && !message.forwarded && !message.edited && raw?.className === "Message" && !raw.post
    && /^-100[1-9][0-9]*$/.test(message.chatId)
    && /^-100[1-9][0-9]*$/.test(message.senderId ?? "")
    && validUser(ownerId);
}

async function requireOwner(message: MessageEnvelope, context: PluginContext) {
  const ownerId = await context.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const me = await client.getMe();
    signal.throwIfAborted();
    return String(me.id);
  });
  if (isOwnerMessage(message, ownerId)) return true;
  await context.telegram.edit(message, "只有 owner 可以管理 sure 白名单");
  return false;
}

function rawTail(invocation: any, context: PluginContext, skip: number) {
  const raw = invocation.message.raw as any;
  const source = typeof raw?.message === "string" ? raw.message : invocation.message.text;
  const route = context.commands.parse(source);
  const wanted = invocation.args.slice(skip);
  if (route?.command !== "sure" || !wanted.length) return wanted.join(" ");
  const body = source.slice(route.prefix.length);
  const tokens = [...body.matchAll(/\S+/gu)];
  const start = tokens[tokens.length - wanted.length]?.index;
  return start === undefined ? wanted.join(" ") : body.slice(start).trimEnd();
}

async function resolveEntity(
  context: PluginContext,
  message: MessageEnvelope,
  target: string | undefined,
  kind: "user" | "chat",
) {
  if (!target) {
    if (kind === "user") {
      const reply = await context.telegram.getReply(message);
      if (!reply?.senderId) throw new Error("NO_USER");
      return { id: reply.senderId, name: reply.senderId };
    }
    return { id: message.chatId, name: message.chatId };
  }
  if (kind === "user" && validUser(target) || kind === "chat" && validChat(target)) {
    return { id: target, name: target };
  }
  return context.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const entity: any = await client.getEntity(target);
    signal.throwIfAborted();
    const raw = String(entity?.id ?? "");
    if (!raw) throw new Error("NO_ENTITY");
    const id = kind === "chat" && entity?.className === "Channel" ? `-100${raw}`
      : kind === "chat" && entity?.className === "Chat" ? `-${raw}` : raw;
    const name = entity?.username ? `@${entity.username}`
      : String(entity?.title ?? entity?.firstName ?? id);
    return { id, name };
  });
}

async function updateEntity(
  invocation: any,
  context: PluginContext,
  kind: "user" | "chat",
  action: "add" | "del",
  target: string | undefined,
) {
  let item: { id: string; name: string };
  try {
    item = await resolveEntity(context, invocation.message, target, kind);
  } catch {
    if (!context.signal.aborted) {
      await context.telegram.edit(invocation.message, kind === "user" ? "无法获取用户信息" : "无法获取对话信息");
    }
    return;
  }
  await store(context).update(value => {
    const current = normalize(value);
    const values = new Set(kind === "user" ? current.users : current.chats);
    action === "add" ? values.add(item.id) : values.delete(item.id);
    return kind === "user"
      ? { ...current, users: [...values], userNames: { ...current.userNames, [item.id]: item.name } }
      : { ...current, chats: [...values], chatNames: { ...current.chatNames, [item.id]: item.name } };
  });
  try {
    await context.telegram.edit(
      invocation.message,
      `${kind === "user" ? "sure user " : ""}已${action === "add" ? "添加" : "删除"}: <code>${escape(item.name)}</code>`,
      { parseMode: "html" },
    );
  } catch {
    if (!context.signal.aborted) context.log.info("sure.entity.receipt_failed", { kind, action });
  }
}

async function relay(message: MessageEnvelope, context: PluginContext) {
  if (message.outgoing || message.forwarded || !message.senderId || !message.text.trim()) return;
  const state = normalize(await store(context).read());
  const legacyChat = message.chatId.startsWith("-100") ? message.chatId.slice(4)
    : message.chatId.startsWith("-") ? message.chatId.slice(1) : message.chatId;
  if (!state.users.includes(message.senderId)
    || state.chats.length && !state.chats.includes(message.chatId) && !state.chats.includes(legacyChat)) return;
  let suffix = "";
  let rule = state.messages.find(item => item.msg === message.text);
  if (!rule) {
    rule = state.messages.find(item => {
      if (!item.msg.startsWith("_command:")) return false;
      const prefix = item.msg.slice(9);
      if (!message.text.startsWith(prefix)) return false;
      suffix = message.text.slice(prefix.length);
      return !suffix || suffix.startsWith(" ");
    });
  }
  if (!rule) return;
  const replacement = rule.redirect
    ? rule.msg.startsWith("_command:") ? rule.redirect + suffix : rule.redirect
    : message.text;
  await context.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const raw = message.raw as any;
    if (!raw?.peerId) return;
    const sent = await client.sendMessage(raw.peerId, {
      message: replacement,
      replyTo: message.replyToId,
      topMsgId: message.topicId,
      ...(!rule!.redirect && replacement === message.text && Array.isArray(raw.entities)
        ? { formattingEntities: raw.entities } : {}),
    });
    signal.throwIfAborted();
    if (sent) await context.commands.dispatch(sent);
    signal.throwIfAborted();
    if (typeof raw.delete === "function") await raw.delete({ revoke: true });
    signal.throwIfAborted();
  });
}

async function handleCommand(invocation: any, context: PluginContext) {
  if (!(await requireOwner(invocation.message, context))) return;
  const state = normalize(await store(context).read());
  let [scope, action, value] = invocation.args;
  if (scope === "user") {
    scope = action;
    action = value;
  }
  if (scope === "add" || scope === "del") {
    return updateEntity(invocation, context, "user", scope, action);
  }
  if (scope === "chat" && (action === "add" || action === "del")) {
    return updateEntity(invocation, context, "chat", action, value);
  }
  if (scope === "msg") {
    if (action === "add") {
      const msg = rawTail(invocation, context, 2);
      if (msg) {
        await store(context).update(value => {
          const current = normalize(value);
          return current.messages.some(item => item.msg === msg) ? current : {
            ...current,
            messages: [...current.messages, { id: Math.max(0, ...current.messages.map(item => item.id)) + 1, msg }],
          };
        });
        await context.telegram.edit(invocation.message, "sure 消息规则已添加");
      }
      return;
    }
    if (action === "del" && /^\d+$/.test(value ?? "")) {
      await store(context).update(raw => {
        const current = normalize(raw);
        return { ...current, messages: current.messages.filter(item => item.id !== Number(value)) };
      });
      await context.telegram.edit(invocation.message, `sure 消息规则 #${value} 已删除`);
      return;
    }
    if (action === "redirect" && /^\d+$/.test(value ?? "")) {
      const redirect = rawTail(invocation, context, 3);
      let found = false;
      await store(context).update(raw => {
        const current = normalize(raw);
        return {
          ...current,
          messages: current.messages.map(item => {
            if (item.id !== Number(value)) return item;
            found = true;
            const next = { ...item };
            if (redirect) next.redirect = redirect;
            else delete next.redirect;
            return next;
          }),
        };
      });
      await context.telegram.edit(invocation.message, found
        ? redirect ? "sure 消息重定向已设置" : "sure 消息重定向已清除"
        : "消息规则不存在");
      return;
    }
    if (action === "ls" || action === "list") {
      const lines = state.messages.map(item =>
        `<code>${item.id}</code>: <code>${escape(item.msg)}</code>${item.redirect ? ` -&gt; <code>${escape(item.redirect)}</code>` : ""}`);
      return output(context, invocation.message, lines.length
        ? `消息白名单列表：\n${lines.join("\n")}`
        : "⚠️ 未设置消息白名单 需设置消息白名单方可使用");
    }
  }
  if (scope === "chat" && (action === "ls" || action === "list")) {
    const lines = state.chats.map(id => `- ${escape(state.chatNames[id] ?? id)}`);
    return output(context, invocation.message, lines.length
      ? `对话白名单列表：\n${lines.join("\n")}`
      : "⚠️ 未设置对话白名单, 所有对话中均可使用");
  }
  if (scope === "ls" || scope === "list") {
    const lines = state.users.map(id => `- ${escape(state.userNames[id] ?? id)}`);
    return output(context, invocation.message, lines.length
      ? `当前用户列表：\n${lines.join("\n")}` : "当前没有任何用户");
  }
  await output(context, invocation.message, renderPluginHelp(invocation.prefix));
}

export default function createSure() {
  requireSdkFeatures("commandDispatch");
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "sure",
    description: "管理 bot 代发消息的白名单规则",
    setup: migrate,
    commands: {
      sure: { description: "维护代发用户、对话和消息白名单", handle: handleCommand },
    },
    listeners: [{ edited: false, ignoreCommands: false, handle: relay }],
  });
}
