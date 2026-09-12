export interface QuoteReplyPreview {
  readonly sender: string;
  readonly text: string;
}

export interface QuoteRenderMessage {
  readonly senderId: string;
  readonly sender: string;
  readonly text: string;
  readonly tag?: string;
  readonly reply?: QuoteReplyPreview;
  readonly mediaLabel?: string;
  readonly media?: Buffer;
}

export interface QuoteRenderOptions {
  readonly format: "webp" | "png" | "story";
  readonly background?: string;
  readonly scale: number;
  readonly hidden?: boolean;
  readonly crop?: boolean;
}

const WIDTH = 720;
const CARD_WIDTH = 648;
const MAX_HEIGHT = 16_000;
const MAX_CANVAS_PIXELS = 20_000_000;

function roundedRectangle(context: any, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function linesFor(context: any, text: string, width: number): string[] {
  const paragraphs = String(text || " ").replace(/\r/g, "").split("\n");
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { result.push(" "); continue; }
    let line = "";
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > width) {
        result.push(line);
        line = character;
      } else line = candidate;
    }
    result.push(line || " ");
  }
  return result;
}

function colorSeed(value: string): string {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 62%)`;
}

function paintBackground(context: any, width: number, height: number, requested?: string): void {
  const value = requested?.trim();
  if (value && (/^#[0-9a-f]{3,8}$/i.test(value) || /^(?:rgb|hsl)a?\(/i.test(value))) {
    context.fillStyle = value;
    context.fillRect(0, 0, width, height);
    return;
  }
  const presets: Record<string, readonly [string, string]> = {
    dusk: ["#312e81", "#be185d"], ocean: ["#075985", "#0f766e"], forest: ["#14532d", "#365314"],
    graphite: ["#111827", "#374151"], sunrise: ["#c2410c", "#db2777"],
  };
  const key = value === "random" ? Object.keys(presets)[Math.floor(Math.random() * Object.keys(presets).length)] : value;
  const pair = presets[key || "dusk"] || presets.dusk;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, pair[0]); gradient.addColorStop(1, pair[1]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

export async function renderQuote(messages: readonly QuoteRenderMessage[], options: QuoteRenderOptions): Promise<Buffer> {
  const moduleName = "canvas";
  let canvasModule: any;
  try { canvasModule = await import(moduleName); }
  catch { throw new Error("服务器未安装 quote 所需的 canvas 运行依赖"); }

  const measureCanvas = canvasModule.createCanvas(1, 1);
  const measure = measureCanvas.getContext("2d");
  measure.font = "30px sans-serif";

  const layouts = messages.map(message => {
    const body = linesFor(measure, message.text || (message.mediaLabel ? "" : "（无文字）"), CARD_WIDTH - 64);
    measure.font = "23px sans-serif";
    const reply = message.reply ? linesFor(measure, `${message.reply.sender}: ${message.reply.text || "（媒体）"}`, CARD_WIDTH - 92).slice(0, 3) : [];
    measure.font = "30px sans-serif";
    const mediaHeight = message.media ? 260 : message.mediaLabel ? 50 : 0;
    return {message, body, reply, height: (options.hidden ? 24 : 86) + body.length * 40 + (reply.length ? 34 + reply.length * 30 : 0) + mediaHeight + 30};
  });
  const scale = Math.max(1, Math.min(3, options.scale));
  const rawHeight = 72 + layouts.reduce((total, layout) => total + layout.height + 24, 0);
  if (rawHeight * scale > MAX_HEIGHT || WIDTH * scale * rawHeight * scale > MAX_CANVAS_PIXELS) throw new Error("引用内容过长，请减少消息数量、文字长度或缩放倍数");
  const canvas = canvasModule.createCanvas(WIDTH * scale, rawHeight * scale);
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  if (options.format !== "webp") paintBackground(context, WIDTH, rawHeight, options.background);

  let y = 36;
  for (const layout of layouts) {
    const {message, body, reply} = layout;
    context.save();
    context.shadowColor = "rgba(0,0,0,.30)";
    context.shadowBlur = 18;
    roundedRectangle(context, 36, y, CARD_WIDTH, layout.height, 28);
    context.fillStyle = options.format === "webp" ? "rgba(25,30,42,.94)" : "rgba(17,24,39,.72)";
    context.fill();
    context.restore();

    if (!options.hidden) {
      context.beginPath(); context.arc(76, y + 45, 22, 0, Math.PI * 2);
      context.fillStyle = colorSeed(message.senderId); context.fill();
      context.fillStyle = "#ffffff"; context.font = "bold 22px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(Array.from(message.sender.trim() || "?")[0] || "?", 76, y + 46);
      context.textAlign = "left"; context.textBaseline = "alphabetic";
      context.fillStyle = "#ffffff"; context.font = "bold 27px sans-serif";
      context.fillText(message.sender.slice(0, 48), 112, y + 54, 440);
      if (message.tag) {
        context.font = "18px sans-serif"; context.fillStyle = "rgba(255,255,255,.72)";
        context.fillText(message.tag.slice(0, 35), 112, y + 78, 450);
      }
    }

    let cursor = y + (options.hidden ? 36 : 106);
    if (reply.length) {
      context.fillStyle = "rgba(255,255,255,.10)"; roundedRectangle(context, 64, cursor - 20, CARD_WIDTH - 56, 24 + reply.length * 30, 12); context.fill();
      context.fillStyle = "rgba(255,255,255,.76)"; context.font = "23px sans-serif";
      for (const line of reply) { context.fillText(line, 82, cursor + 6, CARD_WIDTH - 92); cursor += 30; }
      cursor += 20;
    }
    context.fillStyle = "#f8fafc"; context.font = "30px sans-serif";
    for (const line of body) { context.fillText(line, 68, cursor + 26, CARD_WIDTH - 64); cursor += 40; }
    if (message.media) {
      const image = await canvasModule.loadImage(message.media);
      const boxWidth = CARD_WIDTH - 64, boxHeight = 240;
      const ratio = Math.min(boxWidth / image.width, boxHeight / image.height);
      const drawWidth = Math.max(1, image.width * ratio), drawHeight = Math.max(1, image.height * ratio);
      context.save(); roundedRectangle(context, 68, cursor + 14, boxWidth, boxHeight, 16); context.clip();
      context.fillStyle = "rgba(0,0,0,.24)"; context.fillRect(68, cursor + 14, boxWidth, boxHeight);
      context.drawImage(image, 68 + (boxWidth - drawWidth) / 2, cursor + 14 + (boxHeight - drawHeight) / 2, drawWidth, drawHeight);
      context.restore();
      cursor += 260;
    } else if (message.mediaLabel) {
      context.fillStyle = "rgba(255,255,255,.12)"; roundedRectangle(context, 68, cursor + 12, CARD_WIDTH - 64, 42, 12); context.fill();
      context.fillStyle = "rgba(255,255,255,.80)"; context.font = "21px sans-serif";
      context.fillText(message.mediaLabel.slice(0, 70), 84, cursor + 40, CARD_WIDTH - 96);
    }
    y += layout.height + 24;
  }

  const png = canvas.toBuffer("image/png");
  const sharp = (await import("sharp")).default;
  if (options.format === "webp") {
    for (const quality of [92, 84, 76, 68, 60, 52]) {
      const result = await sharp(png, {limitInputPixels: MAX_CANVAS_PIXELS}).resize({width: 512, height: 512, fit: "inside"}).webp({quality}).toBuffer();
      if (result.length <= 512 * 1024) return result;
    }
    throw new Error("引用贴纸无法压缩到 Telegram 的 512 KiB 上限");
  }
  if (options.format === "story") {
    const storyWidth = 1080, storyHeight = 1920;
    const fitted = await sharp(png, {limitInputPixels: MAX_CANVAS_PIXELS}).resize({width: 960, height: 1680, fit: "inside", withoutEnlargement: true}).png().toBuffer();
    const metadata = await sharp(fitted, {limitInputPixels: MAX_CANVAS_PIXELS}).metadata();
    const background = Buffer.from(`<svg width="${storyWidth}" height="${storyHeight}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#312e81"/><stop offset="1" stop-color="#be185d"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
    return sharp(background, {limitInputPixels: MAX_CANVAS_PIXELS}).composite([{input: fitted, left: Math.round((storyWidth - (metadata.width || 0)) / 2), top: Math.round((storyHeight - (metadata.height || 0)) / 2)}]).png().toBuffer();
  }
  return png;
}
