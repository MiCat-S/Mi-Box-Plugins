import {renderHelp as renderPluginHelp} from "./v2/help";
import {writeFile} from "node:fs/promises";
import {definePlugin} from "telebox/sdk";

const help = renderPluginHelp;

export default function createKeepOnline() {
  let lastSuccess = 0;
  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "keep_online",
    description: "定时验证 Telegram 会话并写入在线时间戳",
    commands: {
      keep_online: {
        description: "查看在线状态探针",
        async handle(invocation, context) {
          const status = lastSuccess
            ? `\n\n最近成功：<code>${new Date(lastSuccess).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})}</code>`
            : "\n\n最近成功：等待首次探测";
          await context.telegram.edit(invocation.message, `${help(invocation.prefix)}${status}`, {parseMode: "html"});
        },
      },
    },
    jobs: {
      keep_online: {
        cron: "55 * * * * *",
        description: "每分钟验证会话并更新时间戳",
        async handle(context, signal) {
          try {
            await context.telegram.withClient(async client => {
              signal.throwIfAborted();
              await client.getMe();
              signal.throwIfAborted();
            });
            const timestamp = Date.now();
            const file = await context.files.dataFile("keep_online.txt");
            signal.throwIfAborted();
            await writeFile(file, String(Math.floor(timestamp / 1000)), {encoding: "utf8", mode: 0o600});
            signal.throwIfAborted();
            lastSuccess = timestamp;
          } catch {
            if (!signal.aborted) context.log.error("keep_online_probe_failed");
          }
        },
      },
    },
  });
}
