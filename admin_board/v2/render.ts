/** Pure rendering helpers for admin_board, ported from the legacy plugin. */

export type Stat = {
  user: any;
  id: string;
  name: string;
  username: string | null;
  rank: string;
  avg: number;
  avgText: string;
  last: number;
  lastText: string;
  locked: boolean;
  creator: boolean;
};

export type Counts = {totalCount: number; botCount: number; nonBotCount: number};
export type TargetDisplay = {title: string; username: string | null};

const DAY_MS = 24 * 60 * 60 * 1000;

export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[char]!);

export function formatAvgPerDay(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

export function formatDaysAgo(date: Date): string {
  return `${Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY_MS))} 天前`;
}

function pickStableText(seed: string, options: string[]): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) hash = (hash * 33 + seed.charCodeAt(index)) >>> 0;
  return options[hash % options.length];
}

function buildSortComment(stat: Stat, index: number, total: number): string {
  const avg = stat.avg;
  const isFirst = index === 0;
  const isTopThree = index < 3;
  const isBottom = index === total - 1;
  const isTopHalf = index < Math.ceil(total / 2);
  const hasLockedSeat = stat.locked;
  const hasNoMessages = avg <= 0;
  const recentDays = stat.last > 0 ? Math.floor((Date.now() - stat.last) / DAY_MS) : Number.POSITIVE_INFINITY;
  const seed = `${stat.id}:${index}:${total}:${Math.round(avg * 100)}`;

  if (total === 1) return "一人撑起全场";
  if (isFirst && avg >= 20) return pickStableText(seed, ["水王本王", "群聊永动机", "打字机成精"]);
  if (isFirst) return pickStableText(seed, ["水王", "榜一大哥", "稳坐龙椅"]);
  if (isTopThree && hasLockedSeat) return pickStableText(seed, ["前排带编", "稳坐泰山", "头部玩家"]);
  if (!isTopHalf && hasLockedSeat && hasNoMessages) return pickStableText(seed, ["PY 交易", "占坑选手", "席位焊死"]);
  if (!isTopHalf && hasLockedSeat) return pickStableText(seed, ["PY 交易", "关系户发力", "编制护体"]);
  if (hasLockedSeat && avg >= 8) return pickStableText(seed, ["带编劳模", "既有席位也有输出", "稳中带卷"]);
  if (hasLockedSeat) return pickStableText(seed, ["席位保送", "内定嘉宾", "VIP 通道"]);
  if (avg >= 12) return pickStableText(seed, ["高强度输出", "劳模发言机", "持续火力覆盖"]);
  if (avg >= 6) return pickStableText(seed, ["稳定营业", "手感正热", "状态在线"]);
  if (avg >= 2 && recentDays <= 1) return pickStableText(seed, ["今天也没闲着", "在线上分", "还在持续发电"]);
  if (avg >= 1) return pickStableText(seed, ["偶尔冒泡", "佛系开麦", "低频输出"]);
  if (hasNoMessages && recentDays <= 3) return pickStableText(seed, ["只上线不说话", "在线潜水", "围观群众"]);
  if (hasNoMessages && isBottom) return pickStableText(seed, ["垫底保级", "佛系挂机", "查无发言"]);
  if (isBottom) return pickStableText(seed, ["后排看戏", "边缘试探", "末位观察员"]);
  return pickStableText(seed, ["安静围观", "主打陪伴", "默默潜伏", "随机掉落", "随缘发言"]);
}

function buildTailComment(stat: Stat, index: number, total: number): string {
  const avg = stat.avg;
  const reverseRank = total - index;
  const isBottom = reverseRank === 1;
  const isBottomThree = reverseRank <= 3;
  const isBottomFive = reverseRank <= 5;
  const hasNoMessages = avg <= 0;
  const recentDays = stat.last > 0 ? Math.floor((Date.now() - stat.last) / DAY_MS) : Number.POSITIVE_INFINITY;
  const seed = `tail:${stat.id}:${index}:${total}:${Math.round(avg * 100)}`;

  if (total === 1) return "全场就你一个，尾榜也只能你来站岗";
  if (isBottom && hasNoMessages) return pickStableText(seed, ["尾王登基，发言记录比头发还稀", "喜提垫底，群聊存在感约等于空气", "本群静音代言人，查无发言"]);
  if (isBottom) return pickStableText(seed, ["稳居榜尾，主打一个陪伴不发言", "尾榜状元，今天也把字省下来了", "发言效率感人，成功拿下最后一名"]);
  if (isBottomThree && hasNoMessages && recentDays > 7) return pickStableText(seed, ["长期失踪人口，像是顺手加进来的管理员", "潜水深度过高，群消息已经追不上你", "上次开口像在上个版本"]);
  if (isBottomThree && avg < 1) return pickStableText(seed, ["尾部常驻嘉宾，发言全靠缘分刷新", "输入法像是包月到期了", "平时不说话，一说话可能是手滑"]);
  if (isBottomFive && recentDays > 3) return pickStableText(seed, ["最近略显安静，像是把群折叠了", "看得出来人在群里，魂不一定在", "出勤勉强合格，输出接近请假"]);
  if (avg < 1) return pickStableText(seed, ["低频营业，惜字如金到像在收费", "主打沉默管理，发言像限量发售", "在线旁听专家，开口次数相当克制"]);
  if (avg < 2 && recentDays <= 1) return pickStableText(seed, ["今天象征性冒了个泡，任务算完成", "刚打完卡就准备继续潜水", "有在努力，但不多"]);
  if (avg < 3) return pickStableText(seed, ["在卷王堆里显得格外佛系", "不是完全不说，只是存在感很节能", "稳定尾部，压力全给前排扛了"]);
  return pickStableText(seed, ["虽然在尾部，但至少还算偶尔出声", "尾榜里算是比较有求生欲的", "再努努力，至少能先脱离倒数区"]);
}

function getRankDisplay(index: number): string {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `${index + 1}.`;
}

export function buildCompactSortLine(
  stat: Stat,
  index: number,
  total: number,
  options?: {commentText?: string; commentPrefix?: string; rankLabel?: string},
): string {
  const identityParts: string[] = [];
  if (stat.rank !== "无") identityParts.push(`<code>${escapeHtml(stat.rank)}</code>`);

  const displayName = stat.name.trim();
  const usernameText = stat.username || "";
  if (displayName && displayName !== stat.id && displayName !== usernameText) identityParts.push(escapeHtml(displayName));
  if (stat.username) identityParts.push(`<code>${escapeHtml(stat.username)}</code>`);
  identityParts.push(`<code>${stat.id}</code>`);

  const tailParts = [`<code>${escapeHtml(stat.avgText)}</code>`];
  if (stat.locked) tailParts.push("🔒");

  const commentText = escapeHtml(options?.commentText || buildSortComment(stat, index, total));
  const commentPrefix = options?.commentPrefix ? `${escapeHtml(options.commentPrefix)}：` : "";
  const rankLabel = options?.rankLabel || getRankDisplay(index);
  return `${rankLabel} ${identityParts.join(" ")} | ${tailParts.join(" | ")}\n   └ <i>${commentPrefix}${commentText}</i>\n`;
}

export function buildTargetDisplay(target: TargetDisplay): string {
  return `目标对话: <b>${escapeHtml(target.title)}</b>${target.username ? ` <code>${escapeHtml(target.username)}</code>` : ""}`;
}

export function buildSortText(target: TargetDisplay, stats: Stat[], counts: Counts): string {
  const headerLines = [
    `📊 <b>管理员排序简表</b>`,
    buildTargetDisplay(target),
    `管理员数量: 总 <code>${counts.totalCount}</code> | Bot <code>${counts.botCount}</code> | 非 Bot <code>${counts.nonBotCount}</code>`,
    `排序: <code>周日均消息数 ↓</code>`,
    "",
  ];
  const bodyLines = stats.map((stat, index) => buildCompactSortLine(stat, index, stats.length));
  return [...headerLines, ...bodyLines].join("\n").trim();
}

export function buildTailText(target: TargetDisplay, stats: Stat[], counts: Counts, limit: number): string {
  const unlockedStats = stats.filter(stat => !stat.locked);
  const visibleStats = unlockedStats.slice(-limit).reverse();
  const headerLines = [
    `📉 <b>未锁席位倒数榜</b>`,
    buildTargetDisplay(target),
    `管理员数量: 总 <code>${counts.totalCount}</code> | Bot <code>${counts.botCount}</code> | 非 Bot <code>${counts.nonBotCount}</code>`,
    `未锁席位: <code>${unlockedStats.length}</code> | 展示: <code>${visibleStats.length}</code> | 倒数范围: <code>${limit}</code>`,
    `排序: <code>未锁席位的周日均消息数倒数 ${limit} 人</code>`,
    "",
  ];
  if (unlockedStats.length === 0) return [...headerLines, "暂无未锁定席位的管理员。"].join("\n").trim();

  const bodyLines = visibleStats.map(stat => {
    const originalIndex = unlockedStats.findIndex(candidate => candidate.id === stat.id);
    const index = originalIndex >= 0 ? originalIndex : 0;
    return buildCompactSortLine(stat, index, unlockedStats.length, {commentText: buildTailComment(stat, index, unlockedStats.length)});
  });
  return [...headerLines, ...bodyLines].join("\n").trim();
}

export function userDisplay(user: any): string {
  const id = String(user.id);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || id;
  const parts: string[] = [];
  if (name && name !== id && name !== (user.username || "")) parts.push(escapeHtml(name));
  if (user.username) parts.push(`<code>${escapeHtml(user.username)}</code>`);
  parts.push(`<a href="tg://user?id=${escapeHtml(id)}">${escapeHtml(id)}</a>`);
  return parts.join(" ");
}

export function cachedUserDisplay(userId: string, cached?: {name?: string; username?: string | null}): string {
  if (!cached) return `<a href="tg://user?id=${escapeHtml(userId)}">${escapeHtml(userId)}</a>`;
  const parts: string[] = [];
  const name = (cached.name || "").trim();
  if (name && name !== userId && name !== (cached.username || "")) parts.push(escapeHtml(name));
  if (cached.username) parts.push(`<code>${escapeHtml(cached.username)}</code>`);
  parts.push(`<a href="tg://user?id=${escapeHtml(userId)}">${escapeHtml(userId)}</a>`);
  return parts.join(" ");
}
