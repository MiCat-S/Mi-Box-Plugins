export interface ArchiveInput {
  target: string;
  from: number;
  to: number;
  label: string;
  batch: number;
  limit?: number;
}

const MAX_LIMIT = 100_000;

function date(value: string, end: boolean): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return;
  const result = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0,
  );
  if (
    result.getFullYear() !== Number(match[1]) ||
    result.getMonth() !== Number(match[2]) - 1 ||
    result.getDate() !== Number(match[3])
  )
    return;
  return Math.floor(result.getTime() / 1000);
}

export function parseArchiveInput(args: readonly string[]): ArchiveInput | undefined {
  let target = "here";
  let fromText: string | undefined;
  let toText: string | undefined;
  let batch = 100;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const inline = /^(--(?:from|to|limit|batch))=(.*)$/.exec(token);
    const flag = inline?.[1] ?? token;
    const value = inline?.[2] ?? args[index + 1];
    if (["--from", "-f", "--to", "-t", "--limit", "-l", "--batch", "-b"].includes(flag)) {
      if (!inline) index += 1;
      if (!value) return;
      if (flag === "--from" || flag === "-f") fromText = value;
      else if (flag === "--to" || flag === "-t") toText = value;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        if (flag === "--batch" || flag === "-b") batch = Math.max(1, Math.min(100, Math.trunc(parsed)));
        else if (parsed > 0) limit = Math.min(MAX_LIMIT, Math.trunc(parsed));
      }
    } else if (/^-\d+$/.test(token) && target === "here") target = token;
    else if (token.startsWith("-") || target !== "here") return;
    else target = token;
  }
  if (!fromText || !toText) return;
  const from = date(fromText, false);
  const to = date(toText, true);
  if (from === undefined || to === undefined || from > to) return;
  return { target, from, to, label: `${fromText} 00:00:00 -> ${toText} 23:59:59`, batch, ...(limit ? { limit } : {}) };
}
