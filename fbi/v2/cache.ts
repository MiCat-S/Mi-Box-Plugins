export type Cached = {id: number; senderId: string; date: number; text: string; [key: string]: unknown};
export type Chat = {username?: string; title?: string; msgs: Cached[]; lastActiveAt?: number; [key: string]: unknown};
export const MAX_MESSAGES = 3000;
const EXPIRE = 30 * 86400;

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
  const chats = new Map(Object.entries(cache).sort((a, b) => activity(a[1]) - activity(b[1])));
  let changed = false;
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
