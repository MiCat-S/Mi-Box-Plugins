/** Pure argument parsing and error text helpers, ported from the legacy plugin. */

export function getTextAfterTokens(text: string, count: number): string {
  if (count <= 0) return text.trim();
  return text
    .replace(new RegExp(`^\\S+${Array(count - 1).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

export function isPotentialUserIdentifier(text: string): boolean {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) || /^@[A-Za-z0-9_]{3,}$/.test(trimmed);
}

/** Exact decimal normalization: never round-trips through `Number`. */
export function normalizeIdentifier(part: string): string {
  return /^-?\d+$/.test(part) ? BigInt(part).toString() : part.replace(/^@/, "").toLowerCase();
}

/**
 * Parses a full comma-separated identifier list first, exactly like the legacy
 * plugin, so `lock @alice, @bobby` is two identifiers rather than a username plus
 * a chat target. Returns null when any part is not a plausible identifier.
 */
export function parseUserIdentifiers(raw: string): string[] | null {
  const parts = raw
    .split(/[，,]/g)
    .map(part => part.trim())
    .filter(part => part.length > 0);

  if (parts.length === 0) return null;
  if (parts.some(part => !isPotentialUserIdentifier(part))) return null;

  const deduped = new Map<string, string>();
  for (const part of parts) {
    const key = normalizeIdentifier(part);
    if (!deduped.has(key)) deduped.set(key, part);
  }
  return Array.from(deduped.values());
}

export function parseSeatActionArgs(remainder: string): {identifiers: string[]; targetArg?: string} {
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  const identifiers = parseUserIdentifiers(remainder);
  if (identifiers) return {identifiers};

  if (tokens.length > 1) {
    const targetArg = tokens[tokens.length - 1];
    const targetlessIdentifiers = parseUserIdentifiers(tokens.slice(0, -1).join(" "));
    if (targetlessIdentifiers) return {identifiers: targetlessIdentifiers, targetArg};
  }

  return {identifiers: []};
}

export function parseTailArgs(remainder: string): {limit: number; targetArg?: string} {
  const trimmed = remainder.trim();
  if (!trimmed) return {limit: 10};

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] || "";
  if (/^[1-9]\d*$/.test(firstToken)) {
    const targetArg = tokens.slice(1).join(" ").trim();
    return {limit: Number(firstToken), targetArg: targetArg || undefined};
  }
  return {limit: 10, targetArg: trimmed};
}

export function parseTrimArgs(remainder: string): {limit?: number; targetArg?: string} {
  const trimmed = remainder.trim();
  if (!trimmed) return {};
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] || "";
  if (!/^[1-9]\d*$/.test(firstToken)) return {};
  const targetArg = tokens.slice(1).join(" ").trim();
  return {limit: Number(firstToken), targetArg: targetArg || undefined};
}

/** Maps known Telegram failures to user text; unknown internals stay generic. */
export function errorText(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("CHAT_ADMIN_REQUIRED")) return "需要管理员权限才能执行该操作";
  if (detail.includes("CHANNEL_PRIVATE")) return "无法访问该私有频道/群组";
  if (detail.includes("USERNAME_NOT_OCCUPIED")) return "指定的用户名不存在";
  if (detail.includes("PEER_ID_INVALID")) return "目标对话或用户无效，或当前账号无法访问";
  if (detail.includes("USER_ID_INVALID")) return "目标用户无效，或不在该对话中";
  if (detail.includes("USER_NOT_PARTICIPANT")) return "目标用户不在该对话中";
  if (detail.includes("ADMINS_TOO_MUCH")) return "管理员数量已达到 Telegram 限制";
  if (detail.includes("RIGHT_FORBIDDEN")) return "当前账号没有足够权限执行该操作";
  if (detail.includes("USER_CREATOR")) return "群主无法被下掉管理员";
  if (detail.includes("BOT_GROUPS_BLOCKED")) return "该目标无法被当前方式调整管理员权限";
  return "操作失败，请检查目标与权限";
}
