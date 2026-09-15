import type {Api} from "teleproto";
import {renderHelp} from "./v2/help";
import {createAbanRuntime} from "./v2/runtime";
import {definePlugin, type CommandInvocation, type PluginContext} from "telebox/sdk";

// 这两次 import 原来在每次命令的 withClient 里现取；连 help 都因此要等一遍模块解析。
// 挪到模块级只解析一次，命令路径上就只剩构造 peer。
let teleprotoPromise: Promise<typeof import("teleproto")> | null = null;
function ensureTeleproto(): Promise<typeof import("teleproto")> {
  teleprotoPromise ??= import("teleproto");
  return teleprotoPromise;
}

let integerPromise: Promise<(value: any) => any> | null = null;
function ensureInteger(): Promise<(value: any) => any> {
  integerPromise ??= import("teleproto/Helpers.js").then((m) => m.returnBigInt);
  return integerPromise;
}

const commands = {aban: "封禁管理帮助", kick: "踢出", ban: "封禁", unban: "解封", mute: "禁言",
  unmute: "解除禁言", sb: "批量封禁", unsb: "批量解封", refresh: "刷新管理群缓存"};

export default function createAban() {
  const handle = async (inv: CommandInvocation, ctx: PluginContext) => {
    const run = async () => {
      const runtime = await createAbanRuntime(ctx, inv);
      await ctx.telegram.withClient(async (native, signal) => {
        const client = new Proxy(native, {get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            signal.throwIfAborted();
            const result = await value.apply(target, args);
            signal.throwIfAborted();
            return result;
          };
        }});
        const {Api} = await ensureTeleproto();
        const integer = await ensureInteger();
        const chat = inv.message.chatId;
        const raw = inv.message.raw as Api.Message | undefined;
        const peerId = raw?.peerId ?? (chat.startsWith("-100")
          ? new Api.PeerChannel({channelId: integer(chat.slice(4))}) : chat.startsWith("-")
          ? new Api.PeerChat({chatId: integer(chat.slice(1))}) : new Api.PeerUser({userId: integer(chat)}));
        const message = Object.create(raw ?? null);
        Object.defineProperties(message, {
          id: {value: inv.message.id}, peerId: {value: peerId},
          message: {value: [inv.prefix + inv.command, ...inv.args].join(" ")},
          isChannel: {value: raw?.isChannel ?? peerId instanceof Api.PeerChannel},
          isGroup: {value: raw?.isGroup ?? (peerId instanceof Api.PeerChannel || peerId instanceof Api.PeerChat)},
        });
        if (inv.command === "aban" || ["help", "h"].includes(inv.args[0] ?? "")) {
          // 与原版 .aban 一致：帮助回执走受管 smartEdit，默认 10 秒后清理
          await runtime.MessageManager.smartEdit(message, renderHelp(inv.prefix));
          signal.throwIfAborted();
          return;
        }
        if (inv.command === "refresh") {
          await runtime.GroupManager.clearCache();
          // accessHash 也是缓存的一部分：不一起清掉，refresh 之后还是在用旧 hash 构造 InputChannel
          runtime.resetChannelInputCache();
          const groups = await runtime.GroupManager.getManagedGroups(client);
          await runtime.MessageManager.smartEdit(message, `✅ 已刷新 ${groups.length} 个有管理权的群组`);
        } else if (inv.command === "sb") await runtime.CommandHandlers.handleSuperBan(client, message);
        else if (inv.command === "unsb") await runtime.CommandHandlers.handleSuperUnban(client, message);
        else await runtime.CommandHandlers.handleBasicCommand(client, message, inv.command as "ban" | "kick" | "unban" | "mute" | "unmute");
        signal.throwIfAborted();
      });
    };
    if (inv.command === "sb" || inv.command === "unsb") {
      void ctx.tasks.run("aban:batch", run).catch(() => {if (!ctx.signal.aborted) ctx.log.error("aban:batch");});
    } else await run();
  };
  return definePlugin({apiVersion: 1, id: "aban", description: "封禁管理", renderHelp,
    commands: Object.fromEntries(Object.entries(commands).map(([name, description]) =>
      [name, {description, ignoreEdited: true, handle}])),
  });
}
