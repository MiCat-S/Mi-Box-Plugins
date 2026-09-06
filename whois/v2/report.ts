const esc = (text: string) => text.replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]!);

export function report(domain: string, raw: string, now = Date.now()): string[] {
  const field = (name: string) => raw.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"))?.[1].trim();
  const expiry = field("Registry Expiry Date") ?? field("Registrar Registration Expiration Date");
  const lines = [`WHOIS 结果\n${domain}`];
  const fields = [
    ["注册商", field("Registrar")], ["注册日期", field("Creation Date")],
    ["更新日期", field("Updated Date")], ["到期日期", expiry],
    ["域名状态", field("Domain Status")],
  ];
  for (const [label, value] of fields) if (value) lines.push(`${label}: ${value}`);
  if (expiry) {
    const remaining = Date.parse(expiry) - now;
    if (Number.isFinite(remaining)) {
      const days = Math.floor(remaining / 86400000);
      if (remaining < 0) lines.push("到期提醒: 已过期");
      else if (days < 90) lines.push(`到期提醒: ${days} 天后过期`);
    }
  }
  const servers = [...raw.matchAll(/^(?:Name Server|nserver|NS):[ \t]*(.+)$/gim)].map(match => match[1].trim());
  if (servers.length) lines.push(`DNS 服务器:\n${[...new Set(servers)].join("\n")}`);
  const pages: string[] = [];
  // Split before escaping so every page has complete entities and Unicode characters.
  for (const [text, tag] of [[lines.join("\n"), "pre"], [raw, "blockquote expandable"]]) {
    const closing = tag.split(" ")[0];
    let page = "";
    for (const char of text) {
      const value = esc(char);
      if (page.length + value.length > 3400) {
        pages.push(`<${tag}>${page}</${closing}>`);
        page = "";
      }
      page += value;
    }
    if (page) pages.push(`<${tag}>${page}</${closing}>`);
  }
  return pages;
}
