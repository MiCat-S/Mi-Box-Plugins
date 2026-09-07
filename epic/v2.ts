import {definePlugin, type PluginContext} from "telebox/sdk";

const ENDPOINT = "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN";
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
type Game = {title: string; description: string; originalPrice: string; startDate: string; endDate: string; url: string};

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function games(data: unknown): Game[] {
  const root = object(data);
  const elements = root?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new Error("Invalid response");
  const result: Game[] = [];
  for (const value of elements) {
    const game = object(value);
    if (!game || !Array.isArray(game.categories) || !game.categories.some((item: unknown) => object(item)?.path === "freegames")) continue;
    const price = object(game.price)?.totalPrice;
    const promotion = game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
    if (!promotion || price?.discountPrice !== 0) continue;
    const slug = game.offerMappings?.[0]?.pageSlug ?? game.catalogNs?.mappings?.[0]?.pageSlug ?? game.productSlug ?? game.urlSlug;
    result.push({
      title: typeof game.title === "string" && game.title ? game.title : "未知游戏",
      description: typeof game.description === "string" ? game.description : "",
      originalPrice: typeof price?.fmtPrice?.originalPrice === "string" ? price.fmtPrice.originalPrice : "未知",
      startDate: String(promotion.startDate ?? ""), endDate: String(promotion.endDate ?? ""),
      url: typeof slug === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(slug) ? `https://store.epicgames.com/zh-CN/p/${slug}` : "",
    });
  }
  return result;
}

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "时间未知" : parsed.toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false});
}

function render(items: readonly Game[]): string {
  if (!items.length) return "🎮 <b>Epic Games 限免游戏</b>\n\n当前暂无可领取的限免游戏";
  const sections = items.map((game, index) => {
    const description = game.description.length > 120 ? `${game.description.slice(0, 120)}…` : game.description;
    const link = game.url ? `\n<a href="${escape(game.url)}">前往领取</a>` : "";
    return `<b>${index + 1}. ${escape(game.title)}</b>\n原价：<code>${escape(game.originalPrice)}</code> → <b>免费</b>\n时间：${escape(date(game.startDate))} 至 ${escape(date(game.endDate))}${description ? `\n${escape(description)}` : ""}${link}`;
  });
  return `🎮 <b>Epic Games 限免游戏</b>\n\n${sections.join("\n\n")}`.slice(0, 4090);
}

async function query(context: PluginContext): Promise<Game[]> {
  const data = await context.http.json<unknown>(ENDPOINT, {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: {Accept: "application/json", "User-Agent": "MiBot-Epic/2.0"},
  }, {timeoutMs: 15_000, signal: context.signal, redirects:{allowedHosts:["store-site-backend-static-ipv4.ak.epicgames.com"],maxRedirects:2}});
  return games(data);
}

export default function createEpic() {
  return definePlugin({apiVersion: 1, id: "epic", description: "查看 Epic Games 当前限免游戏",
    commands: {epic: {description: "查看 Epic Games 当前限免游戏", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>Epic 限免游戏</b>\n<code>${escape(invocation.prefix)}epic</code> 查看当前限免`, {parseMode: "html"});
        return;
      }
      await context.telegram.edit(invocation.message, "正在获取 Epic 限免游戏…");
      try {
        await context.telegram.edit(invocation.message, render(await query(context)), {parseMode: "html", linkPreview: false});
      } catch {
        if (context.signal.aborted) return;
        context.log.error("epic_query_failed");
        await context.telegram.edit(invocation.message, "<b>获取限免失败</b>\n请稍后重试", {parseMode: "html"});
      }
    }}},
  });
}
