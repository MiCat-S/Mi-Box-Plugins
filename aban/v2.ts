import type {Api} from "teleproto";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {createAbanRuntime} from "./v2/runtime";

const meta: Record<string, {description: string; args?: string; arguments?: readonly {name: string; required?: boolean; description?: string}[]; examples?: readonly {args?: string; description?: string}[]; help?: readonly {heading?: string; body: string}[]}> = {
  aban: {description: "查看封禁管理帮助", args: "", examples: [{args: "", description: "查看完整封禁管理指南"}],
    help: [{heading: "目标与范围：", body: "目标：回复消息 / @用户名 / 用户ID；管理员目标需追加 <code>true</code>。\n基本群仅支持踢出；ban/sb 在基本群执行移出，不会阻止再次加入。"}]},
  kick: {description: "踢出", args: "[目标]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}], examples: [{args: "@username"}, {args: "123456789"}]},
  ban: {description: "封禁并清理消息", args: "[目标] [true]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}, {name: "true", description: "管理员目标需追加 true"}], examples: [{args: "@username"}, {args: "123456789 true"}]},
  unban: {description: "解封", args: "[目标]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}], examples: [{args: "@username"}]},
  mute: {description: "禁言，时长如 60s / 5m / 1h / 1d；省略为永久", args: "[目标] [时长]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}, {name: "时长", description: "60s / 5m / 1h / 1d；省略为永久"}], examples: [{args: "@username 1h"}, {args: "123456789 60s"}]},
  unmute: {description: "解除禁言", args: "[目标]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}], examples: [{args: "@username"}]},
  sb: {description: "在所有有管理权的群/频道封禁，并清理当前群消息", args: "[目标] [true]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}, {name: "true", description: "管理员目标需追加 true"}], examples: [{args: "@username"}, {args: "123456789 true"}]},
  unsb: {description: "批量解封", args: "[目标]", arguments: [{name: "目标", description: "回复消息 / @用户名 / 用户ID"}], examples: [{args: "@username"}]},
  refresh: {description: "刷新管理群缓存", args: "", examples: [{args: "", description: "刷新有管理权的群组缓存"}]},
};

export default function createAban() {
  const commands: Record<string, CommandDefinition> = Object.fromEntries(Object.entries(meta).map(([name, value]) => [name, {
    description: value.description, ignoreEdited: true,
    ...(value.args !== undefined ? {args: value.args} : {}),
    ...(value.arguments ? {arguments: value.arguments} : {}),
    ...(value.examples ? {examples: value.examples} : {}),
    ...(value.help ? {help: value.help} : {}),
  } as CommandDefinition]));
  const renderModuleHelp = (prefix: string): string => [
    "<b>🛡️ 封禁管理</b>",
    ...Object.entries(commands).map(([name, command]) => renderCommandHelp(name, command, {prefix})),
  ].join("\n\n");
  const handle = async (inv: CommandInvocation, ctx: PluginContext) => {
    if (inv.command === "aban" || ["help", "h"].includes(inv.args[0] ?? "")) {
      await ctx.telegram.edit(inv.message, renderModuleHelp(inv.prefix), {parseMode: "html", linkPreview: false});
      return;
    }
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
        const {Api} = await import("teleproto");
        const {returnBigInt: integer} = await import("teleproto/Helpers.js");
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
        if (inv.command === "refresh") {
          await runtime.GroupManager.clearCache();
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
  for (const name of Object.keys(commands)) commands[name] = Object.freeze({...commands[name]!, handle});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "aban", description: "封禁管理", renderHelp: renderModuleHelp,
    commands,
  });
}
