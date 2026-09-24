import { renderHelp as renderPluginHelp } from "./v2/help";
import { Api, utils } from "teleproto";
import { returnBigInt } from "teleproto/Helpers";
import { definePlugin, requireSdkFeatures, ui, type PluginContext } from "telebox/sdk";
import { reviveMessageEntities, serializeMessageEntities } from "./v2/entities";
import {
  DEL_RE_MAX_LIMIT,
  TASK_TYPES,
  buildCopyCommand,
  createDefaults,
  ensureCron,
  escapeHtml,
  formatDate,
  getRemarkFromMsg,
  hasSixCronFields,
  nextRunTime,
  parseBoolFlag,
  parseRegex,
  parseRegexInput,
  renderTaskList,
  splitTarget,
  validateCronExpr,
  type State,
  type Task,
  type TaskType,
} from "./v2/tasks";

const escape = escapeHtml;
const numeric = (value?: string) => (value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined);
const peer = (value?: string) => (value !== undefined && /^-?\d+$/.test(value) ? returnBigInt(value) : value);
const help = (prefix: string) =>
  `<b>定时任务</b>\n<code>${prefix}acron send/copy/forward/cmd CRON 对话</code>\n<code>${prefix}acron del/del_re/pin/unpin CRON 对话 参数</code>\n<code>${prefix}acron list/rm/disable/enable</code>`;

const CREATION_TITLES: Record<TaskType, string> = {
  send: "✅ 已添加定时发送任务",
  cmd: "✅ 已添加定时命令任务",
  copy: "✅ 已添加定时复制任务",
  forward: "✅ 已添加定时转发任务",
  del: "✅ 已添加删除消息的定时任务",
  del_re: "✅ 已添加正则删除的定时任务",
  pin: "✅ 已添加置顶消息的定时任务",
  unpin: "✅ 已添加取消置顶的定时任务",
};

function formatEntityDisplay(entity: unknown, fallback: string): string {
  const value = entity as
    { title?: unknown; firstName?: unknown; lastName?: unknown; username?: unknown; id?: unknown } | undefined;
  const parts: string[] = [];
  if (value?.title) parts.push(escape(String(value.title)));
  if (value?.firstName) parts.push(escape(String(value.firstName)));
  if (value?.lastName) parts.push(escape(String(value.lastName)));
  if (value?.username) parts.push(`<code>@${escape(String(value.username))}</code>`);
  const id = value?.id !== undefined && value?.id !== null ? String(value.id) : undefined;
  if (id) {
    parts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`,
    );
  }
  return parts.length ? parts.join(" ") : `<code>${escape(fallback)}</code>`;
}

export default function createAcron() {
  requireSdkFeatures("safeRegexp", "commandDispatch");
  const disposers = new Map<string, () => Promise<void>>();
  let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const execute = async (context: PluginContext, id: string) =>
    serial(async () => {
      const store = context.storage.json<State>("acron_config.json", createDefaults());
      const state = await store.read();
      const task = state.tasks.find(item => item.id === id);
      if (!task || task.disabled) return;
      if (task.delivery === "prepared") {
        await store.update(current => {
          const found = current.tasks.find(item => item.id === id);
          if (found) {
            found.delivery = "pending";
            found.lastError = "上次执行在确认结果前中断，已跳过以避免重复副作用";
          }
          return current;
        });
        return;
      }
      await store.update(current => {
        const found = current.tasks.find(item => item.id === id);
        if (found) found.delivery = "prepared";
        return current;
      });
      try {
        let result = "已执行";
        await context.telegram.withClient(async client => {
          const target = task.resolvedPeer
            ? (peer(task.chatId) ?? task.chat)
            : await client.getEntity(peer(task.chat)!);
          if (!task.resolvedPeer) {
            const chatId = utils.getPeerId(target);
            await store.update(current => {
              const found = current.tasks.find(item => item.id === id);
              if (found) {
                found.chatId = chatId;
                found.resolvedPeer = true;
              }
              return current;
            });
          }
          const replyTo = task.replyTo ? numeric(task.replyTo) : undefined;
          if (task.type === "send") {
            const entities = reviveMessageEntities(task.entities);
            await client.sendMessage(target, {
              message: task.message ?? "",
              ...(entities ? { formattingEntities: entities } : {}),
              ...(replyTo ? { replyTo } : {}),
            });
            result = "已发送 1 条消息";
          } else if (task.type === "cmd") {
            const sent = await client.sendMessage(target, {
              message: task.message ?? "",
              ...(replyTo ? { replyTo } : {}),
            });
            const outcome = await context.commands.dispatch(sent);
            result =
              outcome.status === "dispatched" ? "已执行命令" : `已发送命令（未执行: ${outcome.reason ?? "unknown"}）`;
          } else if (task.type === "copy") {
            const messages = await client.getMessages(peer(task.fromChatId), { ids: numeric(task.fromMsgId) });
            const source = messages?.[0] as (Api.Message & { entities?: Api.TypeMessageEntity[] }) | undefined;
            if (!source) throw new Error("未能获取源消息");
            await client.sendMessage(target, {
              message: source,
              formattingEntities: source.entities,
              ...(replyTo ? { replyTo } : {}),
            });
            result = "已复制发送 1 条消息";
          } else if (task.type === "forward") {
            await client.invoke(
              new Api.messages.ForwardMessages({
                fromPeer: peer(task.fromChatId)!,
                id: [numeric(task.fromMsgId)!],
                toPeer: target,
                ...(replyTo ? { topMsgId: replyTo } : {}),
              }),
            );
            result = "已转发 1 条消息";
          } else if (task.type === "del") {
            const msgId = numeric(task.msgId);
            if (msgId !== undefined) await client.deleteMessages(target, [msgId], { revoke: true });
            result = `已尝试删除消息 ${task.msgId}`;
          } else if (task.type === "del_re") {
            // Re-validate stored tasks as well: existing dirty rows must not fall back
            // to an empty regex (full match) or a non-positive scan limit.
            const limit = numeric(task.limit);
            const regexRaw = (task.regex ?? "").trim();
            // Out-of-range stored rows are rejected, not clamped: a task never reports a
            // completed scan it did not actually perform.
            if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > DEL_RE_MAX_LIMIT)
              throw new Error("DEL_RE_LIMIT");
            if (!regexRaw) throw new Error("DEL_RE_REGEX");
            const { pattern, flags: regexFlags } = parseRegexInput(regexRaw);
            // The managed worker supports i,m,s,u; `g` only carries lastIndex state
            // that is reset per message, so drop it. Any other flag fails explicitly
            // through the worker instead of silently changing the match result.
            const safeFlags = regexFlags.replace(/g/g, "");
            const messages = await client.getMessages(target, { limit });
            const ids: number[] = [];
            for (const message of messages ?? []) {
              const row = message as { message?: string; text?: string; id: number };
              const text = row.message ?? row.text;
              if (typeof text !== "string") continue;
              const evaluation = await context.regexp.test(pattern, text, safeFlags ? { flags: safeFlags } : {});
              if (evaluation.timedOut) throw new Error("DEL_RE_TIMEOUT");
              if (evaluation.matched) ids.push(row.id);
            }
            if (ids.length) await client.deleteMessages(target, ids, { revoke: true });
            result = `匹配并删除 ${ids.length} 条`;
          } else if (task.type === "pin") {
            const msgId = numeric(task.msgId);
            if (msgId === undefined) throw new Error("无效的消息ID");
            await client.pinMessage(target, msgId, { notify: !!task.notify, pmOneSide: !!task.pmOneSide });
            result = `已置顶消息 ${task.msgId}`;
          } else if (task.type === "unpin") {
            const msgId = numeric(task.msgId);
            if (msgId === undefined) throw new Error("无效的消息ID");
            await client.unpinMessage(target, msgId);
            result = `已取消置顶消息 ${task.msgId}`;
          }
        });
        await store.update(current => {
          const found = current.tasks.find(item => item.id === id);
          if (found) {
            found.lastRunAt = String(Date.now());
            found.lastResult = result;
            delete found.lastError;
            found.delivery = "sent";
          }
          return current;
        });
      } catch (error) {
        await store.update(current => {
          const found = current.tasks.find(item => item.id === id);
          if (found) {
            found.lastRunAt = String(Date.now());
            found.lastError =
              error instanceof Error && /^(DEL_RE_|INVALID_)/.test(error.message) ? error.message : "任务执行失败";
            found.delivery = "pending";
          }
          return current;
        });
      }
    });
  const register = async (context: PluginContext, task: Task) => {
    if (task.disabled || disposers.has(task.id)) return;
    const dispose = await context.jobs.register(
      `task_${task.id}`,
      { cron: task.cron, timeZone: "Asia/Shanghai", description: `acron ${task.type} ${task.id}` },
      () => execute(context, task.id),
    );
    disposers.set(task.id, dispose);
  };

  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "acron",
    description: "定时发送、复制、转发、删除及置顶消息",
    commands: {
      acron: {
        helpOnEmpty: true,
        description: "管理 Cron 定时任务",
        async handle(invocation, context) {
          await ensureCron();
          const store = context.storage.json<State>("acron_config.json", createDefaults());
          const lines = (invocation.message.text ?? "").trim().split(/\r?\n/);
          const firstLine = lines[0] ?? "";
          const sub = (invocation.args[0] ?? "").toLowerCase();
          if (!sub) return context.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });

          if (["list", "ls", "la"].includes(sub)) {
            let scope = (invocation.args[1] ?? "").toLowerCase();
            let typeArg = (invocation.args[2] ?? "").toLowerCase();
            if (sub === "la") {
              typeArg = scope;
              scope = "all";
            }
            const all = scope === "all";
            const typeFilter = TASK_TYPES.includes(typeArg as TaskType) ? (typeArg as TaskType) : undefined;
            const state = await store.read();
            const chatId = invocation.message.chatId;
            const tasks = state.tasks
              .filter(task => (all || task.chatId === chatId) && (!typeFilter || task.type === typeFilter))
              .sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0));
            const displayMap = new Map<string, string>();
            try {
              await context.telegram.withClient(async client => {
                for (const task of tasks) {
                  const key = task.chatId ?? task.chat;
                  if (displayMap.has(key)) continue;
                  displayMap.set(key, `<code>${escape(task.chat ?? key)}</code>`);
                  try {
                    displayMap.set(
                      key,
                      formatEntityDisplay(await client.getEntity(peer(task.chatId) ?? task.chat), task.chat),
                    );
                  } catch {}
                }
              });
            } catch {}
            const text = renderTaskList({
              tasks,
              all,
              typeFilter,
              prefix: invocation.prefix,
              displayOf: task => displayMap.get(task.chatId ?? task.chat) ?? `<code>${escape(task.chat ?? "")}</code>`,
            });
            const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE)).map(
              (page, index, allPages) => page + ui.pageLabel(index, allPages.length),
            );
            const delivery = await ui.deliverPages(pages, context.signal, (page, index) =>
              index
                ? context.telegram.reply(invocation.message, page, { parseMode: "html" })
                : context.telegram.edit(invocation.message, page, { parseMode: "html" }),
            );
            if (delivery.interrupted) {
              context.log.info("pagination_delivery_interrupted", {
                plugin: "acron",
                published: delivery.published,
                total: delivery.total,
                category: ui.deliveryErrorCategory(delivery.error),
              });
              if (delivery.published) {
                try {
                  await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {
                    parseMode: "html",
                  });
                } catch {}
              } else throw delivery.error;
            }
            return;
          }

          if (["rm", "remove", "del_task", "disable", "off", "enable", "on"].includes(sub)) {
            const id = invocation.args[1];
            if (!id)
              return context.telegram.edit(
                invocation.message,
                `请提供定时任务ID: <code>${invocation.prefix}acron ${sub} ID</code>`,
                { parseMode: "html" },
              );
            const state = await store.read();
            const task = state.tasks.find(item => item.id === id);
            if (!task)
              return context.telegram.edit(invocation.message, `未找到任务: <code>${escape(id)}</code>`, {
                parseMode: "html",
              });
            if (["rm", "remove", "del_task"].includes(sub)) {
              await disposers.get(id)?.();
              disposers.delete(id);
              await store.update(current => ({ ...current, tasks: current.tasks.filter(item => item.id !== id) }));
              return context.telegram.edit(invocation.message, `✅ 已删除任务 <code>${escape(id)}</code>`, {
                parseMode: "html",
              });
            }
            const disabled = sub === "disable" || sub === "off";
            if (disabled) {
              await disposers.get(id)?.();
              disposers.delete(id);
              await store.update(current => {
                const found = current.tasks.find(item => item.id === id);
                if (found) found.disabled = true;
                return current;
              });
              return context.telegram.edit(invocation.message, `⏸️ 已禁用任务 <code>${escape(id)}</code>`, {
                parseMode: "html",
              });
            }
            // Enable validates and registers before persisting, so an invalid cron or a
            // rejected registration leaves the task disabled in storage.
            if (!validateCronExpr(task.cron))
              return context.telegram.edit(
                invocation.message,
                `任务 <code>${escape(id)}</code> 的 Cron 表达式无效，无法启用`,
                { parseMode: "html" },
              );
            try {
              await register(context, { ...task, disabled: false });
            } catch {
              return context.telegram.edit(invocation.message, `任务 <code>${escape(id)}</code> 启用失败`, {
                parseMode: "html",
              });
            }
            await store.update(current => {
              const found = current.tasks.find(item => item.id === id);
              if (found) found.disabled = false;
              return current;
            });
            const next = nextRunTime(task.cron);
            const tip = [
              `▶️ 已启用任务 <code>${escape(id)}</code>`,
              next ? `下次执行: ${escape(formatDate(next))}` : "",
              `复制: ${buildCopyCommand({ ...task, disabled: false }, invocation.prefix)}`,
            ]
              .filter(Boolean)
              .join("\n");
            return context.telegram.edit(invocation.message, tip, { parseMode: "html" });
          }

          if (!TASK_TYPES.includes(sub as TaskType))
            return context.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });
          const type = sub as TaskType;
          const cronExpr = invocation.args.slice(1, 7).join(" ");
          if (!hasSixCronFields(cronExpr))
            return context.telegram.edit(invocation.message, "Cron 表达式必须为 6 段", {});
          const targetArg = invocation.args[7];
          if (!targetArg) return context.telegram.edit(invocation.message, "请提供对话ID或@name", {});
          const { chat: chat, replyTo } = splitTarget(targetArg);
          if (!chat) return context.telegram.edit(invocation.message, "请提供对话ID或@name", {});

          let resolved: string | undefined;
          let display = `<code>${escape(chat)}</code>`;
          try {
            const entity = await context.telegram.withClient(client => client.getEntity(peer(chat)!));
            resolved = utils.getPeerId(entity);
            display = formatEntityDisplay(entity, chat);
          } catch {}

          const rest = invocation.args.slice(8);
          let task: Task = {
            id: "",
            type,
            cron: cronExpr,
            chat,
            ...(resolved !== undefined ? { chatId: resolved, resolvedPeer: true } : {}),
            createdAt: String(Date.now()),
            delivery: "pending",
            display,
            ...(replyTo ? { replyTo } : {}),
          };

          if (type === "send") {
            const reply = await context.telegram.getReply(invocation.message);
            const raw = reply?.raw as Api.Message | undefined;
            if (raw?.media || raw?.replyMarkup)
              return context.telegram.edit(
                invocation.message,
                "不支持带多媒体或 replyMarkup 的消息 可考虑使用本插件的定时复制/转发功能",
                {},
              );
            const message = String(raw?.message ?? reply?.text ?? "");
            if (!message.trim()) return context.telegram.edit(invocation.message, "请回复一条包含文本的消息", {});
            const entities = serializeMessageEntities(raw?.entities);
            const remark = getRemarkFromMsg(firstLine, 8);
            task = { ...task, message, ...(entities ? { entities } : {}), ...(remark ? { remark } : {}) };
          } else if (type === "cmd") {
            const message = lines[1]?.trim();
            if (!message) return context.telegram.edit(invocation.message, "无法识别要执行的命令", {});
            const remark = getRemarkFromMsg(firstLine, 8);
            task = { ...task, message, ...(remark ? { remark } : {}) };
          } else if (type === "copy" || type === "forward") {
            const reply = await context.telegram.getReply(invocation.message);
            if (!reply) return context.telegram.edit(invocation.message, "请回复一条要复制/转发的源消息", {});
            if (!reply.id || !reply.chatId)
              return context.telegram.edit(invocation.message, "无法识别源消息ID或会话ID", {});
            const remark = getRemarkFromMsg(firstLine, 8);
            task = {
              ...task,
              fromChatId: String(reply.chatId),
              fromMsgId: String(reply.id),
              ...(remark ? { remark } : {}),
            };
          } else if (type === "del") {
            const msgId = rest[0];
            if (!msgId) return context.telegram.edit(invocation.message, "请提供消息 ID", {});
            if (numeric(msgId) === undefined) return context.telegram.edit(invocation.message, "无效的消息ID", {});
            const remark = getRemarkFromMsg(firstLine, 9);
            task = { ...task, msgId, ...(remark ? { remark } : {}) };
          } else if (type === "del_re") {
            const limit = Number(rest[0]);
            if (!rest[0] || !Number.isInteger(limit) || limit < 1 || limit > DEL_RE_MAX_LIMIT)
              return context.telegram.edit(invocation.message, `请提供 1-${DEL_RE_MAX_LIMIT} 之间的整数条数限制`, {});
            if (!rest[1]) return context.telegram.edit(invocation.message, "请提供消息正则表达式", {});
            const regex = String(rest[1]).trim();
            if (!regex) return context.telegram.edit(invocation.message, "请提供消息正则表达式", {});
            try {
              parseRegex(regex);
            } catch (error) {
              return context.telegram.edit(
                invocation.message,
                `无效的正则表达式: ${error instanceof Error ? error.message : String(error)}`,
                {},
              );
            }
            const remark = getRemarkFromMsg(firstLine, 10);
            task = { ...task, limit: String(limit), regex, ...(remark ? { remark } : {}) };
          } else if (type === "pin") {
            const msgId = rest[0];
            if (!msgId) return context.telegram.edit(invocation.message, "请提供消息 ID", {});
            if (numeric(msgId) === undefined) return context.telegram.edit(invocation.message, "无效的消息ID", {});
            const notifyRaw = (rest[1] ?? "").toLowerCase();
            const pmOneSideRaw = (rest[2] ?? "").toLowerCase();
            if (!notifyRaw || !pmOneSideRaw)
              return context.telegram.edit(
                invocation.message,
                "请提供是否发通知与是否仅对自己置顶参数，如: 1 0 或 true false",
                {},
              );
            const remark = getRemarkFromMsg(firstLine, 11);
            task = {
              ...task,
              msgId,
              notify: parseBoolFlag(notifyRaw),
              pmOneSide: parseBoolFlag(pmOneSideRaw),
              ...(remark ? { remark } : {}),
            };
          } else {
            const msgId = rest[0];
            if (!msgId) return context.telegram.edit(invocation.message, "请提供消息 ID", {});
            if (numeric(msgId) === undefined) return context.telegram.edit(invocation.message, "无效的消息ID", {});
            const remark = getRemarkFromMsg(firstLine, 9);
            task = { ...task, msgId, ...(remark ? { remark } : {}) };
          }

          let stored = task;
          await store.update(current => {
            const id = (BigInt(current.seq || "0") + 1n).toString();
            stored = { ...task, id };
            return { ...current, schemaVersion: 1, seq: id, tasks: [...current.tasks, stored] };
          });
          try {
            await register(context, stored);
          } catch {
            await store.update(current => ({ ...current, tasks: current.tasks.filter(item => item.id !== stored.id) }));
            return context.telegram.edit(invocation.message, "无效的 Cron 表达式", {});
          }

          const next = nextRunTime(cronExpr);
          const tip = [
            CREATION_TITLES[type],
            `ID: <code>${escape(stored.id)}</code>`,
            `对话: ${display}`,
            ...(stored.replyTo ? [`回复: ${escape(stored.replyTo)}`] : []),
            ...(stored.msgId ? [`消息ID: <code>${escape(stored.msgId)}</code>`] : []),
            ...(type === "del_re"
              ? [
                  `最近条数: <code>${escape(stored.limit ?? "")}</code>`,
                  `匹配: <code>${escape(stored.regex ?? "")}</code>`,
                ]
              : []),
            ...(type === "pin"
              ? [
                  `通知: <code>${stored.notify ? "1" : "0"}</code>`,
                  `仅自己置顶: <code>${stored.pmOneSide ? "1" : "0"}</code>`,
                ]
              : []),
            ...(stored.remark ? [`备注: ${escape(stored.remark)}`] : []),
            next ? `下次执行: ${escape(formatDate(next))}` : "",
            `复制: ${buildCopyCommand(stored, invocation.prefix)}`,
          ]
            .filter(Boolean)
            .join("\n");
          return context.telegram.edit(invocation.message, tip, { parseMode: "html" });
        },
      },
    },
    async setup(context) {
      await ensureCron();
      const state = await context.storage.json<State>("acron_config.json", createDefaults()).update(current => ({
        ...current,
        schemaVersion: 1,
        seq: String(current.seq || "0"),
        tasks: (current.tasks || []).map(task => ({
          ...task,
          id: String(task.id),
          ...(task.chatId === undefined ? {} : { chatId: String(task.chatId) }),
          delivery: task.delivery || "pending",
        })),
      }));
      for (const task of state.tasks) {
        if (task.disabled) continue;
        if (!validateCronExpr(task.cron)) {
          context.log.error("acron_task_invalid_cron", { taskId: task.id });
          continue;
        }
        try {
          await register(context, task);
        } catch {
          context.log.error("acron_task_register_failed", { taskId: task.id });
        }
      }
    },
    async cleanup() {
      await Promise.all([...disposers.values()].map(dispose => dispose()));
      disposers.clear();
    },
  });
}
