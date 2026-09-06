import {htmlEscape} from "./model";

/** Reopen formatting at page boundaries; malformed provider markup remains visible text. */
export function htmlPages(text: string, limit = 3800): string[] {
  const pages: string[] = [];
  const stack: {name: string; open: string}[] = [];
  let page = "", visible = false;
  const closing = () => [...stack].reverse().map(tag => `</${tag.name}>`).join("");
  const flush = () => {
    if (visible) pages.push(page + closing());
    page = stack.map(tag => tag.open).join(""); visible = false;
  };
  const append = (token: string, content = true) => {
    if (page.length + token.length + closing().length > limit) flush();
    page += token; visible ||= content;
  };
  for (const token of text.match(/<[^>]*>|&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);|[^<&]+|[<&]/giu) ?? []) {
    const end = token.match(/^<\/(b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler)>$/i);
    if (end && stack.at(-1)?.name === end[1].toLowerCase()) {
      page += `</${stack.pop()!.name}>`; continue;
    }
    const start = token.match(/^<(b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler)(\s[^>]*)?>$/i);
    if (start && stack.length < 16 && token.length < 1000) {
      const name = start[1].toLowerCase(), attrs = start[2] ?? "";
      const valid = name === "a" ? /^\s+href=["'](?:https?:\/\/|tg:\/\/)[^<>"']+["']\s*$/i.test(attrs)
        : name === "blockquote" ? /^(?:\s+expandable)?\s*$/.test(attrs) : !attrs;
      if (valid && stack.map(tag => tag.open.length + tag.name.length + 3).reduce((a, b) => a + b, 0) + token.length < limit / 2) {
        if (page.length + token.length + closing().length + name.length + 3 > limit) flush();
        page += token; stack.push({name, open: token}); continue;
      }
    }
    if (/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);$/i.test(token)) append(token);
    else for (const char of token) append(htmlEscape(char));
  }
  flush();
  return pages.length ? pages : [""];
}
