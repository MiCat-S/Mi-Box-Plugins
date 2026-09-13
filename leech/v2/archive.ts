import {ui, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import type {ArchiveInput} from "./input";

const FILE = "leech.sqlite";
const db = (context: PluginContext) => context.storage.sqlite(FILE);
const exact = (value: unknown): string | null => value === undefined || value === null ? null : String(value);

function schema(connection: any): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS leech_jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, chat_id TEXT, chat_title TEXT,
      chat_type TEXT, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL, status TEXT NOT NULL,
      requested_limit INTEGER, batch_size INTEGER NOT NULL, saved_count INTEGER NOT NULL DEFAULT 0,
      scanned_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, error_kind TEXT);
    CREATE TABLE IF NOT EXISTS leech_messages(
      chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, first_job_id INTEGER NOT NULL,
      last_job_id INTEGER NOT NULL, date_ts INTEGER NOT NULL, sender_id TEXT, sender_username TEXT,
      sender_name TEXT, message_text TEXT, media_type TEXT, reply_to_msg_id INTEGER, grouped_id TEXT,
      views INTEGER, forwards INTEGER, is_out INTEGER NOT NULL DEFAULT 0, raw_json TEXT NOT NULL,
      saved_at TEXT NOT NULL, PRIMARY KEY(chat_id,message_id));
    CREATE INDEX IF NOT EXISTS idx_leech_messages_date ON leech_messages(chat_id,date_ts);
  `);
}

export async function ensureDatabase(context: PluginContext, recover = false): Promise<void> {
  await db(context).transaction(connection => {
    schema(connection);
    if (recover) connection.prepare(
      "UPDATE leech_jobs SET status='failed',error_kind='INTERRUPTED',finished_at=? WHERE status='running'"
    ).run(new Date().toISOString());
  }, context.signal);
}

async function deliver(context: PluginContext, message: MessageEnvelope, html: string, event: string): Promise<boolean> {
  const pages = await ui.renderRichText(html, ui.PAGE_LABEL_RESERVE);
  const result = await ui.deliverPages(pages, context.signal, async (page, index) => {
    const body = `${page}${ui.pageLabel(index, pages.length)}`;
    if (index === 0) await context.telegram.edit(message, body, {parseMode: "html"});
    else await context.telegram.reply(message, body, {parseMode: "html"});
  });
  if (!result.interrupted) return true;
  context.log.error(event);
  if (result.published > 0) {
    try { await context.telegram.reply(message, ui.interruptedNotice(result)); }
    catch { if (!context.signal.aborted) context.log.error(`${event}_notice`); }
  }
  return false;
}

async function nativeTarget(value: unknown): Promise<unknown> {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return value;
  return (await import("teleproto/Helpers.js")).returnBigInt(value);
}

function normalizedTarget(value: string): string {
  const match = /^https?:\/\/t\.me\/(?:c\/)?([^/?#]+)/i.exec(value);
  if (match) return /^\d+$/.test(match[1]) ? `-100${match[1]}` : `@${match[1].replace(/^@/, "")}`;
  return /^-?\d+$/.test(value) || value.startsWith("@") ? value : `@${value}`;
}

function identity(entity: any) {
  const source = String(entity?.id ?? "unknown");
  const id = entity?.className === "Channel" ? (source.startsWith("-100") ? source : `-100${source}`) :
    entity?.className?.startsWith("Chat") ? (source.startsWith("-") ? source : `-${source}`) : source;
  const title = String(entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") ||
    (entity?.username ? `@${entity.username}` : entity?.className || "unknown")).slice(0, 4_000);
  const type = entity?.className === "Channel" ? (entity.broadcast ? "channel" : "supergroup") :
    entity?.className?.startsWith("Chat") ? "group" : entity?.className === "User" ? (entity.bot ? "bot" : "user") :
    entity?.className || "unknown";
  return {id, title, type};
}

function snapshot(message: any): string {
  return JSON.stringify({className: message?.className, id: message?.id, date: message?.date,
    message: message?.message, senderId: exact(message?.senderId), chatId: exact(message?.chatId),
    peerId: exact(message?.peerId), mediaClassName: message?.media?.className ?? null,
    groupedId: exact(message?.groupedId), views: message?.views ?? null, forwards: message?.forwards ?? null,
    out: Boolean(message?.out)});
}

async function markFailed(context: PluginContext, job: number, saved: number, scanned: number, kind: string): Promise<void> {
  if (!job) return;
  await db(context).transaction(connection => {
    schema(connection);
    connection.prepare("UPDATE leech_jobs SET status='failed',saved_count=?,scanned_count=?,finished_at=?,error_kind=? WHERE id=?")
      .run(saved, scanned, new Date().toISOString(), kind, job);
  }).catch(() => undefined);
}

export async function archive(invocation: CommandInvocation, context: PluginContext, input: ArchiveInput): Promise<void> {
  await context.telegram.edit(invocation.message,
    `⏳ Leech started\n· Target: <code>${ui.text(input.target)}</code>\n· Range: <code>${ui.text(input.label)}</code>\n· Batch: <code>${input.batch}</code>\n· Limit: <code>${input.limit ?? "unlimited"}</code>`, {parseMode: "html"});
  let job = 0, saved = 0, scanned = 0, stopped = "completed";
  let chat: ReturnType<typeof identity> | undefined;
  try {
    await context.telegram.withClient(async (client: any, signal) => {
      signal.throwIfAborted();
      const raw = invocation.message.raw as {peerId?: unknown} | undefined;
      const value = input.target === "here" ? raw?.peerId ?? invocation.message.chatId : normalizedTarget(input.target);
      const resolvedTarget = await nativeTarget(value);
      signal.throwIfAborted();
      const entity = await client.getEntity(resolvedTarget);
      signal.throwIfAborted();
      chat = identity(entity);
      job = await db(context).transaction(connection => {
        schema(connection);
        return Number(connection.prepare("INSERT INTO leech_jobs(target,chat_id,chat_title,chat_type,from_ts,to_ts,status,requested_limit,batch_size,started_at) VALUES(?,?,?,?,?,?,'running',?,?,?)")
          .run(input.target, chat!.id, chat!.title, chat!.type, input.from, input.to, input.limit ?? null, input.batch, new Date().toISOString()).lastInsertRowid);
      }, signal);
      let offsetId = 0, offsetDate = input.to + 1;
      for (;;) {
        signal.throwIfAborted();
        if (input.limit && saved >= input.limit) { stopped = "limit_reached"; break; }
        const count = input.limit ? Math.min(input.batch, input.limit - saved) : input.batch;
        const messages = Array.from(await client.getMessages(entity, {limit: count, offsetId, offsetDate}) ?? [])
          .filter((message: any) => Number.isSafeInteger(message?.id)) as any[];
        signal.throwIfAborted();
        if (!messages.length) { stopped = "no_more_messages"; break; }
        let boundary = false;
        const rows: any[] = [];
        for (const message of messages) {
          signal.throwIfAborted();
          scanned += 1;
          const timestamp = Number(message.date ?? 0);
          if (timestamp < input.from) { boundary = true; continue; }
          if (timestamp > input.to || !Number.isSafeInteger(timestamp) || timestamp <= 0) continue;
          const sender = message.sender;
          rows.push({chatId: chat.id, messageId: message.id, timestamp, senderId: exact(message.senderId),
            username: sender?.username ?? null, name: sender?.title || [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") || null,
            text: typeof message.message === "string" ? message.message : null, media: message.media?.className ?? null,
            reply: Number(message.replyTo?.replyToMsgId ?? message.replyToMsgId) || null, grouped: exact(message.groupedId),
            views: Number(message.views) || null, forwards: Number(message.forwards) || null, outgoing: message.out ? 1 : 0,
            json: snapshot(message), savedAt: new Date().toISOString()});
          if (input.limit && saved + rows.length >= input.limit) { stopped = "limit_reached"; break; }
        }
        const committedSaved = saved + rows.length;
        await db(context).transaction(connection => {
          schema(connection);
          const statement = connection.prepare(`INSERT INTO leech_messages(chat_id,message_id,first_job_id,last_job_id,date_ts,sender_id,sender_username,sender_name,message_text,media_type,reply_to_msg_id,grouped_id,views,forwards,is_out,raw_json,saved_at) VALUES(@chatId,@messageId,@job,@job,@timestamp,@senderId,@username,@name,@text,@media,@reply,@grouped,@views,@forwards,@outgoing,@json,@savedAt) ON CONFLICT(chat_id,message_id) DO UPDATE SET last_job_id=excluded.last_job_id,date_ts=excluded.date_ts,sender_id=excluded.sender_id,sender_username=excluded.sender_username,sender_name=excluded.sender_name,message_text=excluded.message_text,media_type=excluded.media_type,reply_to_msg_id=excluded.reply_to_msg_id,grouped_id=excluded.grouped_id,views=excluded.views,forwards=excluded.forwards,is_out=excluded.is_out,raw_json=excluded.raw_json,saved_at=excluded.saved_at`);
          for (const row of rows) statement.run({...row, job});
          connection.prepare("UPDATE leech_jobs SET saved_count=?,scanned_count=? WHERE id=?").run(committedSaved, scanned, job);
        }, signal);
        saved = committedSaved;
        if (stopped === "limit_reached" || boundary) { if (boundary && stopped !== "limit_reached") stopped = "from_boundary_reached"; break; }
        const last = messages.at(-1)!;
        offsetId = last.id;
        offsetDate = Number(last.date ?? 0);
        if (messages.length < count) { stopped = "short_batch"; break; }
        try { await context.telegram.edit(invocation.message, `⏳ Leech progress\n· Saved: <code>${saved}</code>\n· Scanned: <code>${scanned}</code>`, {parseMode: "html"}); }
        catch { if (!signal.aborted) context.log.error("leech_progress_delivery_failed"); }
      }
    });
    context.signal.throwIfAborted();
    await db(context).transaction(connection => {
      schema(connection);
      connection.prepare("UPDATE leech_jobs SET status='completed',saved_count=?,scanned_count=?,finished_at=?,error_kind=NULL WHERE id=?")
        .run(saved, scanned, new Date().toISOString(), job);
    }, context.signal);
  } catch {
    await markFailed(context, job, saved, scanned, context.signal.aborted ? "INTERRUPTED" : "FAILED");
    if (!context.signal.aborted) {
      context.log.error("leech_archive_failed");
      await context.telegram.edit(invocation.message, "❌ Leech 归档失败，请检查目标、日期与访问权限");
    }
    return;
  }
  const result = `✅ Leech completed\n· Job: <code>${job}</code>\n· Chat: <code>${ui.text(chat!.title)}</code> (${ui.text(chat!.id)})\n· Type: <code>${ui.text(chat!.type)}</code>\n· Saved: <code>${saved}</code>\n· Scanned: <code>${scanned}</code>\n· Stop: <code>${stopped}</code>\n· DB: <code>assets/leech/${FILE}</code>`;
  await deliver(context, invocation.message, result, "leech_result_delivery_failed");
}

export async function session(invocation: CommandInvocation, context: PluginContext): Promise<void> {
  try {
    const me: any = await context.telegram.withClient(async (client, signal) => {
      signal.throwIfAborted(); const result = await client.getMe(); signal.throwIfAborted(); return result;
    });
    const result = `✅ Telegram session OK\n· ID: <code>${ui.text(exact(me?.id) ?? "N/A")}</code>\n· Username: <code>${ui.text(me?.username ? `@${me.username}` : "N/A")}</code>\n· Name: <code>${ui.text([me?.firstName, me?.lastName].filter(Boolean).join(" ") || me?.username || "unknown")}</code>`;
    await deliver(context, invocation.message, result, "leech_session_delivery_failed");
  } catch { if (!context.signal.aborted) { context.log.error("leech_session_failed"); await context.telegram.edit(invocation.message, "❌ Leech 会话检查失败"); } }
}

export async function jobs(invocation: CommandInvocation, context: PluginContext): Promise<void> {
  const requested = Number(invocation.args[1] ?? 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.trunc(requested))) : 10;
  const rows = await db(context).transaction(connection => { schema(connection); return connection.prepare("SELECT id,status,chat_title,target,saved_count,from_ts,to_ts FROM leech_jobs ORDER BY id DESC LIMIT ?").all(limit) as any[]; }, context.signal);
  const result = rows.length ? `<b>Recent Leech Jobs</b>\n${rows.map(row => `#${row.id} | ${ui.text(row.status)} | ${ui.text(row.chat_title || row.target)} | saved=${row.saved_count} | range=${row.from_ts}-${row.to_ts}`).join("\n")}` : "📭 No leech jobs yet.";
  await deliver(context, invocation.message, result, "leech_jobs_delivery_failed");
}

export async function stats(invocation: CommandInvocation, context: PluginContext): Promise<void> {
  const value = await db(context).transaction(connection => { schema(connection); return {messages:(connection.prepare("SELECT COUNT(*) n FROM leech_messages").get() as any).n,jobs:(connection.prepare("SELECT COUNT(*) n FROM leech_jobs").get() as any).n}; }, context.signal);
  await deliver(context, invocation.message, `<b>Leech SQLite Stats</b>\n· Messages: <code>${value.messages}</code>\n· Jobs: <code>${value.jobs}</code>\n· DB: <code>assets/leech/${FILE}</code>`, "leech_stats_delivery_failed");
}
