export type TaskType = "send" | "copy" | "forward" | "del" | "del_re" | "pin" | "unpin" | "cmd";

/**
 * `cron` is a Core runtime dependency, not a plugin-local module, and the
 * plugin tsconfig does not map it. Load it through a non-literal dynamic
 * import (same pattern as other V2 plugins) so esbuild keeps it external and
 * TypeScript does not try to resolve the specifier at build time.
 */
interface CronModule {
  validateCronExpression(expression: string): { valid: boolean; error?: string };
  CronTime: new (source: string, timeZone?: string) => { sendAt(): { toJSDate?: () => Date } | Date | null };
}
const CRON_MODULE = "cron";
/** The host registers jobs in this zone; next-run display must use the same one. */
export const CRON_TIME_ZONE = "Asia/Shanghai";
let cronModule: CronModule | undefined;
let cronLoading: Promise<CronModule | undefined> | undefined;

export async function ensureCron(): Promise<CronModule | undefined> {
  if (cronModule) return cronModule;
  cronLoading ??= import(CRON_MODULE).then(
    module => (cronModule = module as unknown as CronModule),
    () => undefined,
  );
  return cronLoading;
}

export interface Task {
  id: string;
  type: TaskType;
  cron: string;
  chat: string;
  chatId?: string;
  resolvedPeer?: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  disabled?: boolean;
  remark?: string;
  display?: string;
  message?: string;
  /** TL JSON of the replied message's Api.MessageEntity[] (send only). */
  entities?: unknown;
  replyTo?: string;
  fromChatId?: string;
  fromMsgId?: string;
  msgId?: string;
  limit?: string;
  regex?: string;
  notify?: boolean;
  pmOneSide?: boolean;
  delivery?: "pending" | "prepared" | "sent";
}

export interface State extends Record<string, unknown> {
  schemaVersion: number;
  seq: string;
  tasks: Task[];
}

export const TASK_TYPES: TaskType[] = ["send", "copy", "forward", "del", "del_re", "pin", "unpin", "cmd"];

/** Accepted `del_re` scan range. Creation enforces it and execution rejects out-of-range stored rows instead of clamping. */
export const DEL_RE_MAX_LIMIT = 1000;

export function createDefaults(): State {
  return { schemaVersion: 1, seq: "0", tasks: [] };
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const TYPE_LABELS: Record<TaskType, string> = {
  send: "发送",
  cmd: "命令",
  copy: "复制",
  forward: "转发",
  del: "删除",
  del_re: "正则删除",
  pin: "置顶",
  unpin: "取消置顶",
};

export const typeLabel = (type?: TaskType): string => (type ? TYPE_LABELS[type] : "");

/** Six whitespace-separated fields, matching the legacy fast check before registration validates the expression. */
export const hasSixCronFields = (value: string): boolean => value.trim().split(/\s+/).length === 6;

/** Restores the original behavior: only a valid six-field cron expression is accepted. */
export function validateCronExpr(expression: string): boolean {
  if (!hasSixCronFields(expression)) return false;
  // Before the module loads, the host's jobs.register is the final validator.
  if (!cronModule) return true;
  try {
    return cronModule.validateCronExpression(expression).valid;
  } catch {
    return false;
  }
}

export function nextRunTime(expression: string): Date | undefined {
  if (!cronModule) return undefined;
  try {
    const next = new cronModule.CronTime(expression, CRON_TIME_ZONE).sendAt();
    if (next && typeof (next as { toJSDate?: unknown }).toJSDate === "function") {
      return (next as { toJSDate: () => Date }).toJSDate();
    }
    if (next instanceof Date) return next;
    return undefined;
  } catch {
    return undefined;
  }
}

export function formatDate(date: Date): string {
  try {
    return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  } catch {
    return date.toISOString();
  }
}

/**
 * Original helper: strips the first `n + 1` whitespace-separated tokens from the
 * command's first line, preserving the remark's internal spacing.
 */
export function getRemarkFromMsg(line: string, n: number): string {
  return line.replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "").trim();
}

/** Original target split, including the full-width vertical bar. */
export function splitTarget(value: string): { chat: string; replyTo?: string } {
  const parts = value
    .split(/\s*[|｜]\s*/g)
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return { chat: parts[0] ?? "", ...(parts[1] ? { replyTo: parts[1] } : {}) };
}

export function parseBoolFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

export function parseRegexInput(value: string): { pattern: string; flags: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const last = trimmed.lastIndexOf("/");
    return { pattern: trimmed.slice(1, last), flags: trimmed.slice(last + 1) };
  }
  return { pattern: trimmed, flags: "" };
}

export function parseRegex(value: string): RegExp {
  const { pattern, flags } = parseRegexInput(value);
  return new RegExp(pattern, flags);
}

export function buildCopy(task: Task, prefix: string): string {
  const remark = task.remark ? ` ${task.remark}` : "";
  const reply = task.replyTo ? `|${task.replyTo}` : "";
  switch (task.type) {
    case "send":
      return `${prefix}acron send ${task.cron} ${task.chat}${reply}${remark}`;
    case "cmd":
      return `${prefix}acron cmd ${task.cron} ${task.chat}${reply}${remark}\n${task.message ?? ""}`;
    case "copy":
      return `${prefix}acron copy ${task.cron} ${task.chat}${reply}${remark}`;
    case "forward":
      return `${prefix}acron forward ${task.cron} ${task.chat}${reply}${remark}`;
    case "del":
      return `${prefix}acron del ${task.cron} ${task.chat} ${task.msgId}${remark}`;
    case "del_re":
      return `${prefix}acron del_re ${task.cron} ${task.chat} ${task.limit} ${task.regex}${remark}`;
    case "pin": {
      const notify = task.notify ? "1" : "0";
      const pmOneSide = task.pmOneSide ? "1" : "0";
      return `${prefix}acron pin ${task.cron} ${task.chat} ${task.msgId} ${notify} ${pmOneSide}${remark}`;
    }
    case "unpin":
      return `${prefix}acron unpin ${task.cron} ${task.chat} ${task.msgId}${remark}`;
    default:
      return `${prefix}acron`;
  }
}

export function buildCopyCommand(task: Task, prefix: string): string {
  const command = buildCopy(task, prefix);
  return command.includes("\n") ? `<pre>${escapeHtml(command)}</pre>` : `<code>${escapeHtml(command)}</code>`;
}

function linkFor(chat: string, messageId: string): string {
  const normalized = String(chat).replace("-100", "");
  return `<a href="https://t.me/c/${escapeHtml(normalized)}/${escapeHtml(messageId)}">${escapeHtml(messageId)}</a>`;
}

export interface ListRenderOptions {
  tasks: Task[];
  all: boolean;
  typeFilter?: TaskType;
  prefix: string;
  displayOf: (task: Task) => string;
}

export function renderTaskList(options: ListRenderOptions): string {
  const { tasks, all, typeFilter, prefix, displayOf } = options;
  if (tasks.length === 0) {
    if (all) return typeFilter ? `暂无类型为 ${typeLabel(typeFilter)} 的定时任务` : "暂无定时任务";
    return typeFilter ? `当前会话暂无类型为 ${typeLabel(typeFilter)} 的定时任务` : "当前会话暂无定时任务";
  }
  const header = all
    ? typeFilter
      ? `📋 所有 ${typeLabel(typeFilter)} 定时任务`
      : "📋 所有定时任务"
    : typeFilter
      ? `📋 当前会话 ${typeLabel(typeFilter)} 定时任务`
      : "📋 当前会话定时任务";
  const lines: string[] = [`<b>${header} · ${tasks.length} 个</b>`, ""];

  const title = (task: Task) =>
    `<code>${escapeHtml(task.id)}</code> • <code>${escapeHtml(typeLabel(task.type))}</code>${task.remark ? ` • ${escapeHtml(task.remark)}` : ""}`;
  const times = (task: Task) => {
    const result: string[] = [];
    if (task.lastRunAt) result.push(`上次: ${escapeHtml(formatDate(new Date(Number(task.lastRunAt))))}`);
    if (task.lastResult) result.push(`结果: ${escapeHtml(task.lastResult)}`);
    if (task.lastError) result.push(`错误: ${escapeHtml(task.lastError)}`);
    return result;
  };

  const enabled = tasks.filter(task => !task.disabled);
  const disabled = tasks.filter(task => task.disabled);

  if (enabled.length > 0) {
    lines.push("🔛 已启用:", "");
    for (const task of enabled) {
      lines.push(title(task));
      lines.push(`对话: ${displayOf(task)}`);
      if (task.msgId) lines.push(`消息: ${linkFor(task.chatId ?? task.chat, task.msgId)}`);
      if (task.fromChatId && task.fromMsgId) lines.push(`消息: ${linkFor(task.fromChatId, task.fromMsgId)}`);
      if (task.replyTo && ["send", "cmd", "copy", "forward"].includes(task.type)) {
        lines.push(`回复: ${linkFor(task.chatId ?? task.chat, task.replyTo)}`);
      }
      const next = nextRunTime(task.cron);
      if (next) lines.push(`下次: ${escapeHtml(formatDate(next))}`);
      lines.push(...times(task));
      lines.push(`复制: ${buildCopyCommand(task, prefix)}`);
      lines.push("");
    }
  }

  if (disabled.length > 0) {
    lines.push("⏹ 已禁用:", "");
    for (const task of disabled) {
      lines.push(title(task));
      lines.push(`对话: ${displayOf(task)}`);
      lines.push(...times(task));
      lines.push(`复制: ${buildCopyCommand(task, prefix)}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
