import { renderHelp as renderPluginHelp } from "./v2/help";
import { STRUCTURED_PLUGIN_API_VERSION, definePlugin, ui } from "telebox/sdk";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

const WORDS: Readonly<Record<string, string>> = {
  可以: "岢苡",
  什么: "什庅",
  怎么: "怎庅",
  为什么: "潙什庅",
  时候: "溡堠",
  知道: "倁檤",
  所以: "葰苡",
  因为: "洇潙",
  如果: "洳淉",
  虽然: "雖嘫",
  然后: "嘫後",
  现在: "哯茬",
  以前: "苡湔",
  以后: "苡後",
  今天: "妗兲",
  明天: "朙兲",
  昨天: "昨兲",
  喜欢: "囍歡",
  讨厌: "討厭",
  高兴: "滈興",
  难过: "難過",
  生气: "甡氣",
  害怕: "嗐袙",
  惊讶: "驚訝",
  感谢: "感謝",
  对不起: "對卟起",
  没关系: "莈関係",
  再见: "侢見",
};

const CHARACTERS: Readonly<Record<string, string>> = {
  你: "伱",
  您: "伱",
  好: "恏",
  的: "哋",
  地: "哋",
  得: "哋",
  是: "湜",
  不: "卟",
  了: "叻",
  我: "莪",
  他: "怹",
  她: "怹",
  它: "怹",
  们: "們",
  在: "茬",
  有: "冇",
  会: "浍",
  这: "淛",
  那: "哪",
  说: "説",
  话: "話",
  看: "瞧",
  听: "聽",
  要: "婹",
  来: "唻",
  去: "呿",
  做: "莋",
  给: "給",
  让: "讓",
  把: "紦",
  从: "苁",
  到: "菿",
  对: "對",
  和: "咊",
  与: "玙",
  或: "戓",
  但: "泹",
  而: "洏",
  上: "丄",
  下: "丅",
  里: "裡",
  外: "迯",
  前: "湔",
  后: "後",
  左: "咗",
  右: "祐",
  中: "狆",
  大: "夶",
  小: "尛",
  多: "哆",
  少: "尐",
  高: "滈",
  长: "萇",
  新: "噺",
  旧: "舊",
  快: "筷",
  慢: "嫚",
  早: "蚤",
  远: "逺",
  近: "菦",
  坏: "壞",
  美: "媄",
  丑: "醜",
  年: "姩",
  月: "仴",
  日: "ㄖ",
  天: "兲",
  人: "亾",
  男: "侽",
  女: "囡",
  老: "咾",
  生: "甡",
  死: "迉",
  爱: "愛",
};

const ENGLISH: Readonly<Record<string, string>> = {
  hello: "heLLo",
  hi: "heLLo",
  goodbye: "goodBye",
  bye: "goodBye",
  yes: "yeS",
  no: "nO",
  ok: "oK",
  okay: "oK",
  thank: "tHank",
  sorry: "soRRy",
  please: "pLease",
  welcome: "weLcome",
  love: "loVe",
  like: "liKe",
  hate: "haTe",
  happy: "haPPy",
  sad: "saD",
  angry: "anGRy",
  good: "gooD",
  bad: "baD",
  beautiful: "beauTiful",
  ugly: "ugLy",
  big: "biG",
  small: "smaLL",
  new: "neW",
  old: "olD",
  fast: "fasT",
  slow: "sloW",
  hot: "hoT",
  cold: "colD",
  long: "lonG",
  short: "shorT",
  high: "hiGh",
  low: "loW",
  easy: "easY",
  hard: "harD",
  right: "righT",
  wrong: "wronG",
  true: "truE",
  false: "falsE",
};

const COMMON_WORDS = [
  "什么",
  "怎么",
  "为什么",
  "可以",
  "不是",
  "没有",
  "知道",
  "时候",
  "喜欢",
  "讨厌",
  "高兴",
  "难过",
  "生气",
  "害怕",
  "惊讶",
  "感谢",
  "对不起",
  "没关系",
  "再见",
  "现在",
  "以前",
  "以后",
  "今天",
  "明天",
  "昨天",
  "虽然",
  "然后",
  "因为",
  "所以",
  "如果",
];

function segments(text: string): Array<{ value: string; kind: "n" | "eng" | "m" | "x" }> {
  const result: Array<{ value: string; kind: "n" | "eng" | "m" | "x" }> = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (/[，。！？；：、"“”（）【】《》\[\]{}]/.test(character)) {
      result.push({ value: character, kind: "x" });
      index++;
      continue;
    }
    if (/\d/.test(character)) {
      let value = character;
      index++;
      while (index < text.length && /\d/.test(text[index])) value += text[index++];
      result.push({ value, kind: "m" });
      continue;
    }
    if (/[a-z]/i.test(character)) {
      let value = character;
      index++;
      while (index < text.length && /[a-z]/i.test(text[index])) value += text[index++];
      result.push({ value, kind: "eng" });
      continue;
    }
    const word = COMMON_WORDS.find(value => text.startsWith(value, index));
    if (word) {
      result.push({ value: word, kind: "n" });
      index += word.length;
      continue;
    }
    const [value] = Array.from(text.slice(index));
    result.push({ value, kind: "n" });
    index += value.length;
  }
  return result;
}

function transformPart(value: string, kind: "n" | "eng" | "m" | "x"): string {
  if (Math.random() > 0.8) return value;
  const length = Array.from(value).length;
  if (value === "[" || value === "]") return "";
  if (value === "，") return "…";
  if (value === "!" || value === "！") return "‼‼‼";
  if (value === "。") return "❗";
  if (length > 1 && Math.random() < 0.1) return `${Array.from(value)[0]}…${value}`;
  if (length > 1 && Math.random() < 0.4) return `${Array.from(value)[0]}♥${value}`;
  if (kind === "n" && Math.random() < 0.1) return `…${"⭕".repeat(length)}`;
  if (value === "\\……n" || value === "\\♥n") return "\\n";
  if (value === "…………") return "……";
  if (kind === "n" && Math.random() < 0.2) return `……${"⭕".repeat(length)}`;
  if (WORDS[value]) return WORDS[value];
  if (kind === "eng" && ENGLISH[value.toLowerCase()]) return ENGLISH[value.toLowerCase()];
  const converted = Array.from(value, character => CHARACTERS[character] ?? character).join("");
  return `……${converted}`;
}

export function convert(text: string): string {
  return segments(text)
    .map(item => transformPart(item.value, item.kind))
    .join("");
}

export default function createYinglish() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "yinglish",
    description: "将文字转换为随机非主流风格",
    commands: {
      yinglish: {
        helpArgs: ["help", "h"],
        description: "转换参数或回复消息中的文字",
        async handle(invocation, context) {
          let input = invocation.args.join(" ").trim();
          if (!input && invocation.message.replyToId !== undefined) {
            context.signal.throwIfAborted();
            input = (await context.telegram.getReply(invocation.message))?.text.trim() ?? "";
            context.signal.throwIfAborted();
          }
          if (!input || ["help", "h"].includes(input.toLowerCase())) {
            await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          await context.telegram.edit(invocation.message, "🔄 正在转换...", { parseMode: "html" });
          context.signal.throwIfAborted();
          const pages = await ui.renderRichText(escape(convert(input)), ui.PAGE_LABEL_RESERVE);
          const delivery = await ui.deliverPages(
            pages.map((page, index, all) => page + ui.pageLabel(index, all.length)),
            context.signal,
            (page, index) =>
              index
                ? context.telegram.reply(invocation.message, page, { parseMode: "html" })
                : context.telegram.edit(invocation.message, page, { parseMode: "html" }),
          );
          if (delivery.interrupted) {
            context.log.error("yinglish_page_delivery_failed", {
              category: ui.deliveryErrorCategory(delivery.error),
              published: delivery.published,
              total: delivery.total,
            });
            if (delivery.published)
              await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery)).catch(() => {});
            else await context.telegram.edit(invocation.message, "转换结果发送失败，请稍后重试");
          }
        },
      },
    },
  });
}
