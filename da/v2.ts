import {renderHelp as renderPluginHelp} from "./v2/help";
import { definePlugin, type PluginContext } from "telebox/sdk";
import { setTimeout as sleep } from "node:timers/promises";

interface DeleteTask {
  chatId: string; chatName: string; startTime: number; deletedMessages: number;
  isRunning: boolean; isPaused: boolean; sleepUntil: number | null;
  lastUpdate: number; lastLogTime: number; errors: string[]; savedMessageId?: number;
}
const escape = (value: unknown) => String(value).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const help = (prefix: string) => `<b>批量删除</b>\n\n<code>${escape(prefix)}da true</code> 开始或恢复删除\n<code>${escape(prefix)}da stop</code> 停止任务\n<code>${escape(prefix)}da status</code> 状态发送到收藏夹\n管理员删除全部消息，普通成员仅删除自己的消息。`;
const failure = (kind: "permission" | "delete" | "task") => kind === "permission" ? "权限检查失败" : kind === "delete" ? "部分消息删除失败" : "删除任务执行失败";

export default function createDa() {
  const active = new Map<string, { controller: AbortController; task?: DeleteTask }>();
  const database = (ctx: PluginContext) => ctx.storage.json<{ tasks: DeleteTask[]; imported: boolean }>("database.json", { tasks: [], imported: false });
  const save = async (ctx: PluginContext, task: DeleteTask) => {
    task.lastUpdate = Date.now();
    await database(ctx).update(data => {
      const index = data.tasks.findIndex(t => t.chatId === task.chatId);
      if (index < 0) data.tasks.push(task); else data.tasks[index] = task;
      return data;
    });
  };
  const progress = async (ctx: PluginContext, task: DeleteTask, status: string) => {
    const seconds = Math.max(1, Math.floor((Date.now() - task.startTime) / 1000));
    const state = task.sleepUntil && task.sleepUntil > Date.now() ? `休眠中 (${Math.ceil((task.sleepUntil - Date.now()) / 1000)}秒)` : task.isRunning ? "运行中" : task.isPaused ? "已暂停" : "已停止";
    const text = `<b>删除任务：${escape(status)}</b>\n群聊：${escape(task.chatName)}\n状态：${state}\n已删除：${task.deletedMessages} 条\n删除速度：${(task.deletedMessages / seconds).toFixed(2)} 条/秒\n运行时长：${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分钟 ${seconds % 60}秒\n最后更新：${escape(new Date(task.lastUpdate).toLocaleString("zh-CN"))}\n${task.errors.slice(-3).map(escape).join("\n")}`;
    try {
      await ctx.telegram.withClient(async (client, signal) => {
        signal.throwIfAborted();
        if (task.savedMessageId) {
          try { await client.editMessage("me", { message: task.savedMessageId, text, parseMode: "html" }); return; }
          catch (error) {
            signal.throwIfAborted();
            if (String(error).includes("MESSAGE_NOT_MODIFIED")) return;
            ctx.log.error("da:progress-edit");
          }
        }
        signal.throwIfAborted();
        task.savedMessageId = (await client.sendMessage("me", { message: text, parseMode: "html" })).id;
      });
      await save(ctx, task);
    } catch { ctx.signal.throwIfAborted(); ctx.log.error("da:progress"); }
  };
  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1, id: "da", description: help("."),
    async setup(ctx) {
      const store = database(ctx);
      if (!(await store.read()).imported) {
        const legacy = await ctx.tasks.run("da:import", async signal => {
          const { readFile } = await import("node:fs/promises");
          try {
            const data = JSON.parse(await readFile(ctx.files.dataPath("database.json"), "utf8"));
            signal.throwIfAborted();
            if (!Array.isArray(data.tasks)) throw new Error("Invalid legacy DA database");
            return data.tasks as DeleteTask[];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        });
        await store.update(data => { if (!data.imported) { data.tasks = legacy; data.imported = true; } return data; });
      }
      // Persisted jobs require an explicit resume after a generation change.
      await store.update(data => { for (const task of data.tasks) {
        if (task.isRunning) task.isPaused = true;
        task.isRunning = false; task.sleepUntil = null;
        task.errors = task.errors?.length ? ["历史任务存在删除失败"] : [];
      } return data; });
    },
    commands: { da: {helpOnEmpty: true, helpArgs: ["help","h"],  description: "批量删除群组消息", ignoreEdited: true, async handle({ message, args, prefix }, ctx) {
      const raw = message.raw as { isPrivate?: boolean; peerId?: any } | undefined;
      if (raw?.isPrivate || !message.chatId.startsWith("-")) {
        await ctx.telegram.edit(message, "仅群组可用"); return;
      }
      const sub = (args[0] || "").toLowerCase();
      if (!sub || sub === "help" || sub === "h") {
        await ctx.telegram.edit(message, help(prefix), { parseMode: "html" }); return;
      }
      if (!["true", "stop", "status"].includes(sub)) { await ctx.telegram.edit(message, "未知命令"); return; }
      const id = message.chatId;
      const removeCommand = () => ctx.telegram.withClient(async (client, signal) => {
        const { returnBigInt } = await import("teleproto/Helpers.js");
        signal.throwIfAborted();
        await client.deleteMessages(raw?.peerId ?? returnBigInt(id), [message.id], { revoke: true });
      });
      if (sub !== "true") {
        const slot = active.get(id);
        if (sub === "stop") slot?.controller.abort(new Error("DA stopped"));
        const task = slot?.task ?? (await database(ctx).read()).tasks.find(t => t.chatId === id);
        if (task) {
          if (sub === "stop" && !slot) { task.isRunning = false; task.isPaused = true; await save(ctx, task); }
          await progress(ctx, task, sub === "status" ? "状态查询" : slot ? "正在停止，等待当前请求结束" : "已手动停止");
        }
        await removeCommand(); return;
      }
      if (active.has(id)) { await removeCommand(); return; }
      const slot: { controller: AbortController; task?: DeleteTask } = { controller: new AbortController() };
      active.set(id, slot);
      void ctx.tasks.run(`da:delete:${id}`, async scoped => {
        const signal = AbortSignal.any([scoped, slot.controller.signal]);
        const wait = (ms: number) => sleep(ms, undefined, { signal });
        let completed = false;
        try {
          signal.throwIfAborted();
          const existing = (await database(ctx).read()).tasks.find(t => t.chatId === id);
          const task = slot.task = existing ?? { chatId: id, chatName: id, startTime: Date.now(), deletedMessages: 0,
            isRunning: true, isPaused: false, sleepUntil: null, lastUpdate: Date.now(), lastLogTime: Date.now(), errors: [] };
          task.isRunning = true; task.isPaused = false; task.sleepUntil = null;
          await save(ctx, task);
          await ctx.telegram.withClient(async client => {
            const { Api } = await import("teleproto");
            const { returnBigInt } = await import("teleproto/Helpers.js");
            const call = async <T>(fn: () => Promise<T>): Promise<T> => {
              signal.throwIfAborted(); const value = await fn(); signal.throwIfAborted(); return value;
            };
            const chat = await call(() => client.getEntity(raw?.peerId ?? returnBigInt(id)));
            task.chatName = "title" in chat ? chat.title : id;
            const me = await call(() => client.getMe());
            let admin = false;
            if (chat.className === "Channel") {
              try {
                const result = await call(() => client.invoke(new Api.channels.GetParticipant({ channel: chat, participant: me.id })));
                admin = ["ChannelParticipantAdmin", "ChannelParticipantCreator"].includes(result.participant.className);
              } catch (error) {
                signal.throwIfAborted(); ctx.log.error("da:permission");
                try {
                  const result = await call(() => client.invoke(new Api.channels.GetParticipants({ channel: chat,
                    filter: new Api.ChannelParticipantsAdmins(), offset: 0, limit: 100, hash: returnBigInt(0) })));
                  admin = "users" in result && result.users.some(user => user.id.toString() === me.id.toString());
                } catch { signal.throwIfAborted(); ctx.log.error("da:permission-fallback"); }
              }
            }
            await call(removeCommand);
            await call(() => progress(ctx, task, "任务已启动"));
            const deleteIds = async (ids: number[], single = false): Promise<void> => {
              while (true) {
                signal.throwIfAborted();
                try {
                  // Count successful settlement even if stop arrived during this RPC.
                  await client.deleteMessages(chat, ids, { revoke: true });
                  task.deletedMessages += ids.length;
                  await save(ctx, task); signal.throwIfAborted(); return;
                } catch (error) {
                  signal.throwIfAborted();
                  const flood = String(error).match(/FLOOD_WAIT[_ ]?(\d+)/);
                  if (flood) {
                    const ms = Number(flood[1]) * 1000;
                    task.sleepUntil = Date.now() + ms; await save(ctx, task);
                    await wait(ms); task.sleepUntil = null; continue;
                  }
                  task.errors.push(failure("delete")); task.errors = task.errors.slice(-20);
                  ctx.log.error("da:delete", { count: ids.length });
                  if (!single && ids.length > 1) {
                    for (const item of ids) { await deleteIds([item], true); await wait(50); }
                  } else await save(ctx, task);
                  return;
                }
              }
            };
            if (admin) {
              let batch: number[] = [];
              for await (const item of client.iterMessages(chat, { minId: 1 })) {
                signal.throwIfAborted();
                if (item.className !== "Message" || !Number.isInteger(item.id) || item.id <= 0) continue;
                batch.push(item.id);
                if (batch.length === 100) { await deleteIds(batch); batch = []; }
              }
              if (batch.length) await deleteIds(batch);
            } else {
              const fromId = await call(() => client.getInputEntity(me.id));
              let offsetId = 0;
              while (true) {
                const result = await call(() => client.invoke(new Api.messages.Search({ peer: chat, q: "", fromId,
                  filter: new Api.InputMessagesFilterEmpty(), minDate: 0, maxDate: 0, offsetId,
                  addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: returnBigInt(0) })));
                const page = "messages" in result ? result.messages : [];
                if (!page.length) break;
                const next = Math.min(...page.map(m => m.id).filter(id => id > 0));
                if (!Number.isFinite(next) || (offsetId > 0 && next >= offsetId)) throw new Error("DA search cursor did not advance");
                offsetId = next;
                const ids = page.filter(m => m.className === "Message" && m.senderId?.toString() === me.id.toString()).map(m => m.id);
                if (ids.length) await deleteIds(ids);
                await wait(200);
              }
            }
          });
          completed = true;
        } catch (error) {
          if (!signal.aborted) {
            ctx.log.error("da:task");
            slot.task?.errors.push(failure("task"));
          }
        } finally {
          try {
            if (slot.task && !ctx.signal.aborted) {
              const task = slot.task;
              task.isRunning = false; task.isPaused = signal.aborted; task.sleepUntil = null;
              await save(ctx, task);
              await progress(ctx, task, signal.aborted ? "已停止" : completed ? (task.errors.length ? "完成，存在删除失败" : "任务完成") : "执行失败");
              if (completed && !task.errors.length) await database(ctx).update(data => { data.tasks = data.tasks.filter(t => t.chatId !== id); return data; });
            }
          } finally { active.delete(id); }
        }
      }).catch(() => ctx.log.error("da:background"));
    } } },
  });
}
