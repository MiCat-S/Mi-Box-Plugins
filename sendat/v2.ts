import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import { returnBigInt } from "teleproto/Helpers";

interface Task {
  task_id: number;
  cid: string;
  msg: string;
  sourceMsg?: string;
  interval: boolean;
  cron: boolean;
  pause: boolean;
  time_limit: number;
  hour: string;
  minute: string;
  second: string;
  current_count: number;
  dueAt?: string;
  delivery?: "pending" | "prepared" | "sent";
}
interface State extends Record<string, unknown> {
  schemaVersion: number;
  tasks: Task[];
  timezone: string;
}
const defaults: State = { schemaVersion: 1, tasks: [], timezone: "Asia/Shanghai" };
class InputError extends Error {}
const escape = (value: string) =>
  value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const help = (prefix: string) =>
  `<b>定时发送消息插件</b>\n<code>${escape(prefix)}sendat 时间 | 消息内容</code>\n<code>${escape(prefix)}sendat list/rm/pause/resume</code>`;
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
};
function parts(date: Date, zone: string) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(values.find(value => value.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
function localInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = parts(new Date(instant), zone),
      shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second),
      next = instant + (target - shown);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}
function nextDue(hour: number, minute: number, second: number, zone: string, now = new Date()) {
  const today = parts(now, zone);
  let due = localInstant(today.year, today.month, today.day, hour, minute, second, zone);
  if (due <= now) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + 86_400_000);
    due = localInstant(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      second,
      zone,
    );
  }
  return due.toISOString();
}

function parseTime(value: string, min: number, max?: number): string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || (max !== undefined && number > max))
    throw new InputError(`时间值 ${value} 无效`);
  return String(number);
}
function parseTask(id: number, cid: string, source: string, timeZone: string): Task {
  const split = source.indexOf("|");
  if (split < 0) throw new InputError("任务格式错误，请使用 '时间 | 消息内容'");
  const message = source.slice(split + 1).trim();
  if (!message) throw new InputError("消息内容不能为空");
  let spec = source.slice(0, split).trim();
  const every = /\bevery\b/i.test(spec);
  spec = spec.replace(/\bevery\b/i, "").trim();
  const parts = spec.split(/\s+/);
  if (!parts.length || parts.length % 2) throw new InputError("时间格式错误");
  const task: Task = {
    task_id: id,
    cid,
    msg: message,
    interval: every,
    cron: false,
    pause: false,
    time_limit: -1,
    hour: "0",
    minute: "0",
    second: "0",
    current_count: 0,
    delivery: "pending",
  };
  let hasTime = false;
  for (let i = 0; i < parts.length; i += 2) {
    const value = parts[i],
      unit = parts[i + 1].toLowerCase();
    if (unit === "times") task.time_limit = Number(parseTime(value, 1));
    else if (unit === "seconds") {
      task.second = parseTime(value, 1, 59);
      hasTime = true;
      task.interval = true;
    } else if (unit === "minutes") {
      task.minute = parseTime(value, 1, 59);
      hasTime = true;
      task.interval = true;
    } else if (unit === "hours") {
      task.hour = parseTime(value, 1, 23);
      hasTime = true;
      task.interval = true;
    } else if (unit === "date") {
      const bits = value.split(":");
      if (bits.length !== 3) throw new InputError("时间格式应为 HH:MM:SS");
      task.hour = parseTime(bits[0], 0, 23);
      task.minute = parseTime(bits[1], 0, 59);
      task.second = parseTime(bits[2], 0, 59);
      task.cron = true;
      task.interval = every;
      hasTime = true;
    } else throw new InputError(`未知的时间单位: ${unit}`);
  }
  if (!hasTime) throw new InputError("时间格式错误");
  if (task.cron && !task.interval) task.dueAt = nextDue(+task.hour, +task.minute, +task.second, timeZone);
  return task;
}
function cronFor(task: Task, timeZone: string): string {
  if (task.cron && task.interval) return `${task.second} ${task.minute} ${task.hour} * * *`;
  if (task.cron && task.dueAt) {
    const d = parts(new Date(task.dueAt), timeZone);
    return `${d.second} ${d.minute} ${d.hour} ${d.day} ${d.month} *`;
  }
  if (+task.hour) return `${task.second} ${task.minute} */${task.hour} * * *`;
  if (+task.minute) return `${task.second} */${task.minute} * * * *`;
  return `*/${task.second} * * * * *`;
}
const description = (task: Task) => {
  let timing = task.interval
    ? task.cron
      ? `每天 ${task.hour.padStart(2, "0")}:${task.minute.padStart(2, "0")}:${task.second.padStart(2, "0")}`
      : `每${+task.hour ? `${task.hour}小时` : ""}${+task.minute ? `${task.minute}分钟` : ""}${+task.second ? `${task.second}秒` : ""}`
    : `指定时间 ${task.hour.padStart(2, "0")}:${task.minute.padStart(2, "0")}:${task.second.padStart(2, "0")}`;
  if (task.time_limit > 0) timing += `，执行 ${task.time_limit} 次`;
  else if (task.time_limit === -1 && task.interval) timing += "，无限执行";
  const source = Array.from(task.sourceMsg ?? task.msg);
  return `任务 #${task.task_id} - ${timing}${task.pause ? " [已暂停]" : ""}\n消息: ${escape(source.slice(0, 50).join(""))}${source.length > 50 ? "..." : ""}`;
};
async function output(context: PluginContext, message: MessageEnvelope, text: string) {
  const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE)).map(
    (page, index, all) => page + ui.pageLabel(index, all.length),
  );
  const delivery = await ui.deliverPages(pages, context.signal, (page, index) =>
    index
      ? context.telegram.reply(message, page, { parseMode: "html" })
      : context.telegram.edit(message, page, { parseMode: "html" }),
  );
  if (delivery.interrupted) {
    context.log.info("sendat.pagination.interrupted", {
      published: delivery.published,
      total: delivery.total,
      category: ui.deliveryErrorCategory(delivery.error),
    });
    if (!delivery.published) throw delivery.error;
    try {
      await context.telegram.reply(message, ui.interruptedNotice(delivery), { parseMode: "html" });
    } catch {}
  }
}
function commandBody(invocation: { message: MessageEnvelope; args: readonly string[] }, context: PluginContext) {
  const raw = invocation.message.raw as { message?: unknown; text?: unknown } | undefined,
    source =
      typeof raw?.message === "string"
        ? raw.message
        : typeof raw?.text === "string"
          ? raw.text
          : invocation.message.text,
    parsed = context.commands.parse(source);
  if (parsed?.command !== "sendat" || !invocation.args.length) return invocation.message.text.replace(/^\S+\s*/, "");
  const body = source.slice(parsed.prefix.length),
    tokens = [...body.matchAll(/\S+/gu)],
    start = tokens[tokens.length - invocation.args.length]?.index;
  return start === undefined ? invocation.message.text.replace(/^\S+\s*/, "") : body.slice(start).trimEnd();
}

export default function createSendAt() {
  const disposers = new Map<number, () => Promise<void>>();
  let write = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = write.then(operation, operation);
    write = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const execute = async (context: PluginContext, id: number) =>
    serialized(async () => {
      const store = context.storage.json<State>("tasks.json", defaults);
      let task = (await store.read()).tasks.find(item => item.task_id === id);
      if (!task || task.pause) return;
      if (task.delivery === "prepared") {
        await store.update(state => {
          const found = state.tasks.find(item => item.task_id === id);
          if (found) found.delivery = "pending";
          return state;
        });
        return;
      }
      await store.update(state => {
        const found = state.tasks.find(item => item.task_id === id);
        if (found) found.delivery = "prepared";
        return state;
      });
      await context.telegram.withClient(async (client, signal) => {
        signal.throwIfAborted();
        await client.sendMessage(returnBigInt(task!.cid), { message: task!.msg, parseMode: "html" });
        signal.throwIfAborted();
      });
      let remove = false;
      await store.update(state => {
        const found = state.tasks.find(item => item.task_id === id);
        if (!found) return state;
        found.current_count += 1;
        found.delivery = "sent";
        if (!found.interval || (found.time_limit > 0 && --found.time_limit === 0)) {
          state.tasks = state.tasks.filter(item => item.task_id !== id);
          remove = true;
        } else found.delivery = "pending";
        return state;
      });
      if (remove) {
        await disposers.get(id)?.();
        disposers.delete(id);
      }
    });
  const register = async (context: PluginContext, task: Task, timeZone = "Asia/Shanghai") => {
    if (task.pause || disposers.has(task.task_id)) return;
    const dispose = await context.jobs.register(
      `task_${task.task_id}`,
      { cron: cronFor(task, timeZone), timeZone, description: `定时发送任务 ${task.task_id}` },
      () => execute(context, task.task_id),
    );
    disposers.set(task.task_id, dispose);
  };
  const sudo = async (context: PluginContext, senderId: string | undefined) =>
    senderId !== undefined && context.services.available("sudo", "is_authorized")
      ? context.services.call<boolean>("sudo", "is_authorized", { senderId }, context.signal)
      : false;
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "sendat",
    description: "按固定时间或间隔发送消息",
    commands: {
      sendat: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "管理定时发送任务",
        async handle(invocation, context) {
          const store = context.storage.json<State>("tasks.json", defaults);
          const sub = invocation.args[0]?.toLowerCase();
          if (!sub || sub === "help" || sub === "h")
            return context.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });
          if (sub === "list") {
            const all = invocation.args[1] === "all";
            if (all && !(await sudo(context, invocation.message.senderId)))
              return context.telegram.edit(
                invocation.message,
                context.services.available("sudo", "is_authorized")
                  ? "❌ 只有管理员可以查看所有任务"
                  : "❌ 查看所有任务需要支持 sudo.is_authorized 的 Core",
                {},
              );
            const tasks = (await store.read()).tasks.filter(task => all || task.cid === invocation.message.chatId);
            return output(
              context,
              invocation.message,
              tasks.length
                ? `${all ? "📋 <b>所有任务：</b>" : "📋 <b>我的任务：</b>"}\n\n${tasks.map(description).join("\n\n")}`
                : all
                  ? "📝 没有已注册的任务"
                  : "📝 您没有已注册的任务",
            );
          }
          if (["rm", "delete", "pause", "resume"].includes(sub)) {
            const id = Number(invocation.args[1]);
            if (!Number.isInteger(id)) return context.telegram.edit(invocation.message, "❌ 请输入有效的任务ID", {});
            const state = await store.read();
            const task = state.tasks.find(item => item.task_id === id);
            if (!task) return context.telegram.edit(invocation.message, "❌ 任务不存在", {});
            if (
              task.cid !== invocation.message.chatId &&
              (!["rm", "delete"].includes(sub) || !(await sudo(context, invocation.message.senderId)))
            )
              return context.telegram.edit(
                invocation.message,
                ["rm", "delete"].includes(sub) && !context.services.available("sudo", "is_authorized")
                  ? "❌ 跨聊天删除需要支持 sudo.is_authorized 的 Core"
                  : "❌ 只能管理自己的任务",
                {},
              );
            if (sub === "rm" || sub === "delete") {
              await disposers.get(id)?.();
              disposers.delete(id);
              await store.update(current => ({ ...current, tasks: current.tasks.filter(item => item.task_id !== id) }));
              return context.telegram.edit(invocation.message, `✅ 已删除任务 #${id}`, {});
            }
            const pause = sub === "pause";
            if (task.pause === pause)
              return context.telegram.edit(invocation.message, `❌ ${pause ? "暂停" : "恢复"}任务失败`, {});
            if (pause) {
              await disposers.get(id)?.();
              disposers.delete(id);
              await store.update(current => {
                const found = current.tasks.find(item => item.task_id === id);
                if (found) found.pause = true;
                return current;
              });
            } else {
              await register(context, { ...task, pause: false }, state.timezone);
              try {
                await store.update(current => {
                  const found = current.tasks.find(item => item.task_id === id);
                  if (found) found.pause = false;
                  return current;
                });
              } catch (error) {
                await disposers.get(id)?.();
                disposers.delete(id);
                throw error;
              }
            }
            return context.telegram.edit(invocation.message, `${pause ? "⏸️ 已暂停" : "▶️ 已恢复"}任务 #${id}`, {});
          }
          const raw = commandBody(invocation, context);
          let createdId: number | undefined, created: Task | undefined;
          try {
            const initial = await store.read(),
              candidate = parseTask(0, invocation.message.chatId, raw, initial.timezone),
              sourceMsg = candidate.msg,
              pages = await ui.renderRichText(sourceMsg);
            if (pages.length !== 1) throw new InputError("消息内容过长");
            candidate.msg = pages[0]!;
            candidate.sourceMsg = sourceMsg;
            let timeZone = initial.timezone;
            await store.update(current => {
              timeZone = current.timezone;
              created = {
                ...candidate,
                task_id: Math.max(0, ...current.tasks.map(item => item.task_id)) + 1,
                ...(!candidate.interval && candidate.cron
                  ? { dueAt: nextDue(+candidate.hour, +candidate.minute, +candidate.second, current.timezone) }
                  : {}),
              };
              createdId = created.task_id;
              return { ...current, schemaVersion: 1, tasks: [...current.tasks, created] };
            });
            await register(context, created!, timeZone);
          } catch (error) {
            context.signal.throwIfAborted();
            if (createdId !== undefined)
              try {
                await store.update(current => ({
                  ...current,
                  tasks: current.tasks.filter(item => item.task_id !== createdId),
                }));
              } catch {
                context.log.error("sendat.add.rollback_failed");
              }
            const detail = error instanceof InputError ? error.message : "添加任务失败，请稍后重试";
            return context.telegram.edit(invocation.message, `❌ <b>错误：</b>${escape(detail)}`, {
              parseMode: "html",
            });
          }
          try {
            return await context.telegram.edit(
              invocation.message,
              `✅ <b>已添加任务 #${created!.task_id}</b>\n\n${description(created!)}`,
              { parseMode: "html" },
            );
          } catch {
            if (!context.signal.aborted) context.log.info("sendat.add.receipt_failed");
          }
        },
      },
    },
    async setup(context) {
      const store = context.storage.json<State>("tasks.json", defaults),
        current = await store.read(),
        timezone = current.timezone && validZone(current.timezone) ? current.timezone : "Asia/Shanghai",
        source = Array.isArray(current.tasks) ? current.tasks : [],
        used = new Set<number>();
      let next = Math.max(
        0,
        ...source.map(task => (Number.isSafeInteger(Number(task?.task_id)) ? Number(task.task_id) : 0)),
      );
      const tasks: Task[] = [];
      for (const value of source) {
        context.signal.throwIfAborted();
        if (!value || typeof value !== "object" || (value.delivery === "prepared" && !value.interval)) continue;
        let id = Number(value.task_id);
        if (!Number.isSafeInteger(id) || id < 1 || used.has(id)) id = ++next;
        used.add(id);
        const sourceMsg = String(value.sourceMsg ?? value.msg ?? ""),
          rendered = await ui.renderRichText(sourceMsg);
        const validMessage = rendered.length === 1 && rendered[0]!.length > 0,
          hour = Number(value.hour),
          minute = Number(value.minute),
          second = Number(value.second),
          validTime =
            Number.isInteger(hour) &&
            hour >= 0 &&
            hour <= 23 &&
            Number.isInteger(minute) &&
            minute >= 0 &&
            minute <= 59 &&
            Number.isInteger(second) &&
            second >= 0 &&
            second <= 59;
        const task: Task = {
          ...value,
          task_id: id,
          cid: String(value.cid),
          msg: validMessage ? rendered[0]! : escape(sourceMsg).slice(0, 4000),
          sourceMsg,
          interval: value.interval === true,
          cron: value.cron === true,
          pause: value.pause === true || !validMessage || !validTime,
          time_limit: Number.isSafeInteger(Number(value.time_limit)) ? Number(value.time_limit) : -1,
          hour: String(validTime ? hour : 0),
          minute: String(validTime ? minute : 0),
          second: String(validTime ? second : 0),
          current_count: Number.isSafeInteger(Number(value.current_count)) ? Number(value.current_count) : 0,
          delivery: value.delivery === "prepared" ? "pending" : value.delivery === "sent" ? "sent" : "pending",
        };
        if (!task.interval && (!task.dueAt || !Number.isFinite(Date.parse(task.dueAt))))
          task.dueAt = nextDue(+task.hour, +task.minute, +task.second, timezone);
        tasks.push(task);
      }
      const state = await store.update(latest => ({ ...latest, schemaVersion: 1, timezone, tasks }));
      for (const task of state.tasks) {
        if (!task.pause && task.dueAt && Date.parse(task.dueAt) <= Date.now()) await execute(context, task.task_id);
        else await register(context, task, state.timezone);
      }
    },
    async cleanup() {
      await Promise.all([...disposers.values()].map(dispose => dispose()));
      disposers.clear();
    },
    settings: context => ({
      title: "定时发送",
      category: "插件配置",
      icon: "📅",
      getSchema: () => [{ key: "timezone", label: "时区", type: "string" }],
      async getValues() {
        return { timezone: (await context.storage.json<State>("tasks.json", defaults).read()).timezone };
      },
      async setValues(patch) {
        if (patch.timezone !== undefined && (typeof patch.timezone !== "string" || !validZone(patch.timezone)))
          throw new Error("invalid timezone");
        const state = await context.storage
          .json<State>("tasks.json", defaults)
          .update(current => ({ ...current, ...(patch.timezone ? { timezone: patch.timezone as string } : {}) }));
        await Promise.all([...disposers.values()].map(dispose => dispose()));
        disposers.clear();
        for (const task of state.tasks) await register(context, task, state.timezone);
      },
    }),
  });
}
