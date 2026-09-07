import {definePlugin} from "telebox/sdk";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

const WORDS: Readonly<Record<string, string>> = {
  "可以": "岢苡", "什么": "什庅", "怎么": "怎庅", "为什么": "潙什庅", "时候": "溡堠",
  "知道": "倁檤", "所以": "葰苡", "因为": "洇潙", "如果": "洳淉", "虽然": "雖嘫",
  "然后": "嘫後", "现在": "哯茬", "以前": "苡湔", "以后": "苡後", "今天": "妗兲",
  "明天": "朙兲", "昨天": "昨兲", "喜欢": "囍歡", "讨厌": "討厭", "高兴": "滈興",
  "难过": "難過", "生气": "甡氣", "害怕": "嗐袙", "惊讶": "驚訝", "感谢": "感謝",
  "对不起": "對卟起", "没关系": "莈関係", "再见": "侢見",
};

const CHARACTERS: Readonly<Record<string, string>> = {
  "你": "伱", "您": "伱", "好": "恏", "的": "哋", "地": "哋", "得": "哋", "是": "湜",
  "不": "卟", "了": "叻", "我": "莪", "他": "怹", "她": "怹", "它": "怹", "们": "們",
  "在": "茬", "有": "冇", "会": "浍", "这": "淛", "那": "哪", "说": "説", "话": "話",
  "看": "瞧", "听": "聽", "要": "婹", "来": "唻", "去": "呿", "做": "莋", "给": "給",
  "让": "讓", "把": "紦", "从": "苁", "到": "菿", "对": "對", "和": "咊", "与": "玙",
  "或": "戓", "但": "泹", "而": "洏", "上": "丄", "下": "丅", "里": "裡", "外": "迯",
  "前": "湔", "后": "後", "左": "咗", "右": "祐", "中": "狆", "大": "夶", "小": "尛",
  "多": "哆", "少": "尐", "高": "滈", "长": "萇", "新": "噺", "旧": "舊", "快": "筷",
  "慢": "嫚", "早": "蚤", "远": "逺", "近": "菦", "坏": "壞", "美": "媄", "丑": "醜",
  "年": "姩", "月": "仴", "日": "ㄖ", "天": "兲", "人": "亾", "男": "侽", "女": "囡",
  "老": "咾", "生": "甡", "死": "迉", "爱": "愛",
};

const ENGLISH: Readonly<Record<string, string>> = {
  hello: "heLLo", hi: "heLLo", goodbye: "goodBye", bye: "goodBye", yes: "yeS", no: "nO",
  ok: "oK", okay: "oK", thank: "tHank", sorry: "soRRy", please: "pLease", welcome: "weLcome",
  love: "loVe", like: "liKe", hate: "haTe", happy: "haPPy", sad: "saD", angry: "anGRy",
  good: "gooD", bad: "baD", beautiful: "beauTiful", ugly: "ugLy", big: "biG", small: "smaLL",
};

const WORD_ORDER = Object.keys(WORDS).sort((left, right) => right.length - left.length);

function segments(text: string): Array<{value: string; kind: "word" | "english" | "other"}> {
  const result: Array<{value: string; kind: "word" | "english" | "other"}> = [];
  for (let index = 0; index < text.length;) {
    const english = text.slice(index).match(/^[a-z]+/i);
    if (english) { result.push({value: english[0], kind: "english"}); index += english[0].length; continue; }
    const word = WORD_ORDER.find(value => text.startsWith(value, index));
    if (word) { result.push({value: word, kind: "word"}); index += word.length; continue; }
    const [value] = Array.from(text.slice(index));
    result.push({value, kind: /[\p{L}\p{N}]/u.test(value) ? "word" : "other"});
    index += value.length;
  }
  return result;
}

function transformPart(value: string, kind: "word" | "english" | "other"): string {
  if (kind === "other") {
    if (value === "，") return "…";
    if (value === "。") return "❗";
    if (value === "!" || value === "！") return "‼‼‼";
    if (value === "[" || value === "]") return "";
    return value;
  }
  if (Math.random() > 0.8) return value;
  if (kind === "english") return ENGLISH[value.toLowerCase()] ?? value.split("").map((char, index) => index % 2 ? char.toUpperCase() : char.toLowerCase()).join("");
  const converted = WORDS[value] ?? Array.from(value, character => CHARACTERS[character] ?? character).join("");
  if (value.length > 1 && Math.random() < 0.1) return `${value[0]}…${converted}`;
  if (value.length > 1 && Math.random() < 0.4) return `${value[0]}♥${converted}`;
  if (Math.random() < 0.2) return `……${"⭕".repeat(Array.from(value).length)}`;
  return `……${converted}`;
}

function convert(text: string): string {
  return segments(text).map(item => transformPart(item.value, item.kind)).join("");
}

export default function createYinglish() {
  return definePlugin({apiVersion: 1, id: "yinglish", description: "将文字转换为随机非主流风格",
    commands: {yinglish: {description: "转换参数或回复消息中的文字", async handle(invocation, context) {
      let input = invocation.args.join(" ").trim();
      if (!input && invocation.message.replyToId !== undefined) input = (await context.telegram.getReply(invocation.message))?.text.trim() ?? "";
      if (!input || ["help", "h"].includes(input.toLowerCase())) {
        await context.telegram.edit(invocation.message,
          `<b>文字风格转换</b>\n<code>${escape(invocation.prefix)}yinglish 文本</code>\n也可以回复文字消息后使用。`, {parseMode: "html"});
        return;
      }
      if (input.length > 4000) {
        await context.telegram.edit(invocation.message, "文本过长，最多 4000 个字符");
        return;
      }
      await context.telegram.edit(invocation.message, escape(convert(input)), {parseMode: "html"});
    }}},
  });
}
