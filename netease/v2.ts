import {setTimeout as delay} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const BOT = "Music163bot";
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function botCommand(input: string): string {
  if (/^\d+$/.test(input)) return `/music ${input}`;
  const id = /(?:song\?id=|\/song\/)(\d+)/.exec(input)?.[1];
  return id ? `/music ${id}` : `/search ${input}`;
}


async function recent(client: any): Promise<ApiTypes.Message[]> {
  return await client.getMessages(BOT, {limit: 6}) as ApiTypes.Message[];
}

export default function createNetease() {
  const command: CommandDefinition = {
    args: "关键词|歌曲链接|歌曲ID", arguments: [{name: "输入", description: "按关键词搜索并返回音频，或解析网易云歌曲链接与数字 ID"}],
    examples: [{args: "晴天"}, {args: "https://music.163.com/#/song?id=123456"}, {args: "123456"}],
    help: [{heading: "依赖：", body: "通过 @Music163bot 搜索和发送音乐，插件会与该机器人交互。"}],
    helpArgs: ["help","h"], description: "搜索和发送网易云音乐", async handle(invocation, context) {
      const keyword = invocation.args.join(" ").trim();
      if (!keyword || ["help", "h"].includes(keyword.toLowerCase())) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在获取音乐…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          try { await client.invoke(new Api.contacts.Unblock({id: BOT})); } catch {}
          try { await client.invoke(new Api.messages.StartBot({bot: BOT, peer: BOT, startParam: ""})); } catch {}
          const started = Math.floor(Date.now() / 1000) - 1;
          await client.sendMessage(BOT, {message: botCommand(keyword)});
          let buttons: ApiTypes.Message | undefined;
          let media: ApiTypes.Message | undefined;
          for (let attempt = 0; attempt < 20 && !media && !buttons; attempt++) {
            await delay(700, undefined, {signal});
            for (const message of (await recent(client)).slice().reverse()) {
              if (message.out || Number(message.date ?? 0) < started) continue;
              if (message.media) media = message;
              else if ((message.buttonCount ?? 0) > 0) buttons = message;
            }
          }
          if (!media && buttons) {
            await buttons.click({});
            for (let attempt = 0; attempt < 20 && !media; attempt++) {
              await delay(700, undefined, {signal});
              media = (await recent(client)).slice().reverse().find(message =>
                !message.out && Boolean(message.media) && Number(message.date ?? 0) >= Number(buttons!.date ?? started));
            }
          }
          if (!media?.media) {
            await context.telegram.edit(invocation.message, "未获取到音乐文件，请稍后重试");
            return;
          }
          const caption = (media.message ?? "").replace(/\s*via\s+@Music163bot\s*$/i, "").trim() || `🎵 ${keyword}`;
          await client.sendFile(raw.peerId, {file: media.media, caption, replyTo: invocation.message.replyToId});
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("netease_failed");
        await context.telegram.edit(invocation.message, "网易云音乐获取失败，请稍后重试");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("netease", command, {prefix, title: "🎵 网易云音乐"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "netease", description: "通过 Music163bot 搜索和发送网易云音乐",
    commands: {netease: command},
  });
}
