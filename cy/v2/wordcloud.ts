import fs from "node:fs";

// Canvas is supplied by the Core runtime.
// @ts-expect-error the extension checkout does not resolve Core canvas typings
type CanvasModule = typeof import("canvas");
let canvasModule: CanvasModule | undefined;

function getCanvasModule(): CanvasModule {
  if (!canvasModule) canvasModule = require("canvas") as CanvasModule;
  return canvasModule;
}

const WIDTH = 900;
const HEIGHT = 640;
const MARGIN = 32;
const CJK_FONT_FAMILY = "TeleBoxCJK";
const CJK_FONT_STACK = `"${CJK_FONT_FAMILY}", "Droid Sans Fallback", sans-serif`;
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
];
let cjkFontRegistered = false;

function ensureCjkFont(): void {
  if (cjkFontRegistered) return;
  for (const fontPath of CJK_FONT_CANDIDATES) {
    if (!fs.existsSync(fontPath)) continue;
    try {
      getCanvasModule().registerFont(fontPath, { family: CJK_FONT_FAMILY });
      cjkFontRegistered = true;
      break;
    } catch (error) {
      console.warn(`[cy] 注册中文字体失败: ${fontPath}`, error);
    }
  }
}

const STOP_WORDS = new Set([
  "这个", "那个", "就是", "不是", "可以", "没有", "一下", "一个", "什么", "怎么", "为什么",
  "然后", "现在", "还是", "但是", "因为", "所以", "如果", "已经", "应该", "可能", "感觉",
  "不要", "知道", "看看", "哈哈", "哈哈哈", "你们", "我们", "他们", "自己", "直接", "确实",
  "来源", "情况", "情况下", "耗时", "输入", "输出", "回复", "问题", "最近", "消息", "有效",
  "今天", "昨天", "明天", "时候", "东西", "里面", "这里", "那里", "这样", "那样", "进行",
  "使用", "需要", "更新", "主要", "内容", "新增", "版本", "发布", "包括", "所有", "不会",
  "the", "and", "for", "with", "this", "that", "you", "are", "not", "but", "from", "have",
  "http", "https", "com", "www", "telegram", "t.me", "true", "false", "null", "undefined",
]);

const PALETTE = ["#0f766e", "#166534", "#1d4ed8", "#0891b2", "#2563eb", "#ca8a04", "#dc2626", "#7c3aed"];

type WordItem = {
  word: string;
  count: number;
  size: number;
  color: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type CanvasContext = ReturnType<ReturnType<CanvasModule["createCanvas"]>["getContext"]>;

function isUsefulWord(word: string): boolean {
  if (!word) return false;
  const normalized = word.toLowerCase();
  if (STOP_WORDS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/^[a-z]{1,2}$/i.test(normalized)) return false;
  if (/^[o0]+$/i.test(normalized)) return false;
  if (/^[._+\-]+$/.test(normalized)) return false;
  return true;
}

function addWord(counts: Map<string, number>, word: string, weight = 1): void {
  const normalized = word.trim().toLowerCase();
  if (!isUsefulWord(normalized)) return;
  counts.set(normalized, (counts.get(normalized) || 0) + weight);
}

function pruneOverlappingWords(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.filter(([word, count]) => {
    if (word.length <= 1) return false;
    return !entries.some(([other, otherCount]) => {
      if (other === word) return false;
      if (other.length <= word.length) return false;
      if (!other.includes(word)) return false;
      // 如果短词只是更长词里的碎片，并且频次没有明显更强，就丢掉。
      return otherCount >= count * 0.9;
    });
  });
}

export function collectWords(text: string, counts: Map<string, number>): void {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[@#][\w_一-龥-]+/g, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9_+\-.]+/gu, " ");

  for (const match of cleaned.matchAll(/[a-zA-Z][a-zA-Z0-9_+\-.]{1,24}/g)) {
    addWord(counts, match[0], 2);
  }
  for (const match of cleaned.matchAll(/\d{2,}[a-zA-Z%]?/g)) {
    addWord(counts, match[0], 1);
  }

  const hanParts = cleaned.match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const part of hanParts) {
    if (part.length <= 4) {
      addWord(counts, part, 3);
      continue;
    }
    for (let size = 2; size <= 5; size++) {
      for (let i = 0; i <= part.length - size; i++) {
        const word = part.slice(i, i + size);
        const edgeBonus = i === 0 || i === part.length - size ? 1 : 0;
        addWord(counts, word, size <= 3 ? 1 + edgeBonus : 2 + edgeBonus);
      }
    }
  }
}

export function buildWordItems(counts: Map<string, number>): WordItem[] {
  const entries = pruneOverlappingWords([...counts.entries()])
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 220);
  if (!entries.length) return [];
  const max = entries[0][1];
  const min = entries[entries.length - 1][1];
  const spread = Math.max(1, max - min);
  return entries.map(([word, count], index) => {
    const ratio = (count - min) / spread;
    const size = Math.round(12 + Math.pow(ratio, 0.7) * 68);
    return {
      word,
      count,
      size,
      color: PALETTE[index % PALETTE.length],
    };
  });
}

function overlaps(a: WordItem, placed: WordItem[]): boolean {
  const padding = 4;
  const ax1 = (a.x || 0) - padding;
  const ay1 = (a.y || 0) - (a.height || 0) - padding;
  const ax2 = (a.x || 0) + (a.width || 0) + padding;
  const ay2 = (a.y || 0) + padding;
  return placed.some((b) => {
    const bx1 = (b.x || 0) - padding;
    const by1 = (b.y || 0) - (b.height || 0) - padding;
    const bx2 = (b.x || 0) + (b.width || 0) + padding;
    const by2 = (b.y || 0) + padding;
    return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
  });
}

function layoutWords(ctx: CanvasContext, words: WordItem[]): WordItem[] {
  const placed: WordItem[] = [];
  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2 - 28;
  for (const original of words) {
    const item = { ...original };
    ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
    const metrics = ctx.measureText(item.word);
    item.width = Number(metrics.width);
    item.height = item.size;
    if (item.width > WIDTH - MARGIN * 2) continue;

    for (let attempt = 0; attempt < 4; attempt++) {
      item.size = Math.max(10, original.size - attempt * 4);
      ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
      const nextMetrics = ctx.measureText(item.word);
      item.width = Number(nextMetrics.width);
      item.height = item.size;
      let placedItem = false;
      for (let t = 0; t < 3600; t++) {
      const angle = t * 0.38;
      const radius = 5.2 * Math.sqrt(t);
      item.x = centerX + Math.cos(angle) * radius - item.width / 2;
      item.y = centerY + Math.sin(angle) * radius + item.height / 2;
      if (item.x < MARGIN || item.y < MARGIN + item.height || item.x + item.width > WIDTH - MARGIN || item.y > HEIGHT - 78) continue;
      if (overlaps(item, placed)) continue;
      placed.push({ ...item });
      placedItem = true;
      break;
      }
      if (placedItem) break;
    }
  }
  return placed;
}

export function renderWordCloud(words: WordItem[], limit: number, validMessages: number): Buffer {
  ensureCjkFont();
  const canvas = getCanvasModule().createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const placed = layoutWords(ctx, words);
  for (const item of placed) {
    ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
    ctx.fillStyle = item.color;
    ctx.fillText(item.word, item.x || 0, item.y || 0);
  }

  ctx.fillStyle = "#111827";
  ctx.font = `34px ${CJK_FONT_STACK}`;
  ctx.fillText(`最近 ${limit} 条热词云 | ${validMessages} 条有效消息`, 42, HEIGHT - 34);
  return canvas.toBuffer("image/png");
}

