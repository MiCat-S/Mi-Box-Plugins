import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";

type Hitokoto = {hitokoto: unknown; type?: unknown; from?: unknown; from_who?: unknown};
const types: Readonly<Record<string, string>> = {
  a: "动画", b: "漫画", c: "游戏", d: "文学", e: "原创", f: "网络",
  g: "其他", h: "影视", i: "诗词", j: "网易云", k: "哲学", l: "抖机灵",
};

function escape(value: string): string {
  return value.replace(/[&<>\"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}


function parseTypes(args: readonly string[]): string[] | undefined {
  const selected = [...new Set(args.map(value => value.toLowerCase()))];
  if (selected.some(value => !Object.hasOwn(types, value))) throw new Error("类型参数无效");
  return selected.length ? selected : undefined;
}

function resultText(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("接口返回格式无效");
  const value = data as Hitokoto;
  if (typeof value.hitokoto !== "string" || !value.hitokoto.trim() || value.hitokoto.length > 2000) {
    throw new Error("接口返回内容无效");
  }
  const source = typeof value.from === "string" && value.from ? `《${escape(value.from.slice(0, 200))}》` : "";
  const kind = typeof value.type === "string" && types[value.type] ? `（${types[value.type]}）` : "";
  const author = typeof value.from_who === "string" && value.from_who ? ` - ${escape(value.from_who.slice(0, 100))}` : "";
  const detail = source || kind || author ? `\n\n<b>来源：</b>${source}${kind}${author}` : "";
  return `💬 ${escape(value.hitokoto)}${detail}`;
}

async function fetchHitokoto(ctx: PluginContext, selected: string[] | undefined): Promise<string> {
  const url = new URL("https://v1.hitokoto.cn/");
  url.searchParams.set("charset", "utf-8");
  if (selected?.length === 1) url.searchParams.set("c", selected[0]);
  if (selected && selected.length > 1) for (const type of selected) url.searchParams.append("c", type);
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    ctx.signal.throwIfAborted();
    try {
      const data = await ctx.http.json<unknown>(url, {
        method: "GET", redirect: "manual", credentials: "omit",
        headers: {"Accept": "application/json", "User-Agent": "Mi-Box-Hitokoto/1.0"},
      }, {timeoutMs: 10_000, signal: ctx.signal, redirects:{allowedHosts:["v1.hitokoto.cn"],maxRedirects:2}});
      return resultText(data);
    } catch (error) {
      last = error;
      ctx.signal.throwIfAborted();
      if (attempt < 9) await delay(1000, undefined, {signal: ctx.signal});
    }
  }
  throw last instanceof Error ? last : new Error("请求失败");
}

const hitokotoCommand: CommandDefinition = {
  description: "获取随机一言",
  helpArgs: ["help", "h"],
  args: "[类型...]",
  arguments: [{name: "类型", description: `可选，可多选：${Object.entries(types).map(([key, value]) => `${key}=${value}`).join("、")}`}],
  examples: [{args: ""}, {args: "a"}, {args: "a c"}, {args: "a c h"}],
  help: [{heading: "说明：", body: "从 v1.hitokoto.cn 获取随机一言，只接受类型字母参数，可多选；显示句子出处和作者（API 提供时）。失败时自动重试，最多请求 10 次。"}],
  async handle(invocation, ctx) {
      const args = invocation.args.map(value => value.trim()).filter(Boolean);
      if (args[0]?.toLowerCase() === "help" || args[0]?.toLowerCase() === "h") {
        await ctx.telegram.edit(invocation.message, renderCommandHelp("hitokoto", hitokotoCommand, {prefix: invocation.prefix, title: "💬 一言"}), {parseMode: "html"});
        return;
      }
      try {
        const selected = parseTypes(args);
        await ctx.telegram.edit(invocation.message, "正在获取一言…");
        await ctx.telegram.edit(invocation.message, await fetchHitokoto(ctx, selected), {parseMode: "html"});
      } catch (error) {
        if (ctx.signal.aborted) return;
        const message = error instanceof Error && error.message === "类型参数无效" ? error.message : "获取一言失败，请稍后重试";
        await ctx.telegram.edit(invocation.message, `<b>一言失败</b>\n${escape(message)}`, {parseMode: "html"});
      }
    },
};
export default function createHitokoto() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "hitokoto", description: "获取随机一言并按类型筛选",
    renderHelp: prefix => renderCommandHelp("hitokoto", hitokotoCommand, {prefix, title: "💬 一言"}),
    commands: {hitokoto: hitokotoCommand},
  });
}
