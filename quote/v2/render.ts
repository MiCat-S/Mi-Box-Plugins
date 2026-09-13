import {generateQuote} from "../generate.js";
import {withCanvasBudget} from "../vendor/canvas.js";
import {withAssetRoot} from "../vendor/emoji-image.js";

export interface QuoteRenderOptions {
  readonly format: "webp" | "png" | "story";
  readonly background: string;
  readonly scale: number;
  readonly hidden?: boolean;
  readonly crop?: boolean;
  readonly emojiBrand: string;
}

export async function renderQuote(
  messages: readonly Record<string, any>[],
  options: QuoteRenderOptions,
  signal: AbortSignal,
  assetRoot: string,
): Promise<Buffer> {
  signal.throwIfAborted();
  const type = options.format === "story" ? "stories" : options.format === "png" ? "image" : "quote";
  const format = options.format === "webp" ? "webp" : "png";
  const result = await withAssetRoot(assetRoot, () => withCanvasBudget(signal, () => generateQuote({
    messages, type, format, scale: options.scale,
    backgroundColor: options.background,
    emojiBrand: options.emojiBrand,
    assetRoot,
  })));
  signal.throwIfAborted();
  if (!result?.image) throw new Error("QUOTE_RENDER_FAILED");
  return Buffer.from(result.image);
}
