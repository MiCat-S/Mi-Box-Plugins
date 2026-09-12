export const PAGE_SIZE = 5;
export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_SESSIONS = 200;

export const MUSIC_SOURCES = [
  {key: "netease", name: "网易云音乐", stable: true, aliases: ["wy", "wangyi", "163"]},
  {key: "tencent", name: "QQ 音乐", stable: false, aliases: ["qq", "tx", "tc"]},
  {key: "kuwo", name: "酷我音乐", stable: true, aliases: ["kw"]},
  {key: "tidal", name: "TIDAL", stable: false, aliases: []},
  {key: "qobuz", name: "Qobuz", stable: false, aliases: []},
  {key: "joox", name: "JOOX", stable: true, aliases: []},
  {key: "bilibili", name: "Bilibili", stable: false, aliases: ["bili"]},
  {key: "apple", name: "Apple Music", stable: false, aliases: ["apple_music", "am"]},
  {key: "ytmusic", name: "YouTube Music", stable: false, aliases: ["youtube", "yt"]},
  {key: "spotify", name: "Spotify", stable: false, aliases: ["spot"]},
] as const;

export type SourceKey = (typeof MUSIC_SOURCES)[number]["key"];
export type SourceMode = SourceKey | "auto";

export type MusicHubConfig = {
  schemaVersion: 1;
  defaultSource: SourceMode;
  br: string;
  maxResults: number;
  maxUploadBytes: number;
  [key: string]: unknown;
};

export type ApiSong = {
  id: string;
  name: string;
  artist: string[];
  album?: string;
  urlId: string;
  source: SourceKey;
};

export type SongUrlInfo = {url: URL; br?: number; size?: number};

export type SearchSession = {
  query: string;
  requestedSource: SourceMode;
  resolvedSource: SourceKey;
  results: ApiSong[];
  page: number;
  createdAt: number;
};

export const DEFAULT_CONFIG: MusicHubConfig = {
  schemaVersion: 1,
  defaultSource: "auto",
  br: "999",
  maxResults: 30,
  maxUploadBytes: 100 * 1024 * 1024,
};

const QUALITY: Readonly<Record<string, string>> = {
  low: "128",
  medium: "320",
  high: "999",
  "128": "128",
  "320": "320",
  "999": "999",
};

const SOURCE_ALIASES = new Map<string, SourceMode>([
  ["auto", "auto"], ["a", "auto"],
  ...MUSIC_SOURCES.flatMap(source => [
    [source.key, source.key] as const,
    ...source.aliases.map(alias => [alias, source.key] as const),
  ]),
]);

export function normalizeSource(value: unknown): SourceMode | undefined {
  if (typeof value !== "string") return;
  return SOURCE_ALIASES.get(value.trim().toLowerCase());
}

export function normalizeBitrate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value).trim().toLowerCase();
  return QUALITY[text] ?? (/^\d{2,4}$/.test(text) ? text : undefined);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

export function normalizeConfig(value: unknown): MusicHubConfig {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    ...source,
    schemaVersion: 1,
    defaultSource: normalizeSource(source.defaultSource) ?? DEFAULT_CONFIG.defaultSource,
    br: normalizeBitrate(source.br) ?? DEFAULT_CONFIG.br,
    maxResults: boundedInteger(source.maxResults, DEFAULT_CONFIG.maxResults, PAGE_SIZE, 100),
    maxUploadBytes: boundedInteger(source.maxUploadBytes, DEFAULT_CONFIG.maxUploadBytes, 1024 * 1024, 2 * 1024 * 1024 * 1024),
  };
}

export function sourceLabel(source: SourceMode): string {
  if (source === "auto") return "自动选择 (auto)";
  const item = MUSIC_SOURCES.find(entry => entry.key === source)!;
  return `${item.name} (${item.key})`;
}

export function autoSourceOrder(): SourceKey[] {
  return [
    ...MUSIC_SOURCES.filter(source => source.stable).map(source => source.key),
    ...MUSIC_SOURCES.filter(source => !source.stable).map(source => source.key),
  ];
}

export function formatArtists(artists: readonly string[]): string {
  return artists.filter(Boolean).join(" / ") || "未知歌手";
}

export function normalizeSearchResults(value: unknown, fallbackSource: SourceKey, maximum: number): ApiSong[] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const candidates = Array.isArray(value) ? value
    : Array.isArray(record?.data) ? record.data
      : Array.isArray(record?.result) ? record.result
        : Array.isArray(record?.songs) ? record.songs : [];
  const result: ApiSong[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const name = String(raw.name ?? raw.title ?? "").trim();
    const id = String(raw.id ?? raw.song_id ?? raw.url_id ?? "").trim();
    const source = normalizeSource(String(raw.source ?? fallbackSource));
    if (!name || !id || !source || source === "auto") continue;
    const artistValue = raw.artist ?? raw.artists ?? raw.singer ?? [];
    const artist = (Array.isArray(artistValue) ? artistValue.map(String) : String(artistValue).split(/[/,，]/))
      .map(item => item.trim()).filter(Boolean).slice(0, 20);
    result.push({
      id: id.slice(0, 512),
      name: name.slice(0, 500),
      artist,
      ...(raw.album ? {album: String(raw.album).slice(0, 500)} : {}),
      urlId: String(raw.url_id ?? id).slice(0, 512),
      source,
    });
    if (result.length === maximum) break;
  }
  return result;
}

export function sessionKey(chatId: string, senderId?: string): string {
  return `${chatId}:${senderId ?? "unknown-sender"}`;
}

export function parsePositiveIndex(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function clampPage(page: number, resultCount: number): number {
  const pages = Math.max(1, Math.ceil(resultCount / PAGE_SIZE));
  return Math.max(1, Math.min(Number.isSafeInteger(page) ? page : 1, pages));
}
