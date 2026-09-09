import type {PluginContext} from "telebox/sdk";

type RecordItem = {domain: string; rawData: string; queryTime: string};
type Data = {history: RecordItem[]; cache: Record<string, RecordItem>;
  settings?: {maxHistory?: number; cacheHours?: number; enableNotifications?: boolean};
  legacyImported?: boolean};
type Metadata = Omit<Data, "history" | "cache">;
type Store = ReturnType<PluginContext["storage"]["sqlite"]>;
type Connection = Parameters<Parameters<Store["read"]>[0]>[0];

// Match the SDK's lossless integer handling for imported extension fields.
const json = JSON as unknown as {
  rawJSON(value: string): unknown;
  parse(value: string, reviver: (key: string, value: unknown, context: {source?: string}) => unknown): unknown;
};
const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? json.rawJSON(item.toString()) : item);
const decode = <T>(value: string): T => json.parse(value, (_key, item, context) =>
  typeof item === "number" && !Number.isSafeInteger(item) && /^-?\d+$/.test(context.source ?? "")
    ? BigInt(context.source!) : item) as T;

function metadata(db: Connection): Metadata | undefined {
  const row = db.prepare("SELECT value FROM metadata WHERE id = 1").get() as {value: string} | undefined;
  return row ? decode<Metadata>(row.value) : undefined;
}
function counts(db: Connection) {
  return {
    history: (db.prepare("SELECT count(*) AS count FROM history").get() as {count: bigint}).count,
    cache: (db.prepare("SELECT count(*) AS count FROM cache").get() as {count: bigint}).count,
  };
}
function merge(current: Data, legacy: Partial<Data>): Data {
  if (current.legacyImported || (!legacy.history && !legacy.cache)) return current;
  const seen = new Set<string>();
  const history = [...current.history, ...(legacy.history ?? [])].filter(item => {
    const key = encode([item.domain, item.queryTime, item.rawData]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return {...legacy, ...current, history, cache: {...legacy.cache, ...current.cache},
    settings: {...legacy.settings, ...current.settings}, legacyImported: true};
}
function importData(db: Connection, data: Data) {
  const {history, cache, ...meta} = data;
  db.exec("DELETE FROM history; DELETE FROM cache");
  const insert = db.prepare("INSERT INTO history (id, domain, query_time, value) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    insert.run(history.length - i, item.domain, item.queryTime, encode(item));
  }
  const put = db.prepare("INSERT INTO cache (domain, value) VALUES (?, ?)");
  for (const name of Object.keys(cache)) put.run(name, encode(cache[name]));
  db.prepare("INSERT OR REPLACE INTO metadata (id, value) VALUES (1, ?)").run(encode(meta));
}

export function records(ctx: PluginContext) {
  const store = ctx.storage.sqlite("records.sqlite");
  return {
    async initialize() {
      const existing = await store.transaction(db => {
        db.exec(`CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, domain TEXT NOT NULL, query_time TEXT NOT NULL, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS cache (domain TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        return metadata(db);
      });
      if (existing?.legacyImported) return;
      // JSON sources are retained as migration snapshots. The metadata row and
      // imported records commit together, so interrupted imports can be retried.
      const current = existing ? undefined : await ctx.storage.json<Data>("data.json", {history: [], cache: {}}).read();
      const legacy = current?.legacyImported ? {} : await ctx.storage.json<Partial<Data>>("whois_data.json", {}).read();
      if (existing && !legacy.history && !legacy.cache) return;
      await store.transaction(db => {
        const meta = metadata(db);
        if (meta?.legacyImported) return;
        if (!meta) { importData(db, merge(current!, legacy)); return; }
        // Preserve the original ability to import a legacy file added after a
        // fresh install. This full read runs only when such an import is needed.
        if (!legacy.history && !legacy.cache) return;
        const history = (db.prepare("SELECT value FROM history ORDER BY id DESC").all() as {value: string}[])
          .map(row => decode<RecordItem>(row.value));
        const cache = Object.fromEntries((db.prepare("SELECT domain, value FROM cache").all() as {domain: string; value: string}[])
          .map(row => [row.domain, decode<RecordItem>(row.value)]));
        importData(db, merge({...meta, history, cache}, legacy));
      });
    },
    lookup(name: string) {
      return store.read(db => {
        const row = db.prepare("SELECT value FROM cache WHERE domain = ?").get(name) as {value: string} | undefined;
        return {cached: row ? decode<RecordItem>(row.value) : undefined, settings: metadata(db)?.settings};
      });
    },
    history() {
      return store.read(db => ({...counts(db), rows: db.prepare(
        "SELECT domain, query_time AS queryTime FROM history ORDER BY id DESC LIMIT 20",
      ).all() as Pick<RecordItem, "domain" | "queryTime">[]}));
    },
    clear() {
      return store.transaction(db => {
        const result = counts(db);
        db.exec("DELETE FROM history; DELETE FROM cache");
        return result;
      });
    },
    save(item: RecordItem) {
      return store.transaction(db => {
        const limit = metadata(db)?.settings?.maxHistory;
        const maxHistory = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : 100;
        db.prepare("INSERT INTO history (domain, query_time, value) VALUES (?, ?, ?)")
          .run(item.domain, item.queryTime, encode(item));
        db.prepare("DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?)")
          .run(Math.min(Math.floor(maxHistory), Number.MAX_SAFE_INTEGER));
        db.prepare("INSERT INTO cache (domain, value) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET value = excluded.value")
          .run(item.domain, encode(item));
      });
    },
  };
}
export type WhoisRecords = ReturnType<typeof records>;
