import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";
import type {Api as ApiTypes} from "teleproto";

const parseLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return 2000;
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, 2000) : undefined;
};

export default function createClearSticker() {
  const command: CommandDefinition = {
    description: "清理群组历史中的贴纸消息",
    args: "[数量]",
    arguments: [{name: "数量", description: "最多清理的贴纸消息数，默认 2000，上限 2000"}],
    examples: [{args: ""}, {args: "100"}],
    help: [
      {heading: "说明：", body: "扫描群组历史并删除贴纸消息，需要群组删除消息权限；未填写数量时最多清理 2000 条。"},
      {heading: "别名：", body: "<code>{prefix}cs [数量]</code> 与 clear_sticker 相同。"},
    ],
    async handle(invocation, context) {
      const maximum = parseLimit(invocation.args[0]);
      if (maximum === undefined || invocation.args.length > 1) {
        await context.telegram.edit(invocation.message, `请输入有效数量，例如：<code>${invocation.prefix}clear_sticker 100</code>`, {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, `正在查找贴纸消息，最多清理 ${maximum} 条…`);
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const {returnBigInt} = await import("teleproto/Helpers.js");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          let offsetId = 0;
          let deleted = 0;
          while (deleted < maximum) {
            signal.throwIfAborted();
            const history = await client.invoke(new Api.messages.GetHistory({
              peer: raw.peerId, offsetId, offsetDate: 0, addOffset: 0, limit: 100,
              maxId: 0, minId: 0, hash: returnBigInt(0),
            })) as {messages?: unknown[]};
            if (!Array.isArray(history.messages) || history.messages.length === 0) break;
            const ids: number[] = [];
            for (const value of history.messages) {
              if (!(value instanceof Api.Message) || !(value.media instanceof Api.MessageMediaDocument)) continue;
              const document = value.media.document;
              if (document instanceof Api.Document && document.attributes?.some(attribute => attribute instanceof Api.DocumentAttributeSticker)) ids.push(value.id);
            }
            const selected = ids.slice(0, maximum - deleted);
            if (selected.length) {
              await client.deleteMessages(raw.peerId, selected, {revoke: true});
              deleted += selected.length;
              await context.telegram.edit(invocation.message, `正在清理贴纸消息… ${deleted}/${maximum}`);
            }
            const last = history.messages.at(-1);
            if (!(last instanceof Api.Message) || history.messages.length < 100) break;
            offsetId = last.id;
            if (deleted < maximum) await delay(1200, undefined, {signal});
          }
          await context.telegram.edit(invocation.message, deleted ? `清理完成，共删除 ${deleted} 条贴纸消息` : "未找到贴纸消息");
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("clear_sticker_failed");
        await context.telegram.edit(invocation.message, "清理贴纸消息失败，请检查群组权限");
      }
    }};
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "clear_sticker", description: "清理群组历史中的贴纸消息",
    renderHelp: prefix => renderCommandHelp("clear_sticker", command, {prefix, title: "清理贴纸消息"}),
    commands: {clear_sticker: command, cs: command},
  });
}
