import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  renderCommandHelp,
  requireSdkFeatures,
  ui,
  type CommandDefinition,
  type CommandInvocation,
  type MessageEnvelope,
  type PluginContext,
  type SubcommandDefinition,
} from "telebox/sdk";
import { helpers } from "teleproto";

const MESSAGE_TYPES = new Set(["all", "text", "photo", "document", "video", "sticker", "animation", "voice", "audio"]);
const FLAGS = new Set(["silent", "handle_edited", ...MESSAGE_TYPES]);
const MAX_RULES = 200;
const MAX_PATTERNS = 40;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_BACKUP_MESSAGES = 10_000;
requireSdkFeatures("safeRegexp");

interface RuleStats {
  forwarded: number;
  failed: number;
  lastForwardedAt?: number;
}
interface ShiftRule {
  source: string;
  target: string;
  topicId?: number;
  sendAs?: string;
  options: string[];
  paused: boolean;
  filters: string[];
  whitelistEnabled: boolean;
  whitelistPatterns: string[];
  sourceDisplay: string;
  targetDisplay: string;
  createdAt: number;
  stats: RuleStats;
}
interface BackupTask {
  id: string;
  source: string;
  target: string;
  topicId?: number;
  order: "asc" | "desc";
  status: "pending" | "running" | "paused" | "completed" | "failed";
  processed: number;
  failed: number;
  cursor?: number;
  upperBound?: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}
interface State extends Record<string, unknown> {
  schemaVersion: 2;
  legacyImported?: boolean;
  rules: ShiftRule[];
  backups: Record<string, BackupTask>;
}
interface Runtime {
  albums: Map<string, { source: string; messages: Array<{ id: number; text: string }> }>;
  backups: Set<string>;
}

const defaults: State = { schemaVersion: 2, rules: [], backups: {} };
const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
const decimal = (value: unknown): string | undefined => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim().replace(/^(-?)0+(?=\d)/, "$1");
  if (value && typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    const text = String(value);
    if (/^-?\d+$/.test(text)) return helpers.returnBigInt(text).toString();
  }
  return undefined;
};
const entityLike = (value: string): string | ReturnType<typeof helpers.returnBigInt> =>
  /^-?\d+$/.test(value) ? helpers.returnBigInt(value) : value;

function store(context: PluginContext) {
  return context.storage.json<State>("state.json", defaults);
}

function validRegex(pattern: string): boolean {
  if (!pattern || pattern.length > 512) return false;
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

function cleanRule(value: any, sourceFallback?: string): ShiftRule | undefined {
  const source = decimal(value?.source ?? sourceFallback),
    target = decimal(value?.target ?? value?.target_id);
  if (!source || !target || source === target) return undefined;
  const rawOptions: string[] = Array.isArray(value?.options) ? value.options.map(String) : [];
  const options = rawOptions.filter(option => FLAGS.has(option));
  const topicValue = value?.topicId ?? rawOptions.find(option => option.startsWith("replyTo:"))?.slice(8);
  const topicId = Number(topicValue);
  const sendAs = decimal(value?.sendAs ?? rawOptions.find(option => option.startsWith("send-as="))?.slice(8));
  const filters: string[] = Array.isArray(value?.filters)
    ? value.filters
        .map(String)
        .map((item: string) => item.trim())
        .filter(Boolean)
        .slice(0, MAX_PATTERNS)
    : [];
  const patterns: string[] = Array.isArray(value?.whitelistPatterns)
    ? value.whitelistPatterns.map(String).filter(validRegex).slice(0, MAX_PATTERNS)
    : [];
  return {
    source,
    target,
    ...(Number.isSafeInteger(topicId) && topicId > 0 ? { topicId } : {}),
    ...(sendAs ? { sendAs } : {}),
    options: [...new Set(options.filter(option => FLAGS.has(option)))].length
      ? [...new Set(options.filter(option => FLAGS.has(option)))]
      : ["all"],
    paused: Boolean(value?.paused),
    filters,
    whitelistEnabled: Boolean(value?.whitelistEnabled ?? value?.whitelistMode),
    whitelistPatterns: patterns,
    sourceDisplay: String(value?.sourceDisplay ?? value?.source_display ?? source).slice(0, 100),
    targetDisplay: String(value?.targetDisplay ?? value?.target_display ?? target).slice(0, 100),
    createdAt: Number.isSafeInteger(Number(value?.createdAt))
      ? Number(value.createdAt)
      : Date.parse(String(value?.created_at ?? "")) || Date.now(),
    stats: {
      forwarded: Math.max(0, Number(value?.stats?.forwarded) || 0),
      failed: Math.max(0, Number(value?.stats?.failed) || 0),
      ...(Number.isFinite(Number(value?.stats?.lastForwardedAt))
        ? { lastForwardedAt: Number(value.stats.lastForwardedAt) }
        : {}),
    },
  };
}

function normalized(value: Partial<State>): State {
  const seen = new Set<string>();
  const rules = (Array.isArray(value.rules) ? value.rules : [])
    .map(item => cleanRule(item))
    .filter((item): item is ShiftRule => !!item)
    .filter(item => !seen.has(item.source) && !!seen.add(item.source))
    .slice(0, MAX_RULES);
  const backups: Record<string, BackupTask> = {};
  if (value.backups && typeof value.backups === "object")
    for (const [id, item] of Object.entries(value.backups)) {
      const raw: any = item;
      const source = decimal(raw?.source ?? raw?.sourceId),
        target = decimal(raw?.target ?? raw?.targetId);
      if (!/^[a-z0-9-]{1,80}$/i.test(id) || !source || !target) continue;
      const startedAt = Date.parse(String(raw.startedAt ?? "")),
        completedAt = Date.parse(String(raw.completedAt ?? ""));
      backups[id] = {
        id,
        source,
        target,
        order: raw.order === "asc" || raw.reverse === true ? "asc" : "desc",
        status: ["pending", "running", "paused", "completed", "failed"].includes(raw.status) ? raw.status : "failed",
        processed: Math.max(0, Number(raw.processed ?? raw.processedMessages) || 0),
        failed: Math.max(0, Number(raw.failed ?? raw.failedMessages) || 0),
        createdAt: Number(raw.createdAt) || startedAt || Date.now(),
        ...(Number.isSafeInteger(Number(raw.topicId)) && Number(raw.topicId) > 0
          ? { topicId: Number(raw.topicId) }
          : {}),
        ...(Number.isSafeInteger(Number(raw.cursor ?? raw.lastMessageId)) && Number(raw.cursor ?? raw.lastMessageId) > 0
          ? { cursor: Number(raw.cursor ?? raw.lastMessageId) }
          : {}),
        ...(Number.isSafeInteger(Number(raw.upperBound)) && Number(raw.upperBound) > 0
          ? { upperBound: Number(raw.upperBound) }
          : {}),
        ...(Number.isFinite(Number(raw.completedAt))
          ? { completedAt: Number(raw.completedAt) }
          : completedAt
            ? { completedAt }
            : {}),
        ...(raw.error ? { error: String(raw.error).slice(0, 240) } : {}),
      };
    }
  return { ...value, schemaVersion: 2, ...(value.legacyImported ? { legacyImported: true } : {}), rules, backups };
}

function legacyStats(rules: ShiftRule[], raw: unknown): ShiftRule[] {
  if (!raw || typeof raw !== "object") return rules;
  return rules.map(rule => {
    let forwarded = rule.stats.forwarded,
      lastForwardedAt = rule.stats.lastForwardedAt;
    for (const [date, sources] of Object.entries(raw as Record<string, unknown>)) {
      if (!sources || typeof sources !== "object") continue;
      const daily = (sources as Record<string, any>)[rule.source];
      if (!daily || typeof daily !== "object") continue;
      forwarded += Math.max(0, Number(daily.total) || 0);
      const stamp = Date.parse(date);
      if (Number.isFinite(stamp) && (!lastForwardedAt || stamp > lastForwardedAt)) lastForwardedAt = stamp;
    }
    return { ...rule, stats: { ...rule.stats, forwarded, ...(lastForwardedAt ? { lastForwardedAt } : {}) } };
  });
}

async function sqliteLegacy(context: PluginContext): Promise<Record<string, unknown> | undefined> {
  try {
    return await context.storage.sqlite("shift.db", { mustExist: true }).read(db => {
      const rows = db.prepare("SELECT * FROM shift_rules").safeIntegers(true).all() as any[];
      const statRows = db.prepare("SELECT * FROM shift_stats").safeIntegers(true).all() as any[];
      const rules: Record<string, unknown> = {},
        stats: Record<string, Record<string, unknown>> = {};
      for (const row of rows)
        rules[String(row.source_id)] = {
          target_id: row.target_id,
          options: JSON.parse(row.options || "[]"),
          target_type: row.target_type,
          paused: row.paused === 1n,
          created_at: row.created_at,
          filters: JSON.parse(row.filters || "[]"),
        };
      for (const row of statRows) {
        const parts = String(row.stats_key).split(".");
        if (parts.length < 4) continue;
        (stats[parts[3]!] ??= {})[parts[2]!] = JSON.parse(row.stats_data);
      }
      return { rules, stats, backups: {} };
    }, context.signal);
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function state(context: PluginContext): Promise<State> {
  return normalized(await store(context).read());
}
async function update(context: PluginContext, change: (value: State) => State): Promise<State> {
  return store(context).update(current => normalized(change(normalized(current))));
}
async function stateDocument(context: PluginContext): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(
      await readFile(context.files.dataPath("state.json"), { encoding: "utf8", signal: context.signal }),
    );
    context.signal.throwIfAborted();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shift state");
    return value;
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new Error("SHIFT_STATE_INVALID");
  }
}

async function deliverLines(
  context: PluginContext,
  message: MessageEnvelope,
  lines: readonly string[],
  html = false,
): Promise<void> {
  const source = (lines.length ? lines : ["无"]).map(line => (html ? line : ui.text(line))).join("\n");
  const rendered = await ui.renderRichText(source, ui.PAGE_LABEL_RESERVE);
  const pages = rendered.map((page, index) => page + ui.pageLabel(index, rendered.length));
  const result = await ui.deliverPages(pages, context.signal, (value, index) =>
    index
      ? context.telegram.reply(message, value, { parseMode: "html" })
      : context.telegram.edit(message, value, { parseMode: "html" }),
  );
  if (!result.interrupted) return;
  context.log.info("shift_pagination_interrupted", {
    published: result.published,
    total: result.total,
    category: ui.deliveryErrorCategory(result.error),
  });
  if (!result.published) throw result.error;
  try {
    await context.telegram.reply(message, ui.interruptedNotice(result), { parseMode: "html" });
  } catch {}
}

function markedEntity(entity: any): string | undefined {
  const id = decimal(entity?.id);
  if (!id) return undefined;
  if (entity?.className === "Channel") return `-100${id.replace(/^-/, "")}`;
  if (entity?.className === "Chat") return `-${id.replace(/^-/, "")}`;
  return id;
}

async function resolvePeer(
  context: PluginContext,
  token: string,
  current: MessageEnvelope,
): Promise<{ id: string; display: string }> {
  const here = ["here", "me", "this"].includes(token.toLowerCase());
  if (here) return { id: current.chatId, display: current.chatId };
  return context.telegram.withClient(async (client: any, signal) => {
    signal.throwIfAborted();
    const input = entityLike(token);
    const entity = await client.getEntity(input);
    signal.throwIfAborted();
    const id = markedEntity(entity) ?? decimal(token);
    if (!id) throw new Error(`无法解析会话：${token}`);
    const name =
      entity?.title ||
      [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") ||
      (entity?.username ? `@${entity.username}` : id);
    return { id, display: String(name).slice(0, 100) };
  });
}

function parseTarget(value: string): { token: string; topicId?: number } {
  const [token, topic] = value.split(/[|｜]/, 2).map(item => item.trim());
  if (!token) throw new Error("目标会话不能为空");
  if (!topic) return { token };
  const topicId = Number(topic);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("话题 ID 必须是正整数");
  return { token, topicId };
}

function typeOf(message: MessageEnvelope): string {
  const raw: any = message.raw;
  if (raw?.photo) return "photo";
  if (raw?.sticker) return "sticker";
  if (raw?.video) return "video";
  if (raw?.gif || String(raw?.document?.mimeType ?? "") === "image/gif") return "animation";
  if (raw?.voice) return "voice";
  if (raw?.audio) return "audio";
  if (raw?.document || raw?.media) return "document";
  return "text";
}

function admitsType(rule: ShiftRule, message: MessageEnvelope): boolean {
  if (rule.paused || (message.edited && !rule.options.includes("handle_edited"))) return false;
  const type = typeOf(message);
  if (!rule.options.includes("all") && !rule.options.includes(type)) return false;
  return true;
}

async function admitsContent(rule: ShiftRule, textValue: string, context: PluginContext): Promise<boolean> {
  if (rule.whitelistEnabled) {
    if (!rule.whitelistPatterns.length) return false;
    let matched = false;
    for (const pattern of rule.whitelistPatterns) {
      const result = await context.regexp.test(pattern, textValue, { flags: "i" }, context.signal);
      context.signal.throwIfAborted();
      if (result.matched && !result.timedOut) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
    return true;
  }
  const text = textValue.toLocaleLowerCase();
  if (rule.filters.some(value => text.includes(value.toLocaleLowerCase()))) return false;
  return true;
}

function groupId(raw: any): string | undefined {
  return decimal(raw?.groupedId ?? raw?.grouped_id);
}

async function record(context: PluginContext, source: string, success: number, failed: number): Promise<void> {
  context.signal.throwIfAborted();
  await update(context, value => ({
    ...value,
    rules: value.rules.map(rule =>
      rule.source === source
        ? {
            ...rule,
            stats: {
              ...rule.stats,
              forwarded: rule.stats.forwarded + success,
              failed: rule.stats.failed + failed,
              ...(success ? { lastForwardedAt: Date.now() } : {}),
            },
          }
        : rule,
    ),
  }));
  context.signal.throwIfAborted();
}

async function forward(context: PluginContext, rule: ShiftRule, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  try {
    await context.telegram.withClient(async (client: any, signal) => {
      signal.throwIfAborted();
      await client.forwardMessages(entityLike(rule.target), {
        messages: [...ids],
        fromPeer: entityLike(rule.source),
        silent: rule.options.includes("silent"),
        ...(rule.topicId ? { topMsgId: rule.topicId } : {}),
        ...(rule.sendAs ? { sendAs: entityLike(rule.sendAs) } : {}),
      });
      signal.throwIfAborted();
    });
    context.signal.throwIfAborted();
    await record(context, rule.source, ids.length, 0);
  } catch (error) {
    context.signal.throwIfAborted();
    await record(context, rule.source, 0, ids.length);
    throw error;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function onMessage(runtime: Runtime, message: MessageEnvelope, context: PluginContext): Promise<void> {
  const rule = (await state(context)).rules.find(item => item.source === message.chatId);
  if (!rule || !admitsType(rule, message)) return;
  const grouped = groupId(message.raw);
  if (!grouped) {
    if (await admitsContent(rule, message.text, context)) await forward(context, rule, [message.id]);
    return;
  }
  const key = `${rule.source}:${grouped}`;
  const pending = runtime.albums.get(key);
  if (pending) {
    if (!pending.messages.some(item => item.id === message.id))
      pending.messages.push({ id: message.id, text: message.text });
    return;
  }
  runtime.albums.set(key, { source: rule.source, messages: [{ id: message.id, text: message.text }] });
  void context.tasks
    .run(`shift-album:${key}`, async signal => {
      try {
        await delay(900, signal);
        const current = runtime.albums.get(key);
        runtime.albums.delete(key);
        if (!current) return;
        const latest = (await state(context)).rules.find(item => item.source === current.source);
        if (!latest || latest.paused) return;
        let admitted = false;
        for (const item of current.messages)
          if (await admitsContent(latest, item.text, context)) {
            admitted = true;
            break;
          }
        if (!admitted) return;
        await forward(
          context,
          latest,
          current.messages.map(item => item.id).sort((left, right) => left - right),
        );
      } finally {
        runtime.albums.delete(key);
      }
    })
    .catch(() => {
      if (!context.signal.aborted) context.log.error("shift_album_failed");
    });
}

function indices(input: string, length: number): number[] {
  const selected = new Set<number>();
  for (const part of input.split(",")) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error("规则序号格式无效");
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > length || end - start > MAX_RULES) throw new Error("规则序号超出范围");
    for (let value = start; value <= end; value++) selected.add(value - 1);
  }
  return [...selected].sort((left, right) => left - right);
}

function wouldLoop(rules: readonly ShiftRule[], source: string, target: string): boolean {
  let current = target;
  const visited = new Set([source]);
  while (true) {
    if (visited.has(current)) return true;
    visited.add(current);
    const next = rules.find(rule => rule.source === current)?.target;
    if (!next) return false;
    current = next;
  }
}

async function exportRules(invocation: CommandInvocation, context: PluginContext): Promise<void> {
  const current = await state(context);
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 2, rules: current.rules }, null, 2)).toString("base64");
  if (payload.length <= 3500) {
    await context.telegram.edit(invocation.message, payload);
    return;
  }
  await context.files.withTemp(async (directory, signal) => {
    const file = path.join(directory, "shift-rules.txt");
    await writeFile(file, payload, { mode: 0o600, signal });
    await context.telegram.withClient(async (client: any, clientSignal) => {
      const combined = AbortSignal.any([signal, clientSignal]);
      combined.throwIfAborted();
      const raw: any = invocation.message.raw;
      if (!raw?.peerId) throw new Error("无法确定发送会话");
      await client.sendFile(raw.peerId, {
        file,
        caption: `Shift 规则导出：${current.rules.length} 条`,
        replyTo: invocation.message.id,
      });
      combined.throwIfAborted();
    });
  });
}

function decodeImport(invocation: CommandInvocation): unknown {
  const body = invocation.message.text.split(/\r?\n/).slice(1).join("\n").trim();
  if (!body) throw new Error("请在命令下一行粘贴 Base64 或 JSON 数据");
  if (Buffer.byteLength(body) > MAX_IMPORT_BYTES) throw new Error("导入数据超过 256 KiB");
  try {
    return JSON.parse(body);
  } catch {
    const decoded = Buffer.from(body, "base64").toString("utf8");
    if (Buffer.byteLength(decoded) > MAX_IMPORT_BYTES) throw new Error("导入数据超过 256 KiB");
    return JSON.parse(decoded);
  }
}

function parseImport(value: any): ShiftRule[] {
  const rawRules = Array.isArray(value?.rules)
    ? value.rules
    : value && typeof value === "object"
      ? Object.entries(value).map(([source, rule]) => ({ ...(rule as any), source }))
      : [];
  if (!rawRules.length || rawRules.length > MAX_RULES) throw new Error(`规则数量必须为 1-${MAX_RULES}`);
  const rules: Array<ShiftRule | undefined> = rawRules.map((item: any) => cleanRule(item));
  if (rules.some((item: ShiftRule | undefined) => !item)) throw new Error("导入数据包含无效会话 ID 或规则");
  const result = rules as ShiftRule[];
  if (new Set(result.map(rule => rule.source)).size !== result.length) throw new Error("导入数据包含重复源会话");
  for (const rule of result)
    if (
      wouldLoop(
        result.filter(item => item !== rule),
        rule.source,
        rule.target,
      )
    )
      throw new Error("导入规则会形成转发循环");
  return result;
}

async function runBackup(runtime: Runtime, context: PluginContext, id: string): Promise<void> {
  if (runtime.backups.has(id)) return;
  runtime.backups.add(id);
  try {
    await update(context, value => ({
      ...value,
      backups: { ...value.backups, [id]: { ...value.backups[id]!, status: "running", error: undefined } },
    }));
    const task = (await state(context)).backups[id];
    if (!task) return;
    await context.telegram.withClient(async (client: any, signal) => {
      let cursor = task.cursor ?? 0,
        processed = task.processed,
        failed = task.failed;
      if (task.order === "asc") {
        const collected: number[] = [];
        let pageCursor = 0,
          upperBound = task.upperBound;
        while (collected.length < MAX_BACKUP_MESSAGES) {
          signal.throwIfAborted();
          const values: any[] = await client.getMessages(entityLike(task.source), { limit: 100, offsetId: pageCursor });
          signal.throwIfAborted();
          if (!values?.length) break;
          const pageIds = values.map(item => Number(item.id)).filter(Number.isSafeInteger);
          if (!pageIds.length) break;
          pageCursor = pageIds.at(-1)!;
          if (!upperBound) {
            upperBound = Math.max(...pageIds);
            await update(context, value => ({
              ...value,
              backups: { ...value.backups, [id]: { ...value.backups[id]!, upperBound } },
            }));
          }
          collected.push(
            ...pageIds.filter(value => value <= upperBound!).slice(0, MAX_BACKUP_MESSAGES - collected.length),
          );
          if (values.length < 100) break;
        }
        const ordered = collected.reverse();
        for (let offset = Math.min(processed + failed, ordered.length); offset < ordered.length; offset += 100) {
          signal.throwIfAborted();
          const ids = ordered.slice(offset, offset + 100);
          try {
            await client.forwardMessages(entityLike(task.target), {
              messages: ids,
              fromPeer: entityLike(task.source),
              ...(task.topicId ? { topMsgId: task.topicId } : {}),
            });
            signal.throwIfAborted();
            processed += ids.length;
          } catch {
            signal.throwIfAborted();
            failed += ids.length;
          }
          await update(context, value => ({
            ...value,
            backups: { ...value.backups, [id]: { ...value.backups[id]!, upperBound, processed, failed } },
          }));
          await delay(300, signal);
        }
      } else
        while (processed + failed < MAX_BACKUP_MESSAGES) {
          signal.throwIfAborted();
          const values: any[] = await client.getMessages(entityLike(task.source), {
            limit: Math.min(100, MAX_BACKUP_MESSAGES - processed - failed),
            offsetId: cursor,
          });
          signal.throwIfAborted();
          if (!values?.length) break;
          const ids = values.map(item => Number(item.id)).filter(Number.isSafeInteger);
          if (!ids.length) break;
          cursor = ids.at(-1)!;
          try {
            await client.forwardMessages(entityLike(task.target), {
              messages: ids,
              fromPeer: entityLike(task.source),
              ...(task.topicId ? { topMsgId: task.topicId } : {}),
            });
            signal.throwIfAborted();
            processed += ids.length;
          } catch {
            signal.throwIfAborted();
            failed += ids.length;
          }
          await update(context, value => ({
            ...value,
            backups: { ...value.backups, [id]: { ...value.backups[id]!, cursor, processed, failed } },
          }));
          await delay(300, signal);
        }
      await update(context, value => ({
        ...value,
        backups: {
          ...value.backups,
          [id]: { ...value.backups[id]!, status: "completed", processed, failed, cursor, completedAt: Date.now() },
        },
      }));
    });
  } catch (error) {
    if (!context.signal.aborted)
      await update(context, value => ({
        ...value,
        backups: { ...value.backups, [id]: { ...value.backups[id]!, status: "failed", error: "BACKUP_FAILED" } },
      }));
  } finally {
    runtime.backups.delete(id);
  }
}

function startBackup(runtime: Runtime, context: PluginContext, id: string): void {
  void context.tasks
    .run(`shift-backup:${id}`, () => runBackup(runtime, context, id))
    .catch(() => {
      if (!context.signal.aborted) context.log.error("shift_backup_failed");
    });
}

export default function createShift() {
  const runtime: Runtime = { albums: new Map(), backups: new Set() };
  let help!: (prefix: string) => string;
  const showHelp: CommandDefinition["handle"] = (invocation, context) =>
    context.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });
  const command: CommandDefinition = {
    description: "按规则转发会话消息",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    subcommandsCaseSensitive: false,
    subcommands: {
      set: {
        description: "新增或替换转发规则",
        aliases: ["s"],
        args: "[源] [目标|话题ID] [选项]",
        arguments: [
          { name: "会话", description: "只给一个会话时以当前对话为源；ID 始终按十进制字符串保存" },
          {
            name: "选项",
            description:
              "all/text/photo/document/video/sticker/animation/voice/audio、silent、handle_edited、send-as=会话",
          },
        ],
        examples: [{ args: "set @target all silent" }, { args: "set @source @target|123 photo video" }],
        async handle(invocation, context) {
          const args = [...invocation.args];
          if (!args.length) throw new Error("请提供目标会话");
          const secondIsOption =
            args[1] !== undefined && (FLAGS.has(args[1].toLowerCase()) || args[1].toLowerCase().startsWith("send-as="));
          const currentSource = args.length === 1 || secondIsOption;
          const sourceToken = currentSource ? "here" : args.shift()!;
          const targetSpec = parseTarget(args.shift()!);
          const optionTokens = args.map(value => value.toLowerCase());
          for (const value of optionTokens)
            if (!FLAGS.has(value) && !value.startsWith("send-as=")) throw new Error(`无效选项：${value}`);
          const typeOptions = optionTokens.filter(value => MESSAGE_TYPES.has(value));
          const options = [
            ...new Set([...optionTokens.filter(value => FLAGS.has(value)), ...(typeOptions.length ? [] : ["all"])]),
          ];
          const source = await resolvePeer(context, sourceToken, invocation.message);
          const target = await resolvePeer(context, targetSpec.token, invocation.message);
          const sendAsToken = optionTokens.find(value => value.startsWith("send-as="))?.slice(8);
          const sendAs = sendAsToken ? await resolvePeer(context, sendAsToken, invocation.message) : undefined;
          await update(context, value => {
            const existing = value.rules.find(rule => rule.source === source.id);
            const others = value.rules.filter(rule => rule.source !== source.id);
            if (!existing && others.length >= MAX_RULES) throw new Error(`规则最多 ${MAX_RULES} 条`);
            if (wouldLoop(others, source.id, target.id)) throw new Error("该规则会形成转发循环");
            const rule: ShiftRule = {
              source: source.id,
              target: target.id,
              ...(targetSpec.topicId ? { topicId: targetSpec.topicId } : {}),
              ...(sendAs ? { sendAs: sendAs.id } : {}),
              options,
              paused: false,
              filters: existing?.filters ?? [],
              whitelistEnabled: existing?.whitelistEnabled ?? false,
              whitelistPatterns: existing?.whitelistPatterns ?? [],
              sourceDisplay: source.display,
              targetDisplay: target.display,
              createdAt: existing?.createdAt ?? Date.now(),
              stats: existing?.stats ?? { forwarded: 0, failed: 0 },
            };
            return { ...value, rules: [...others, rule] };
          });
          await context.telegram.edit(
            invocation.message,
            `已保存转发规则：${source.display} → ${target.display}${targetSpec.topicId ? `（话题 ${targetSpec.topicId}）` : ""}`,
          );
        },
      },
      list: {
        description: "列出转发规则",
        aliases: ["ls"],
        args: "",
        async handle(invocation, context) {
          const rules = (await state(context)).rules;
          const lines = rules.map(
            (rule, index) =>
              `${index + 1}. ${rule.paused ? "⏸" : "▶️"} <code>${escape(rule.source)}</code> → <code>${escape(rule.target)}</code>${rule.topicId ? ` | 话题 ${rule.topicId}` : ""}\n   ${escape(rule.options.join(", "))} | 成功 ${rule.stats.forwarded} / 失败 ${rule.stats.failed}`,
          );
          await deliverLines(context, invocation.message, lines.length ? lines : ["尚无转发规则"], true);
        },
      },
      del: selection("删除", (rules, selected) => rules.filter(rule => !selected.has(rule.source))),
      pause: selection("暂停", (rules, selected) =>
        rules.map(rule => (selected.has(rule.source) ? { ...rule, paused: true } : rule)),
      ),
      resume: selection("恢复", (rules, selected) =>
        rules.map(rule => (selected.has(rule.source) ? { ...rule, paused: false } : rule)),
      ),
      stats: {
        description: "查看转发统计",
        args: "",
        async handle(invocation, context) {
          const rules = (await state(context)).rules;
          await context.telegram.edit(
            invocation.message,
            `规则：${rules.length}\n已启用：${rules.filter(rule => !rule.paused).length}\n成功转发：${rules.reduce((sum, rule) => sum + rule.stats.forwarded, 0)}\n失败：${rules.reduce((sum, rule) => sum + rule.stats.failed, 0)}`,
          );
        },
      },
      filter: patternCommand("关键词过滤", "filters", false),
      whitelist: patternCommand("正则白名单", "whitelistPatterns", true),
      export: { description: "导出规则为 Base64", args: "", handle: exportRules },
      import: {
        description: "从下一行导入 Base64 或 JSON 规则",
        args: "\\n[数据]",
        async handle(invocation, context) {
          const rules = parseImport(decodeImport(invocation));
          await update(context, value => ({ ...value, rules }));
          await context.telegram.edit(invocation.message, `已导入 ${rules.length} 条规则`);
        },
      },
      clean: {
        description: "清理无效规则和备份记录",
        args: "",
        async handle(invocation, context) {
          if (invocation.args.length) throw new Error("clean 不接受参数");
          const raw = await store(context).read();
          const cleaned = normalized(raw);
          const removed =
            Math.max(0, (Array.isArray(raw.rules) ? raw.rules.length : 0) - cleaned.rules.length) +
            Math.max(
              0,
              Object.keys(raw.backups && typeof raw.backups === "object" ? raw.backups : {}).length -
                Object.keys(cleaned.backups).length,
            );
          await store(context).update(() => cleaned);
          await context.telegram.edit(invocation.message, `清理完成：移除 ${removed} 条无效记录`);
        },
      },
      backup: {
        description: "启动历史消息备份",
        args: "[源] [目标|话题ID] [--asc]",
        subcommands: {
          status: {
            description: "查看备份任务",
            args: "[任务ID]",
            async handle(invocation, context) {
              const backups = (await state(context)).backups;
              const selected = invocation.args[0]
                ? [backups[invocation.args[0]]].filter(Boolean)
                : Object.values(backups);
              await deliverLines(
                context,
                invocation.message,
                selected.length
                  ? selected.map(task => `${task!.id}: ${task!.status}，成功 ${task!.processed}，失败 ${task!.failed}`)
                  : ["没有备份任务"],
              );
            },
          },
          resume: {
            description: "恢复未完成的备份任务",
            args: "[任务ID]",
            async handle(invocation, context) {
              const id = invocation.args[0],
                task = id ? (await state(context)).backups[id] : undefined;
              if (!task || ["completed", "running"].includes(task.status)) throw new Error("任务不存在或无需恢复");
              await update(context, value => ({
                ...value,
                backups: { ...value.backups, [id!]: { ...task, status: "pending", error: undefined } },
              }));
              startBackup(runtime, context, id!);
              await context.telegram.edit(invocation.message, `备份任务 ${id} 已恢复`);
            },
          },
        },
        async handle(invocation, context) {
          if (invocation.args.length < 2) throw new Error("请提供源会话和目标会话");
          if (invocation.args.length > 3 || (invocation.args[2] && invocation.args[2] !== "--asc"))
            throw new Error("备份仅支持可选参数 --asc");
          const source = await resolvePeer(context, invocation.args[0]!, invocation.message);
          const targetSpec = parseTarget(invocation.args[1]!);
          const target = await resolvePeer(context, targetSpec.token, invocation.message);
          if (source.id === target.id) throw new Error("备份源会话与目标会话不能相同");
          const order = invocation.args.includes("--asc") ? "asc" : "desc";
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const task: BackupTask = {
            id,
            source: source.id,
            target: target.id,
            ...(targetSpec.topicId ? { topicId: targetSpec.topicId } : {}),
            order,
            status: "pending",
            processed: 0,
            failed: 0,
            createdAt: Date.now(),
          };
          await update(context, value => ({ ...value, backups: { ...value.backups, [id]: task } }));
          startBackup(runtime, context, id);
          await context.telegram.edit(invocation.message, `备份任务已启动：${id}（上限 ${MAX_BACKUP_MESSAGES} 条）`);
        },
      },
    },
    help: [
      {
        heading: "规则与类型：",
        body: "每个源会话保留一条规则，支持文字及常见媒体类型、静默转发、编辑消息、目标话题和 send-as。创建与导入时拒绝直接或链式循环。相册会短暂聚合后整组转发。",
      },
      {
        heading: "过滤与生命周期：",
        body: "filter 按关键词包含匹配；whitelist 保留合法 JavaScript 正则语义，并由 SDK worker 按每个表达式最多 512 字符、输入最多 4096 字符、单次 50ms 的预算执行。动态相册和备份都由插件任务作用域跟踪，卸载时可取消；备份最多处理 10000 条。",
      },
      {
        heading: "导入格式：",
        body: "export 输出 Base64；import 要求把 Base64 或 JSON 放在命令下一行。所有 Telegram ID 均以十进制字符串存储。",
      },
    ],
    handle: showHelp,
  };
  const safeCommand = protect(command);
  help = (prefix: string) => renderCommandHelp("shift", safeCommand, { prefix, title: "🔀 会话转发" });
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "shift",
    description: "按规则转发会话消息并执行历史备份",
    renderHelp: help,
    commands: { shift: safeCommand },
    listeners: [
      {
        ignoreCommands: true,
        edited: true,
        includeSaved: true,
        handle: (message, context) => onMessage(runtime, message, context),
      },
    ],
    async setup(context) {
      const document = await stateDocument(context);
      const current = await state(context);
      if (!current.legacyImported) {
        const lowdb = await context.storage.json<Record<string, unknown>>("shift_v2.json", {}).read();
        context.signal.throwIfAborted();
        const legacy = Object.keys(lowdb).length ? lowdb : ((await sqliteLegacy(context)) ?? {});
        context.signal.throwIfAborted();
        const rawRules =
          (legacy as any).rules && typeof (legacy as any).rules === "object"
            ? Object.entries((legacy as any).rules).map(([source, rule]) => ({ ...(rule as any), source }))
            : [];
        const imported = legacyStats(
          rawRules
            .map((item: any) => cleanRule(item))
            .filter((item: ShiftRule | undefined): item is ShiftRule => !!item)
            .slice(0, MAX_RULES),
          (legacy as any).stats,
        );
        await update(context, value => ({
          ...legacy,
          ...value,
          legacyImported: true,
          rules: document && Object.hasOwn(document, "rules") ? value.rules : imported,
          backups:
            document && Object.hasOwn(document, "backups") ? value.backups : ((legacy as any).backups ?? value.backups),
        }));
      }
      await update(context, value => ({
        ...value,
        backups: Object.fromEntries(
          Object.entries(value.backups).map(([id, task]) => [
            id,
            task.status === "running" ? { ...task, status: "paused", error: "插件曾卸载；请手动恢复" } : task,
          ]),
        ),
      }));
    },
    cleanup() {
      runtime.albums.clear();
      runtime.backups.clear();
    },
  });

  function selection(
    label: string,
    change: (rules: ShiftRule[], selected: ReadonlySet<string>) => ShiftRule[],
  ): SubcommandDefinition {
    return {
      description: `${label}指定规则`,
      ...(label === "删除" ? { aliases: ["delete", "d"] } : {}),
      args: "[序号或范围]",
      examples: [{ args: `${label === "删除" ? "del" : label === "暂停" ? "pause" : "resume"} 1,3-5` }],
      async handle(invocation, context) {
        const current = await state(context),
          positions = indices(invocation.args[0] ?? "", current.rules.length);
        const selected = new Set(positions.map(index => current.rules[index]!.source));
        let applied = 0;
        await update(context, value => {
          const existing = new Set(value.rules.filter(rule => selected.has(rule.source)).map(rule => rule.source));
          applied = existing.size;
          return { ...value, rules: change(value.rules, existing) };
        });
        if (applied !== selected.size) throw new Error("部分规则已被并发修改，请刷新列表后重试");
        await context.telegram.edit(invocation.message, `已${label} ${applied} 条规则`);
      },
    };
  }

  function patternCommand(
    label: string,
    key: "filters" | "whitelistPatterns",
    whitelist: boolean,
  ): SubcommandDefinition {
    return {
      description: `管理${label}`,
      aliases: whitelist ? ["wl"] : ["f"],
      args: "[规则序号] [add|del|list|enable|disable] [内容]",
      examples: [{ args: `${whitelist ? "whitelist" : "filter"} 1 add ${whitelist ? "^公告" : "关键字"}` }],
      async handle(invocation, context) {
        const current = await state(context),
          positions = indices(invocation.args[0] ?? "", current.rules.length),
          action = invocation.args[1]?.toLowerCase(),
          content = invocation.args.slice(2).join(" ").trim();
        const selected = new Set(positions.map(index => current.rules[index]!.source));
        if (action === "list") {
          await deliverLines(
            context,
            invocation.message,
            positions.map(index => `${index + 1}: ${current.rules[index]![key].join(" | ") || "空"}`),
          );
          return;
        }
        if (whitelist && ["enable", "disable"].includes(action ?? "")) {
          await update(context, value => ({
            ...value,
            rules: value.rules.map(rule =>
              selected.has(rule.source) ? { ...rule, whitelistEnabled: action === "enable" } : rule,
            ),
          }));
          await context.telegram.edit(invocation.message, `正则白名单已${action === "enable" ? "启用" : "停用"}`);
          return;
        }
        if (!["add", "del"].includes(action ?? "") || !content) throw new Error("请指定 add/del 和内容");
        if (whitelist ? !validRegex(content) : Buffer.byteLength(content) > 240)
          throw new Error(whitelist ? "正则无效或超过 512 字符" : "关键词过长");
        await update(context, value => ({
          ...value,
          rules: value.rules.map(rule => {
            if (!selected.has(rule.source)) return rule;
            const list = [...rule[key]],
              position = list.indexOf(content);
            if (action === "add" && position < 0) {
              if (list.length >= MAX_PATTERNS) throw new Error(`每条规则最多 ${MAX_PATTERNS} 项`);
              list.push(content);
            }
            if (action === "del" && position >= 0) list.splice(position, 1);
            return { ...rule, [key]: list };
          }),
        }));
        await context.telegram.edit(invocation.message, `${label}已更新`);
      },
    };
  }

  function protect<T extends CommandDefinition | SubcommandDefinition>(definition: T): T {
    const original = definition.handle;
    const children = definition.subcommands
      ? Object.fromEntries(Object.entries(definition.subcommands).map(([name, child]) => [name, protect(child)]))
      : undefined;
    return {
      ...definition,
      ...(children ? { subcommands: children } : {}),
      async handle(invocation: CommandInvocation, context: PluginContext) {
        try {
          await original(invocation, context);
        } catch (error) {
          if (context.signal.aborted) return;
          context.log.error("shift_command_failed");
          const branch = invocation.subcommands?.[0] ?? invocation.subcommand;
          const detail =
            branch === "set"
              ? "规则设置失败，请检查会话、选项和循环关系"
              : branch === "whitelist"
                ? "正则无效或白名单参数错误"
                : branch === "backup"
                  ? "备份参数无效，源会话与目标会话不能相同"
                  : branch === "import"
                    ? "导入数据无效"
                    : "请检查命令参数";
          await context.telegram.edit(invocation.message, `Shift 操作失败：${detail}`);
        }
      },
    } as T;
  }
}
