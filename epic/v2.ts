import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type PluginContext } from "telebox/sdk";

const ENDPOINT =
  "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
type Game = {
  title: string;
  description: string;
  originalPrice: string;
  startDate: string;
  endDate: string;
  url: string;
};
type ReadResult = { done: boolean; value?: Uint8Array };

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  cancel: () => Promise<void>,
): Promise<ReadResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      void cancel();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function games(data: unknown): Game[] {
  const root = object(data);
  const elements = root?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new Error("Invalid response");
  const result: Game[] = [];
  for (const value of elements) {
    const game = object(value);
    if (
      !game ||
      !Array.isArray(game.categories) ||
      !game.categories.some((item: unknown) => object(item)?.path === "freegames")
    )
      continue;
    const price = object(game.price)?.totalPrice;
    const promotion = game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
    if (!promotion || price?.discountPrice !== 0) continue;
    const slug =
      game.offerMappings?.[0]?.pageSlug ?? game.catalogNs?.mappings?.[0]?.pageSlug ?? game.productSlug ?? game.urlSlug;
    result.push({
      title: typeof game.title === "string" && game.title ? game.title : "未知游戏",
      description: typeof game.description === "string" ? game.description : "",
      originalPrice:
        typeof price?.fmtPrice?.originalPrice === "string" && price.fmtPrice.originalPrice
          ? price.fmtPrice.originalPrice
          : "免费",
      startDate: String(promotion.startDate ?? ""),
      endDate: String(promotion.endDate ?? ""),
      url:
        typeof slug === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(slug)
          ? `https://store.epicgames.com/zh-CN/p/${slug}`
          : "",
    });
  }
  return result;
}

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "时间未知"
    : parsed.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

async function render(items: readonly Game[]): Promise<readonly string[]> {
  const header = "🎮 <b>Epic Games 限免游戏</b>\n\n";
  if (!items.length) return [`${header}📢 <b>当前限免:</b> 暂无\n\n`];
  const blocks: string[] = [];
  const wrapperReserve = ui.PAGE_LABEL_RESERVE + 2;
  for (const [index, game] of items.entries()) {
    const characters = [...game.description];
    const description = characters.length > 100 ? `${characters.slice(0, 100).join("")}...` : game.description;
    const link = game.url ? `\n<a href="${escape(game.url)}">🔗 领取</a>` : "";
    const block = `<b>${index + 1}. ${escape(game.title)}</b>\n💰 原价: <code>${escape(game.originalPrice)}</code> → <b>免费</b>\n📅 ${escape(date(game.startDate))} ~ ${escape(date(game.endDate))}\n${escape(description)}${link}`;
    blocks.push(...(await ui.renderRichText(block, wrapperReserve)));
  }
  const pages: string[] = [];
  let page = `${header}📢 <b>当前限免:</b>`;
  const limit = ui.MAX_HTML_LENGTH - wrapperReserve;
  for (const block of blocks) {
    if (page.length + block.length + 2 > limit) {
      pages.push(page);
      page = block;
    } else page += `\n\n${block}`;
  }
  if (page) pages.push(`${page}\n\n`);
  return pages.map((page, index, all) => page + ui.pageLabel(index, all.length));
}

async function query(context: PluginContext): Promise<Game[]> {
  const data = await context.http.withResponse(
    ENDPOINT,
    {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/json", "User-Agent": "MiBot-Epic/2.0" },
    },
    async (response, signal) => {
      if (!response.ok || !response.body) throw new Error("Epic response unavailable");
      const reader = response.body.getReader();
      let cancelPromise: Promise<void> | undefined;
      const cancel = () =>
        (cancelPromise ??= reader.cancel().then(
          () => undefined,
          () => undefined,
        ));
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await readChunk(reader, signal, cancel);
          signal.throwIfAborted();
          if (chunk.done) break;
          if (!chunk.value) continue;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("Epic response too large");
          chunks.push(chunk.value);
        }
      } finally {
        await cancel();
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    },
    {
      timeoutMs: 15_000,
      signal: context.signal,
      redirects: { allowedHosts: ["store-site-backend-static-ipv4.ak.epicgames.com"], maxRedirects: 2 },
    },
  );
  return games(data);
}

export default function createEpic() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "epic",
    description: "查看 Epic Games 当前限免游戏",
    commands: {
      epic: {
        helpArgs: ["help", "h"],
        description: "查看 Epic Games 当前限免游戏",
        async handle(invocation, context) {
          if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
            await context.telegram.edit(
              invocation.message,
              `<b>Epic 限免游戏</b>\n<code>${escape(invocation.prefix)}epic</code> 查看当前限免`,
              { parseMode: "html" },
            );
            return;
          }
          await context.telegram.edit(invocation.message, "🎮 获取 Epic 限免游戏中...", { parseMode: "html" });
          try {
            const pages = await render(await query(context));
            const delivery = await ui.deliverPages(pages, context.signal, (page, index) =>
              index
                ? context.telegram.reply(invocation.message, page, { parseMode: "html", linkPreview: false })
                : context.telegram.edit(invocation.message, page, { parseMode: "html", linkPreview: false }),
            );
            if (delivery.interrupted) {
              context.log.info("pagination_delivery_interrupted", {
                plugin: "epic",
                published: delivery.published,
                total: delivery.total,
                category: ui.deliveryErrorCategory(delivery.error),
              });
              if (!delivery.published) throw delivery.error;
              try {
                await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), { parseMode: "html" });
              } catch {}
            }
          } catch {
            if (context.signal.aborted) return;
            context.log.error("epic_query_failed");
            await context.telegram.edit(invocation.message, "❌ <b>获取失败:</b> 网络错误", { parseMode: "html" });
          }
        },
      },
    },
  });
}
