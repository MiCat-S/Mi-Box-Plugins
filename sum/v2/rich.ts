import type { Api as ApiTypes } from "teleproto";
import { htmlEscape } from "./model";

// 把模型写的 Markdown 摘要转成两种输出：Rich Message 的块（账号有 Telegram Premium 时发）和
// Telegram HTML（发不了时发）。和 Telegram 的 Rich Markdown 一样，正文里可以夹 Telegram HTML 的
// 行内标签（<b>、<a href> 等）和 <blockquote expandable>，所以按旧格式输出 HTML 的提示词照样能用。
//
// Rich Message 是 Telegram 2026 年加的富文本消息（Bot API 10.1，MTProto 里是 messages.sendMessage 的
// rich_message 字段）。用户号要有 Premium 才能发；让服务端解析 Markdown/HTML 的两种写法只给机器人用，
// 所以这里在本地拼好块（inputRichMessage），和 TDLib 一样正文留空。

/** Rich Message 的上限，见 https://core.telegram.org/bots/api#rich-message-limits */
export const RICH_TEXT_LIMIT = 32768;
export const RICH_BLOCK_LIMIT = 500;
const RICH_COLUMN_LIMIT = 20;

type Inline =
  | { kind: "text" | "code"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike" | "spoiler" | "span"; children: Inline[] }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "break" };

type Item = {
  ordered: boolean;
  number: number;
  indent: number;
  task: boolean;
  checked: boolean;
  lines: string[];
  children: Item[];
};

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "htmlQuote"; expandable: boolean; lines: string[] }
  | { kind: "list"; items: Item[] }
  | { kind: "rule" }
  | { kind: "table"; rows: string[][]; align: number[] };

const RULE = /^\s*(?:---|\*\*\*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^(\s{0,12})([-*+])\s+(.+)$/;
const ORDERED = /^(\s{0,12})(\d{1,9})[.)]\s+(.+)$/;
const INDENTED_CODE = /^ {4,}\S/;
const TASK = /^\[([ xX])\]\s+/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE_OPEN = /^\s*<blockquote(\s+expandable)?\s*>/i;
const QUOTE_CLOSE = /<\/blockquote\s*>/i;
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/;
const ATTR = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ENTITY = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/;
const LEADING = /^( {2,})(.*)$/;
const CITE = /<\s*\/?\s*cite\s*>|<\s*cite\s*\/\s*>|&lt;\s*\/?\s*cite\s*&gt;|&lt;\s*cite\s*\/\s*&gt;/gi;
const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const MAX_LIST_DEPTH = 3;
/** 同名标签最多嵌套几层，和 Rich Message 的嵌套上限一样；免得一长串没闭合的 <b> 让每个都扫到结尾。 */
const MAX_TAG_DEPTH = 16;
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};
/** 行内认得的 HTML 标签：Telegram HTML 和 Rich Message 的写法。<span> 只认 class="tg-spoiler"。 */
const INLINE_TAGS: Record<string, "bold" | "italic" | "underline" | "strike" | "spoiler" | "span" | "code" | "link"> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  "tg-spoiler": "spoiler",
  span: "spoiler",
  code: "code",
  a: "link",
  mark: "span",
  sub: "span",
  sup: "span",
  "tg-emoji": "span",
};

const blank = (line: string) => line.trim() === "";
const fence = (line: string) => line.trimStart().startsWith("```");
const quoteLine = (line: string) => line.trimStart().startsWith(">");
const isWord = (char: string | undefined) => !!char && /[A-Za-z0-9]/.test(char);

function marker(line: string): (Omit<Item, "task" | "checked" | "lines" | "children"> & { text: string }) | undefined {
  let match = BULLET.exec(line);
  if (match) return { indent: match[1]!.length, ordered: false, number: 0, text: match[3]! };
  match = ORDERED.exec(line);
  if (match) return { indent: match[1]!.length, ordered: true, number: Number(match[2]), text: match[3]! };
  return undefined;
}

/** 把 Markdown 切成块。 */
function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length && paragraph.join("\n").trim()) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (blank(line)) {
      flush();
      index++;
    } else if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      index++;
    } else if (fence(line)) {
      flush();
      const lang = line.trimStart().replace(/^`+/, "").trim().split(/\s+/)[0] ?? "";
      const code: string[] = [];
      for (index++; index < lines.length && !fence(lines[index]!); index++) code.push(lines[index]!);
      if (index < lines.length) index++;
      blocks.push({ kind: "code", lang, text: code.join("\n") });
    } else if (QUOTE_OPEN.test(line)) {
      flush();
      index = parseHTMLQuote(lines, index, blocks);
    } else if (!paragraph.length && INDENTED_CODE.test(line) && !marker(line)) {
      const code: string[] = [];
      for (; index < lines.length && (INDENTED_CODE.test(lines[index]!) || blank(lines[index]!)); index++)
        code.push(blank(lines[index]!) ? "" : lines[index]!.replace(/^ {4}/, ""));
      while (code.length && code.at(-1) === "") code.pop();
      blocks.push({ kind: "code", lang: "", text: code.join("\n") });
    } else if (quoteLine(line)) {
      flush();
      const quote: string[] = [];
      for (; index < lines.length && quoteLine(lines[index]!); index++) quote.push(lines[index]!);
      blocks.push({ kind: "quote", lines: quote });
    } else if (HEADING.test(line)) {
      flush();
      const match = HEADING.exec(line)!;
      blocks.push({ kind: "heading", level: match[1]!.length, text: match[2]!.trim() });
      index++;
    } else if (tableStart(lines, index)) {
      flush();
      index = parseTable(lines, index, blocks);
    } else if (marker(line)) {
      flush();
      index = parseList(lines, index, blocks);
    } else {
      paragraph.push(line);
      index++;
    }
  }
  flush();
  return blocks;
}

/** 读 <blockquote> 或 <blockquote expandable> 到 </blockquote> 为止；闭合标签后面还有字时留给下一个块。 */
function parseHTMLQuote(lines: string[], start: number, blocks: Block[]): number {
  const open = QUOTE_OPEN.exec(lines[start]!)!;
  const quote: string[] = [];
  let rest = lines[start]!.slice(open[0].length),
    index = start;
  for (;;) {
    const close = QUOTE_CLOSE.exec(rest);
    if (close) {
      quote.push(rest.slice(0, close.index));
      const after = rest.slice(close.index + close[0].length);
      if (after.trim()) lines[index] = after;
      else index++;
      break;
    }
    quote.push(rest);
    if (++index >= lines.length) break;
    rest = lines[index]!;
  }
  while (quote.length && blank(quote[0]!)) quote.shift();
  while (quote.length && blank(quote.at(-1)!)) quote.pop();
  blocks.push({ kind: "htmlQuote", expandable: !!open[1], lines: quote });
  return index;
}

/** 读从 start 开始的连续列表，遇到空行或别的块为止；按缩进建成最多三层的树，更深的并入当前项。 */
function parseList(lines: string[], start: number, blocks: Block[]): number {
  const root: Item = { ordered: false, number: 0, indent: -1, task: false, checked: false, lines: [], children: [] };
  const stack = [root];
  let current: Item | undefined,
    index = start;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (blank(line) || RULE.test(line) || quoteLine(line) || fence(line) || HEADING.test(line) || QUOTE_OPEN.test(line))
      break;
    const found = marker(line);
    if (!found) {
      current?.lines.push(line.trim());
      continue;
    }
    while (stack.length > 1 && stack.at(-1)!.indent >= found.indent) stack.pop();
    if (stack.length > MAX_LIST_DEPTH && current) {
      current.lines.push(found.text);
      continue;
    }
    const task = TASK.exec(found.text);
    const item: Item = {
      ordered: found.ordered,
      number: found.number,
      indent: found.indent,
      task: !!task,
      checked: !!task && task[1] !== " ",
      lines: [task ? found.text.slice(task[0].length) : found.text],
      children: [],
    };
    stack.at(-1)!.children.push(item);
    stack.push(item);
    current = item;
  }
  blocks.push({ kind: "list", items: root.children });
  return index;
}

/** lines[index] 是不是 GFM 表格的表头：带竖线，下一行是同样列数的分隔行。 */
function tableStart(lines: string[], index: number): boolean {
  const next = lines[index + 1];
  if (next === undefined || !lines[index]!.includes("|") || !next.includes("|") || !TABLE_DELIMITER.test(next))
    return false;
  return tableCells(lines[index]!).length === tableCells(next).length;
}

function parseTable(lines: string[], start: number, blocks: Block[]): number {
  const header = tableCells(lines[start]!);
  const align = tableCells(lines[start + 1]!).map(cell =>
    cell.startsWith(":") && cell.endsWith(":") ? 1 : cell.endsWith(":") ? 2 : 0,
  );
  const rows = [header];
  let index = start + 2;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (blank(line) || !line.includes("|") || quoteLine(line) || fence(line) || HEADING.test(line)) break;
    const cells = tableCells(line);
    rows.push(header.map((_, column) => cells[column] ?? ""));
  }
  blocks.push({ kind: "table", rows, align });
  return index;
}

/** 把一行表格切成格子：去掉两头的竖线，按没有转义、不在行内代码里的竖线切开。 */
function tableCells(line: string): string[] {
  let text = line.trim().replace(/^\|/, "");
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "",
    inCode = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** 只接受 http 和 https 链接。 */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host ? raw : "";
  } catch {
    return "";
  }
}

/** 自动识别的裸链接在这里结束：空白、尖括号、圆括号、中文标点和全角符号。 */
const urlStop = (char: string) => /[\s<>()　-〿＀-￯]/.test(char);

/** 解析一行里的行内格式。inLink 为真时不再识别链接，免得链接套链接。 */
function parseInline(text: string, inLink: boolean): Inline[] {
  const nodes: Inline[] = [];
  let plain = "";
  const emit = (node: Inline) => {
    if (plain) nodes.push({ kind: "text", text: plain });
    plain = "";
    nodes.push(node);
  };
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index),
      first = rest[0]!,
      previous = text[index - 1];
    if (first === "`") {
      const run = rest.length - rest.replace(/^`+/, "").length;
      const ticks = rest.slice(0, run);
      const end = rest.indexOf(ticks, run);
      if (end > run && rest[end + run] !== "`") {
        emit({ kind: "code", text: rest.slice(run, end) });
        index += end + run;
      } else {
        plain += ticks;
        index += run;
      }
      continue;
    }
    if (first === "\\" && rest.length > 1 && ESCAPABLE.includes(rest[1]!)) {
      plain += rest[1];
      index += 2;
      continue;
    }
    if (first === "<") {
      const tag = inlineTag(rest, inLink);
      if (tag) {
        emit(tag.node);
        index += tag.size;
        continue;
      }
    }
    if (first === "&") {
      const entity = decodeEntity(rest);
      if (entity) {
        plain += entity.text;
        index += entity.size;
        continue;
      }
    }
    if (!inLink && (first === "[" || rest.startsWith("!["))) {
      const skip = first === "!" ? 1 : 0;
      const link = linkAt(rest.slice(skip));
      if (link) {
        const children = parseInline(link.label, true);
        const url = safeUrl(link.target);
        if (url) emit({ kind: "link", url, children });
        else emit({ kind: "span", children });
        index += skip + link.size;
        continue;
      }
    }
    if (!inLink && !isWord(previous) && /^https?:\/\//i.test(rest)) {
      let end = [...rest].findIndex(urlStop);
      end = end < 0 ? rest.length : [...rest].slice(0, end).join("").length;
      const link = rest.slice(0, end).replace(/[.,!?;:'"]+$/, "");
      if (safeUrl(link)) {
        emit({ kind: "link", url: link, children: [{ kind: "text", text: link }] });
        index += link.length;
        continue;
      }
    }
    const emphasis = (
      [
        ["||", "spoiler", false],
        ["~~", "strike", false],
        ["**", "bold", false],
        ["__", "underline", true],
        ["*", "italic", false],
        ["_", "italic", true],
      ] as const
    ).find(([mark, , boundary]) => {
      if (!rest.startsWith(mark)) return false;
      if (boundary && isWord(previous)) return false;
      return mark.length === 2 || previous !== mark;
    });
    if (emphasis) {
      const [mark, kind, boundary] = emphasis;
      const found = delimited(rest, mark, boundary);
      if (found && (mark.length === 2 || !found.inner.includes(mark))) {
        emit({ kind, children: parseInline(found.inner, inLink) });
        index += found.size;
        continue;
      }
    }
    plain += first;
    index++;
  }
  if (plain) nodes.push({ kind: "text", text: plain });
  return nodes;
}

/**
 * 在 text 开头找一对 mark 包住的内容：内容不能为空、不能以空白开头或结尾，结束标记后不能紧跟同一个字符；
 * boundary 为真时结束标记后也不能紧跟字母数字，snake_case 里的下划线就不会被当成斜体。
 */
function delimited(text: string, mark: string, boundary: boolean): { inner: string; size: number } | undefined {
  const body = text.slice(mark.length);
  for (let offset = 0; offset < body.length;) {
    const end = body.indexOf(mark, offset);
    if (end < 0) return undefined;
    const after = body[end + mark.length];
    if (after === mark[0] || (boundary && isWord(after))) {
      offset = end + 1;
      continue;
    }
    const inner = body.slice(0, end);
    if (!inner || inner.trim() !== inner) return undefined;
    return { inner, size: mark.length * 2 + end };
  }
  return undefined;
}

/** 解析 text 开头的 [文字](链接)。 */
function linkAt(text: string): { label: string; target: string; size: number } | undefined {
  const close = text.indexOf("]");
  if (!text.startsWith("[") || close <= 1 || /[[\n]/.test(text.slice(1, close)) || text[close + 1] !== "(")
    return undefined;
  const end = text.indexOf(")", close + 2);
  const target = text.slice(close + 2, end);
  if (end <= close + 2 || /\s/.test(target)) return undefined;
  return { label: text.slice(1, close), target, size: end + 1 };
}

function decodeEntity(text: string): { text: string; size: number } | undefined {
  const match = ENTITY.exec(text);
  if (!match) return undefined;
  const code = match[1] ? Number(match[1]) : match[2] ? parseInt(match[2], 16) : undefined;
  if (code !== undefined) {
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    return { text: String.fromCodePoint(code), size: match[0].length };
  }
  const named = NAMED_ENTITIES[match[3]!];
  return named ? { text: named, size: match[0].length } : undefined;
}

const decodeEntities = (text: string) => {
  let out = "";
  for (let index = 0; index < text.length;) {
    const entity = text[index] === "&" ? decodeEntity(text.slice(index)) : undefined;
    out += entity ? entity.text : text[index];
    index += entity ? entity.size : 1;
  }
  return out;
};

/**
 * 解析 text 开头的一个行内 HTML 标签连同内容。标签里的 Markdown 照样解析（和 Telegram 的 Rich Markdown
 * 一样），<code> 里的不解析。认不得的标签、没有闭合的标签不算，原样当文字显示。
 */
function inlineTag(text: string, inLink: boolean): { node: Inline; size: number } | undefined {
  const match = TAG.exec(text);
  if (!match || match[1]) return undefined;
  const name = match[2]!.toLowerCase();
  if (name === "br") return { node: { kind: "break" }, size: match[0].length };
  const kind = INLINE_TAGS[name];
  const attrs: Record<string, string> = {};
  for (const attr of match[3]!.matchAll(ATTR)) attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
  if (!kind || match[4] || (name === "span" && attrs.class !== "tg-spoiler") || (name === "a" && inLink))
    return undefined;
  const content = tagContent(text, name, match[0].length);
  if (!content) return undefined;
  if (kind === "code") return { node: { kind: "code", text: decodeEntities(content.inner) }, size: content.size };
  if (kind === "link") {
    const children = parseInline(content.inner, true);
    const url = safeUrl(decodeEntities(attrs.href ?? ""));
    return { node: url ? { kind: "link", url, children } : { kind: "span", children }, size: content.size };
  }
  return { node: { kind, children: parseInline(content.inner, inLink) }, size: content.size };
}

/** 从 start 往后找 name 的闭合标签，同名标签嵌套时配对。 */
function tagContent(text: string, name: string, start: number): { inner: string; size: number } | undefined {
  let depth = 1;
  for (let offset = start; offset < text.length; offset++) {
    if (text[offset] !== "<") continue;
    // 先比对标签名，对上了再跑正则：没闭合的标签很多时，不至于每个 < 都跑一遍。
    const rest = text.slice(offset + 1).replace(/^\//, "");
    if (rest.slice(0, name.length).toLowerCase() !== name || !/[\s/>]/.test(rest[name.length] ?? "")) continue;
    const match = TAG.exec(text.slice(offset));
    if (!match || match[2]!.toLowerCase() !== name || match[4]) continue;
    if (!match[1]) {
      if (++depth > MAX_TAG_DEPTH) return undefined;
      continue;
    }
    if (--depth === 0) return { inner: text.slice(start, offset), size: offset + match[0].length };
  }
  return undefined;
}

/** 行首两个以上的空格换成不换行空格，Telegram 才不会把缩进吃掉。 */
function leadingIndent(line: string): [string, string] {
  const match = LEADING.exec(line);
  return match ? [" ".repeat(match[1]!.length), match[2]!] : ["", line];
}

/** 去掉引用每行开头的一层 >，剩下的可以再按 Markdown 分块。 */
const quoteInner = (lines: string[]) =>
  lines.map(line => line.trimStart().replace(/^>/, "").replace(/^ /, "")).join("\n");

// ---------- Telegram HTML ----------

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map(node => {
      switch (node.kind) {
        case "text":
          return htmlEscape(node.text);
        case "code":
          return `<code>${htmlEscape(node.text)}</code>`;
        case "break":
          return "\n";
        case "link":
          return `<a href="${htmlEscape(node.url)}">${inlineHtml(node.children)}</a>`;
        case "span":
          return inlineHtml(node.children);
      }
      const tag = { bold: "b", italic: "i", underline: "u", strike: "s", spoiler: "tg-spoiler" }[node.kind];
      return `<${tag}>${inlineHtml(node.children)}</${tag}>`;
    })
    .join("");
}

const lineHtml = (line: string) => {
  const [indent, rest] = leadingIndent(line);
  return indent + inlineHtml(parseInline(rest, false));
};

/** 把 body 包进引用；外层已经整体折叠（collapseSafe）或内容为空时原样返回。 */
function wrapQuote(body: string, expandable: boolean, collapseSafe: boolean): string {
  if (collapseSafe || !body.trim()) return body;
  return expandable ? `<blockquote expandable>${body}</blockquote>` : `<blockquote>${body}</blockquote>`;
}

function listHtml(items: Item[], depth: number, out: string[]): void {
  for (const item of items) {
    const indent = " ".repeat((depth - 1) * 2);
    const mark = (item.ordered ? `${item.number}. ` : "• ") + (item.task ? (item.checked ? "☑ " : "☐ ") : "");
    out.push(indent + mark + inlineHtml(parseInline(item.lines[0]!, false)));
    for (const line of item.lines.slice(1))
      out.push(" ".repeat((depth - 1) * 2 + 2) + inlineHtml(parseInline(line, false)));
    listHtml(item.children, depth + 1, out);
  }
}

/**
 * 普通消息版：栏目标题只加粗，要点列表照旧版式折进可展开的引用（旧提示词就是这么写的）；
 * collapseSafe 为真时外层会整体折叠，里面不再输出引用，免得嵌套。
 */
function markdownHtml(markdown: string, collapseSafe: boolean): string {
  const out: string[] = [];
  for (const block of parseMarkdown(markdown.replace(CITE, ""))) {
    let html = "";
    switch (block.kind) {
      case "rule":
        html = "────────────────";
        break;
      case "heading":
        html = `<b>${inlineHtml(parseInline(block.text, false))}</b>`;
        break;
      case "code":
        html = block.text.trim() ? `<pre>${htmlEscape(block.text)}</pre>` : "";
        break;
      case "quote":
        html = wrapQuote(
          block.lines.map(line => lineHtml(line.trimStart().replace(/^(?:>\s?)+/, ""))).join("\n"),
          false,
          collapseSafe,
        );
        break;
      case "htmlQuote":
        html = wrapQuote(block.lines.map(lineHtml).join("\n"), block.expandable, collapseSafe);
        break;
      case "list": {
        const lines: string[] = [];
        listHtml(block.items, 1, lines);
        html = wrapQuote(lines.join("\n"), true, collapseSafe);
        break;
      }
      case "table":
        html = block.rows
          .map((row, index) => {
            const line = row.map(cell => inlineHtml(parseInline(cell, false))).join(" | ");
            return index ? line : `<b>${line}</b>`;
          })
          .join("\n");
        break;
      case "paragraph":
        html = block.lines.map(lineHtml).join("\n").trimEnd();
        break;
    }
    if (html) out.push(html);
  }
  return out.join("\n\n");
}

/** 普通消息版的整份摘要；spoiler 时整段折进可展开的引用。 */
export function summaryHtml(heading: string, markdown: string, spoiler: boolean): string {
  let body = markdownHtml(markdown, spoiler);
  if (spoiler && body.trim()) body = `<blockquote expandable>${body}</blockquote>`;
  return `📊 <b>群组总结</b>\n${htmlEscape(heading)}\n\n${body}`;
}

// ---------- Rich Message ----------

/** teleproto 的 Api 由调用方在 withClient 里动态导入后传进来；zero 是 textUrl 的 webpage_id。 */
export type RichApi = { Api: typeof ApiTypes; zero: ApiTypes.TextUrl["webpageId"] };
type RichText = ApiTypes.TypeRichText;
type PageBlock = ApiTypes.TypePageBlock;

class RichBuilder {
  constructor(private readonly api: RichApi) {}

  plain(text: string): RichText {
    return text ? new this.api.Api.TextPlain({ text }) : new this.api.Api.TextEmpty();
  }

  /** 把几段富文本连起来：丢掉空的，相邻的纯文字合并，只剩一段时不再包一层。 */
  concat(parts: RichText[]): RichText {
    const texts: RichText[] = [];
    for (const part of parts) {
      if (part.className === "TextEmpty") continue;
      if (part.className === "TextConcat") {
        texts.push(...part.texts);
        continue;
      }
      const last = texts.at(-1);
      if (part.className === "TextPlain" && last?.className === "TextPlain") {
        texts[texts.length - 1] = this.plain(last.text + part.text);
        continue;
      }
      texts.push(part);
    }
    if (!texts.length) return new this.api.Api.TextEmpty();
    return texts.length === 1 ? texts[0]! : new this.api.Api.TextConcat({ texts });
  }

  inline(nodes: Inline[]): RichText {
    const { Api } = this.api;
    return this.concat(
      nodes.map(node => {
        switch (node.kind) {
          case "text":
            return this.plain(node.text);
          case "code":
            return new Api.TextFixed({ text: this.plain(node.text) });
          case "break":
            return this.plain("\n");
          case "span":
            return this.inline(node.children);
          case "link":
            return new Api.TextUrl({ text: this.inline(node.children), url: node.url, webpageId: this.api.zero });
          case "bold":
            return new Api.TextBold({ text: this.inline(node.children) });
          case "italic":
            return new Api.TextItalic({ text: this.inline(node.children) });
          case "underline":
            return new Api.TextUnderline({ text: this.inline(node.children) });
          case "strike":
            return new Api.TextStrike({ text: this.inline(node.children) });
          case "spoiler":
            return new Api.TextSpoiler({ text: this.inline(node.children) });
        }
      }),
    );
  }

  /** 几行文字排成一段，行间换行，行首缩进换成不换行空格。 */
  lines(lines: string[]): RichText {
    const parts: RichText[] = [];
    lines.forEach((line, index) => {
      if (index) parts.push(this.plain("\n"));
      const [indent, rest] = leadingIndent(line);
      parts.push(this.plain(indent), this.inline(parseInline(rest, false)));
    });
    return this.concat(parts);
  }

  heading(level: number, text: RichText): PageBlock {
    const { Api } = this.api;
    switch (level) {
      case 1:
        return new Api.PageBlockHeading1({ text });
      case 2:
        return new Api.PageBlockHeading2({ text });
      case 3:
        return new Api.PageBlockHeading3({ text });
      case 4:
        return new Api.PageBlockHeading4({ text });
      case 5:
        return new Api.PageBlockHeading5({ text });
    }
    return new Api.PageBlockHeading6({ text });
  }

  blocks(blocks: Block[]): PageBlock[] {
    const { Api } = this.api;
    const out: PageBlock[] = [];
    for (const block of blocks) {
      switch (block.kind) {
        case "rule":
          out.push(new Api.PageBlockDivider());
          break;
        case "heading":
          out.push(this.heading(block.level, this.inline(parseInline(block.text, false))));
          break;
        case "code":
          if (block.text.trim()) {
            const language = /^[a-z0-9_+-]+$/.test(block.lang.toLowerCase()) ? block.lang.toLowerCase() : "";
            out.push(new Api.PageBlockPreformatted({ text: this.plain(block.text), language }));
          }
          break;
        case "quote": {
          const inner = this.blocks(parseMarkdown(quoteInner(block.lines)));
          if (inner.length)
            out.push(new Api.PageBlockBlockquoteBlocks({ blocks: inner, caption: new Api.TextEmpty() }));
          break;
        }
        case "htmlQuote":
          if (block.lines.join("").trim())
            out.push(
              new Api.PageBlockBlockquote({
                collapsed: block.expandable,
                text: this.lines(block.lines),
                caption: new Api.TextEmpty(),
              }),
            );
          break;
        case "list":
          out.push(...this.list(block.items));
          break;
        case "table":
          out.push(this.table(block));
          break;
        case "paragraph":
          out.push(new Api.PageBlockParagraph({ text: this.lines(block.lines) }));
          break;
      }
    }
    return out;
  }

  /** 相邻的同类项合成一个无序或有序列表，每项是一段文字加上它的子列表。 */
  list(items: Item[]): PageBlock[] {
    const { Api } = this.api;
    const out: PageBlock[] = [];
    for (let start = 0; start < items.length;) {
      let end = start;
      while (end < items.length && items[end]!.ordered === items[start]!.ordered) end++;
      const group = items.slice(start, end);
      const content = (item: Item) => [
        new Api.PageBlockParagraph({ text: this.lines(item.lines) }) as PageBlock,
        ...this.list(item.children),
      ];
      if (group[0]!.ordered)
        out.push(
          new Api.PageBlockOrderedList({
            start: group[0]!.number || undefined,
            items: group.map(
              item =>
                new Api.PageListOrderedItemBlocks({
                  checkbox: item.task || undefined,
                  checked: item.checked || undefined,
                  value: item.number || undefined,
                  blocks: content(item),
                }),
            ),
          }),
        );
      else
        out.push(
          new Api.PageBlockList({
            items: group.map(
              item =>
                new Api.PageListItemBlocks({
                  checkbox: item.task || undefined,
                  checked: item.checked || undefined,
                  blocks: content(item),
                }),
            ),
          }),
        );
      start = end;
    }
    return out;
  }

  /** 带边框的表格，第一行是表头；列数超过 Telegram 的上限时退回成一行一段的文字。 */
  table(block: Extract<Block, { kind: "table" }>): PageBlock {
    const { Api } = this.api;
    if (block.rows[0]!.length > RICH_COLUMN_LIMIT)
      return new Api.PageBlockParagraph({ text: this.lines(block.rows.map(row => row.join(" | "))) });
    return new Api.PageBlockTable({
      bordered: true,
      title: new Api.TextEmpty(),
      rows: block.rows.map(
        (row, index) =>
          new Api.PageTableRow({
            cells: row.map(
              (cell, column) =>
                new Api.PageTableCell({
                  header: index === 0 || undefined,
                  alignCenter: block.align[column] === 1 || undefined,
                  alignRight: block.align[column] === 2 || undefined,
                  text: this.inline(parseInline(cell, false)),
                }),
            ),
          }),
      ),
    });
  }

  /**
   * 把最高一级的每个标题连同下面的内容（到下一个同级或更高的标题为止）换成收起的详情块。
   * 第一个标题之前的内容、下面没有内容的标题原样留着；没有标题时整段折进一个「展开全文」。
   */
  fold(blocks: PageBlock[]): PageBlock[] {
    const { Api } = this.api;
    const levelOf = (block: PageBlock) => Number(/^PageBlockHeading([1-6])$/.exec(block.className)?.[1] ?? 0);
    const levels = blocks.map(levelOf).filter(Boolean);
    if (!levels.length)
      return blocks.length ? [new Api.PageBlockDetails({ title: this.plain("展开全文"), blocks })] : blocks;
    const top = Math.min(...levels);
    const out: PageBlock[] = [];
    let heading: PageBlock | undefined,
      section: PageBlock[] = [];
    const close = () => {
      if (heading && section.length)
        out.push(new Api.PageBlockDetails({ title: (heading as ApiTypes.PageBlockHeading1).text, blocks: section }));
      else if (heading) out.push(heading);
      heading = undefined;
      section = [];
    };
    for (const block of blocks) {
      const level = levelOf(block);
      if (level && level <= top) {
        close();
        heading = block;
      } else if (heading) section.push(block);
      else out.push(block);
    }
    close();
    return out;
  }
}

/** Rich Message 版的整份摘要：栏目是真正的标题、要点是真正的列表；spoiler 时每个栏目折成收起的详情块。 */
export function summaryBlocks(api: RichApi, heading: string, markdown: string, spoiler: boolean): PageBlock[] {
  const build = new RichBuilder(api);
  const header = build.concat([
    build.plain("📊 "),
    new api.Api.TextBold({ text: build.plain("群组总结") }),
    build.plain(`\n${heading}`),
  ]);
  let body = build.blocks(parseMarkdown(markdown.replace(CITE, "")));
  if (spoiler) body = build.fold(body);
  return [new api.Api.PageBlockParagraph({ text: header }), ...body];
}

// ---------- 读取与上限 ----------

/** 取出富文本里的文字，公式取源码，图片和按钮之类没有文字的部分略过。 */
function richPlain(text: any): string {
  if (!text || typeof text !== "object") return "";
  switch (text.className) {
    case "TextEmpty":
      return "";
    case "TextPlain":
      return String(text.text ?? "");
    case "TextConcat":
      return (text.texts ?? []).map(richPlain).join("");
    case "TextMath":
      return String(text.source ?? "");
    case "TextCustomEmoji":
      return String(text.alt ?? "");
  }
  return richPlain(text.text);
}

/** 把块摊平成文字行：每块一行，列表项前加「• 」，表格每行的格子用「 | 」连起来。 */
function blockLines(blocks: any[], prefix: string, out: string[]): void {
  const add = (text: any) => {
    const line = richPlain(text);
    if (!line.trim()) return;
    out.push(prefix + line);
    prefix = " ".repeat([...prefix].length);
  };
  for (const block of blocks ?? []) {
    switch (block?.className) {
      case "PageBlockBlockquoteBlocks":
        blockLines(block.blocks, prefix, out);
        break;
      case "PageBlockDetails":
        add(block.title);
        blockLines(block.blocks, prefix, out);
        break;
      case "PageBlockList":
        for (const item of block.items ?? []) {
          if (item.className === "PageListItemText") out.push(`${prefix}• ${richPlain(item.text)}`);
          else blockLines(item.blocks, `${prefix}• `, out);
        }
        break;
      case "PageBlockOrderedList":
        (block.items ?? []).forEach((item: any, index: number) => {
          const label = item.num ? `${item.num} ` : `${item.value || index + 1}. `;
          if (item.className === "PageListOrderedItemText") out.push(prefix + label + richPlain(item.text));
          else blockLines(item.blocks, prefix + label, out);
        });
        break;
      case "PageBlockTable":
        add(block.title);
        for (const row of block.rows ?? [])
          out.push(prefix + (row.cells ?? []).map((cell: any) => richPlain(cell.text)).join(" | "));
        break;
      case "PageBlockMath":
        out.push(prefix + String(block.source ?? ""));
        break;
      default:
        if (block?.text) add(block.text);
    }
  }
}

/** 收到的 Rich Message 摊平成纯文本。这种消息的正文是空的，要读它的文字就得这样取。 */
export function richMessageText(message: any): string {
  const blocks = message?.richMessage?.blocks;
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];
  blockLines(blocks, "", lines);
  return lines.join("\n").trim();
}

function blockCount(blocks: any[]): number {
  let count = blocks.length;
  for (const block of blocks) {
    if (block.className === "PageBlockBlockquoteBlocks" || block.className === "PageBlockDetails")
      count += blockCount(block.blocks);
    else if (block.className === "PageBlockTable") count += block.rows.length;
    else if (block.className === "PageBlockList" || block.className === "PageBlockOrderedList")
      for (const item of block.items) count += 1 + (item.blocks ? blockCount(item.blocks) : 0);
  }
  return count;
}

/** 这些块在不在 Rich Message 的上限之内：文字不超过 32768 个字符，块（连同列表项、表格行）不超过 500 个。 */
export function richFits(blocks: PageBlock[]): boolean {
  const lines: string[] = [];
  blockLines(blocks, "", lines);
  return [...lines.join("")].length <= RICH_TEXT_LIMIT && blockCount(blocks) <= RICH_BLOCK_LIMIT;
}

/**
 * Rich Message 是不是被 Telegram 明确拒收了（比如没有 Premium、块不合法），这时消息没有发出，可以改发 HTML。
 * 限流不算，它照样会挡住普通消息；连接断开、服务端出错这类结果不明的也不算，消息可能已经发出去了。
 */
export function richRejected(error: unknown): boolean {
  const value = error as { code?: unknown; errorMessage?: unknown } | undefined;
  return (
    typeof value?.code === "number" &&
    value.code >= 400 &&
    value.code < 500 &&
    value.code !== 420 &&
    !/FLOOD/i.test(String(value.errorMessage ?? ""))
  );
}
