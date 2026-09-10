export type Cached = {id: number; senderId: string; date: number; text: string; [key: string]: unknown};
export type Chat = {username?: string; title?: string; msgs: Cached[]; lastActiveAt?: number; [key: string]: unknown};
export const MAX_MESSAGES = 3000;
const EXPIRE = 30 * 86400;

export const isGroupPeer = (peer: string): boolean => /^-[1-9]\d*$/.test(peer);

export function prune(chat: Chat, now = Math.floor(Date.now() / 1000)): boolean {
  const previousLength = chat.msgs.length;
  const seen = new Set<number>();
  let kept = 0;
  for (const message of chat.msgs) {
    if (!(message.date > now - EXPIRE) || seen.has(message.id)) continue;
    seen.add(message.id);
    chat.msgs[kept++] = message;
    if (kept === MAX_MESSAGES) break;
  }
  chat.msgs.length = kept;
  return kept !== previousLength;
}

export function activity(chat: Chat): number {
  return chat.lastActiveAt ?? chat.msgs.reduce((latest, message) => Math.max(latest, message.date * 1000), 0);
}

export function trimGroups(chats: Map<string, Chat>, limit: number): boolean {
  let changed = false;
  while (chats.size > limit) {
    chats.delete(chats.keys().next().value!);
    changed = true;
  }
  return changed;
}

// Map insertion order is oldest to newest; store the activity explicitly because
// JSON object keys that look like integers do not preserve insertion order.
export function restore(cache: Record<string, Chat>, limit: number): {chats: Map<string, Chat>; changed: boolean} {
  const entries = Object.entries(cache);
  const chats = new Map(entries.filter(([peer]) => isGroupPeer(peer)).sort((a, b) => activity(a[1]) - activity(b[1])));
  let changed = chats.size !== entries.length;
  for (const chat of chats.values()) changed = prune(chat) || changed;
  changed = trimGroups(chats, limit) || changed;
  return {chats, changed};
}

export function upsert(chat: Chat, message: Cached): void {
  const index = chat.msgs.findIndex(previous => previous.id === message.id);
  if (index >= 0) {
    const previous = chat.msgs.splice(index, 1)[0]!;
    message = {...previous, ...message};
  }
  chat.msgs.unshift(message);
  prune(chat);
}

/**
 * Merge fetched history with messages observed during a rebuild. The fetched
 * history is the base; an increment wins for the same id. `previous` is only a
 * metadata source for ids that appear in base/increments: unknown fields from
 * the existing cached message survive, and old messages never re-enter the
 * result. The result is newest-first.
 */
export function mergeMessages(base: readonly Cached[], increments: Iterable<Cached>, previous: readonly Cached[] = []): Cached[] {
  const metadata = new Map<number, Cached>();
  for (const message of previous) metadata.set(message.id, message);
  const result = new Map<number, Cached>();
  const put = (message: Cached): void => {
    const prior = result.get(message.id) ?? metadata.get(message.id);
    result.set(message.id, prior ? {...prior, ...message} : message);
  };
  for (const message of base) put(message);
  for (const message of increments) put(message);
  return [...result.values()].sort((a, b) => b.date - a.date || b.id - a.id);
}
