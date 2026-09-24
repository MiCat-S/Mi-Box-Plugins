import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui } from "telebox/sdk";
import type { Api } from "teleproto";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

const positive = (value: string | undefined, maximum: number): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const integer = Math.trunc(parsed);
  return integer > 0 && integer <= maximum ? integer : undefined;
};

function sample<T>(values: T[], count: number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const selected = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[selected]] = [copy[selected]!, copy[index]!];
  }
  return copy.slice(0, count);
}

const missingDateCrash = (error: unknown): boolean => {
  const message = String((error as Error)?.message ?? error ?? "");
  return message.includes("Cannot read properties of undefined") && message.includes("reading 'date'");
};

function display(entity: Api.User, id: string): string {
  const parts: string[] = [];
  if (entity.firstName) parts.push(escape(entity.firstName));
  if (entity.lastName) parts.push(escape(entity.lastName));
  if (entity.username) parts.push(escape(`@${entity.username}`));
  parts.push(`<a href="tg://user?id=${escape(id)}">${escape(id)}</a>`);
  return parts.join(" ");
}

export default function createDbdj() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "dbdj",
    description: "从近期发言者中随机抽取用户",
    commands: {
      dbdj: {
        helpOnEmpty: true,
        description: "从近期发言者中随机抽取用户",
        async handle(invocation, context) {
          const firstLine = invocation.message.text.trim().split(/\r?\n/, 1)[0]!;
          const args = invocation.message.text.includes("\n")
            ? (context.commands.parse(firstLine)?.args ?? invocation.args)
            : invocation.args;
          const scanCount = positive(args[0], 1000);
          const pickCount = positive(args[1], 100);
          if (!scanCount || !pickCount) {
            await context.telegram.reply(
              invocation.message,
              `用法: <code>${escape(invocation.prefix)}dbdj 消息数 人数 文案</code>\n例如: <code>${escape(invocation.prefix)}dbdj 50 2 恭喜发财</code>`,
              { parseMode: "html", linkPreview: false },
            );
            await context.telegram.withClient(async (_client, signal) => {
              signal.throwIfAborted();
              const raw = invocation.message.raw as Api.Message | undefined;
              if (typeof raw?.delete === "function") {
                try {
                  await raw.delete({ revoke: true });
                } catch {
                  context.log.error("dbdj_delete_failed");
                }
                signal.throwIfAborted();
              }
            });
            return;
          }
          const note = args.slice(2).join(" ").trim();
          const started = Date.now();
          try {
            await context.telegram.edit(invocation.message, "点兵点将...");
            await context.telegram.withClient(async (client, signal) => {
              const raw = invocation.message.raw as Api.Message | undefined;
              const { returnBigInt } = await import("teleproto/Helpers.js");
              signal.throwIfAborted();
              const peer = raw?.peerId ?? returnBigInt(invocation.message.chatId);
              let messages: readonly unknown[];
              try {
                const result = await client.getMessages(peer, {
                  limit: scanCount,
                  offsetId: Math.max(0, invocation.message.id - 1),
                });
                signal.throwIfAborted();
                messages = Array.isArray(result) ? result : result ? [result] : [];
              } catch (error) {
                signal.throwIfAborted();
                if (!missingDateCrash(error)) throw error;
                messages = [];
              }
              const ids = new Map<string, unknown>();
              for (const message of messages) {
                signal.throwIfAborted();
                const fromId = (message as Api.Message).fromId;
                const id = fromId && "userId" in fromId ? fromId.userId : undefined;
                if (id !== undefined) ids.set(String(id), id);
              }
              const candidates: Array<{ id: string; name: string }> = [];
              for (const [id, nativeId] of ids) {
                signal.throwIfAborted();
                try {
                  const entity = (await client.getEntity(nativeId as never)) as Api.User;
                  signal.throwIfAborted();
                  if (entity.bot || entity.deleted || entity.fake || entity.scam || entity.botBusiness) continue;
                  candidates.push({ id, name: display(entity, id) });
                } catch (error) {
                  signal.throwIfAborted();
                  context.log.error("dbdj_entity_skipped");
                }
              }
              let response: string;
              let paginatedResponse: string | undefined;
              if (!candidates.length) {
                response = `未在最近的 <code>${scanCount}</code> 条消息中找到可抽取的有效用户。`;
              } else {
                const winners = sample(candidates, Math.min(pickCount, candidates.length));
                const mentions = winners.map(user => user.name).join(", ");
                const probability = String(Math.round((winners.length / candidates.length) * 10000) / 100);
                const suffix = note ? ` ${escape(note)}` : "";
                const seconds = String(Math.round((Date.now() - started) / 10) / 100);
                response = `点兵点将, 点到谁... ${mentions}${suffix}\n\n📊 统计信息:\n• 扫描消息数: ${scanCount}\n• 有效用户数: ${candidates.length}\n• 选中人数: ${winners.length}\n• 选中概率: ${probability}%\n• 耗时: ${seconds} 秒`;
                paginatedResponse = `点兵点将, 点到谁...\n${winners.map(user => user.name).join("\n")}${suffix}\n\n📊 统计信息:\n• 扫描消息数: ${scanCount}\n• 有效用户数: ${candidates.length}\n• 选中人数: ${winners.length}\n• 选中概率: ${probability}%\n• 耗时: ${seconds} 秒`;
              }
              const entityCount = response.match(/<a /g)?.length ?? 0;
              const rendered =
                response.length <= ui.MAX_HTML_LENGTH && entityCount <= ui.MAX_ENTITIES
                  ? [response]
                  : await ui.renderRichText(paginatedResponse ?? response, ui.PAGE_LABEL_RESERVE);
              const pages = rendered.map((page, index, all) => page + ui.pageLabel(index, all.length));
              const delivery = await ui.deliverPages(pages, signal, page =>
                context.telegram.reply(invocation.message, page, { parseMode: "html", linkPreview: false }),
              );
              if (delivery.interrupted) {
                context.log.info("dbdj_delivery_interrupted", {
                  published: delivery.published,
                  total: delivery.total,
                  category: ui.deliveryErrorCategory(delivery.error),
                });
                if (!delivery.published) throw delivery.error;
                try {
                  await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {
                    parseMode: "html",
                  });
                } catch {}
                return;
              }
              signal.throwIfAborted();
              if (typeof raw?.delete === "function") {
                try {
                  await raw.delete({ revoke: true });
                } catch {
                  context.log.error("dbdj_delete_failed");
                }
                signal.throwIfAborted();
              }
            });
          } catch {
            if (context.signal.aborted) return;
            context.log.error("dbdj_failed");
            await context.telegram.edit(invocation.message, "点兵点将失败，请稍后重试");
          }
        },
      },
    },
  });
}
