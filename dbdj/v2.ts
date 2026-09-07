import {definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

const positive = (value: string | undefined, maximum: number): number | undefined => {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
};

function sample<T>(values: T[], count: number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const selected = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[selected]] = [copy[selected]!, copy[index]!];
  }
  return copy.slice(0, count);
}

export default function createDbdj() {
  return definePlugin({apiVersion: 1, id: "dbdj", description: "从近期发言者中随机抽取用户",
    commands: {dbdj: {description: "从近期发言者中随机抽取用户", async handle(invocation, context) {
      const scanCount = positive(invocation.args[0], 1000);
      const pickCount = positive(invocation.args[1], 100);
      if (!scanCount || !pickCount) {
        await context.telegram.edit(invocation.message,
          `<b>点兵点将</b>\n<code>${escape(invocation.prefix)}dbdj 消息数 人数 [文案]</code>\n例如：<code>${escape(invocation.prefix)}dbdj 50 2 恭喜发财</code>`,
          {parseMode: "html"});
        return;
      }
      const note = invocation.args.slice(2).join(" ").trim();
      const started = Date.now();
      try {
        await context.telegram.edit(invocation.message, "点兵点将…");
        await context.telegram.withClient(async (client, signal) => {
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const messages = await client.getMessages(raw.peerId, {limit: scanCount, offsetId: Math.max(0, invocation.message.id - 1)});
          const ids = new Map<string, unknown>();
          for (const message of messages) {
            signal.throwIfAborted();
            const fromId = (message as Api.Message).fromId;
            const id = fromId && "userId" in fromId ? fromId.userId : undefined;
            if (id !== undefined) ids.set(String(id), id);
          }
          const candidates: Array<{id: string; name: string}> = [];
          for (const [id, nativeId] of ids) {
            signal.throwIfAborted();
            try {
              const entity = await client.getEntity(nativeId as never) as Api.User;
              if (entity.bot || entity.deleted || entity.fake || entity.scam) continue;
              const name = entity.username ? `@${escape(entity.username)}` : escape(`${entity.firstName ?? ""} ${entity.lastName ?? ""}`.trim() || id);
              candidates.push({id, name});
            } catch { context.log.error("dbdj_entity_skipped"); }
          }
          if (!candidates.length) {
            await context.telegram.reply(invocation.message, `最近 ${scanCount} 条消息中没有可抽取的有效用户`, {parseMode: "html"});
          } else {
            const winners = sample(candidates, Math.min(pickCount, candidates.length));
            const mentions = winners.map(user => `<a href="tg://user?id=${escape(user.id)}">${user.name}</a>`).join("、");
            const probability = (winners.length / candidates.length * 100).toFixed(2);
            const suffix = note ? ` ${escape(note)}` : "";
            await context.telegram.reply(invocation.message,
              `<b>点兵点将</b>\n${mentions}${suffix}\n\n扫描 ${scanCount} 条 · 有效 ${candidates.length} 人 · 选中 ${winners.length} 人 · 概率 ${probability}% · ${(Date.now() - started) / 1000}s`,
              {parseMode: "html", linkPreview: false});
          }
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("dbdj_failed");
        await context.telegram.edit(invocation.message, "点兵点将失败，请稍后重试");
      }
    }}},
  });
}
