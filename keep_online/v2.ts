import {writeFile} from "node:fs/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";


export default function createKeepOnline() {
  let lastSuccess = 0;
  const command: CommandDefinition = {
    args: "", examples: [{args: ""}],
    help: [{heading: "探测：", body: "每分钟第 55 秒验证 Telegram 会话，成功后更新 <code>assets/keep_online/keep_online.txt</code>，文件内容为秒级 Unix 时间戳。外部定时任务可据此判断是否需要重启服务；路径须对应部署时的挂载位置。命令显示最近成功探测时间。"}],

        description: "查看在线状态探针",
        async handle(invocation, context) {
          const status = lastSuccess
            ? `\n\n最近成功：<code>${new Date(lastSuccess).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})}</code>`
            : "\n\n最近成功：等待首次探测";
          await context.telegram.edit(invocation.message, `${help(invocation.prefix)}${status}`, {parseMode: "html"});
        },
      };
  const help = (prefix: string) => renderCommandHelp("keep_online", command, {prefix, title: "🟢 在线状态探针"});
  return definePlugin({renderHelp: help,
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "keep_online",
    description: "定时验证 Telegram 会话并写入在线时间戳",
    commands: {
      keep_online: command,
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
