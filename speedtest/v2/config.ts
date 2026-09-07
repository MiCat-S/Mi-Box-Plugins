import {readFile, lstat} from "node:fs/promises";
import type {PluginContext} from "telebox/sdk";

export type MessageType = "photo" | "sticker" | "file" | "txt";

export type SpeedtestState = {
  schemaVersion: 1;
  default_server_id: number | null;
  preferred_type: MessageType | null;
  legacyImported: boolean;
  [key: string]: unknown;
};

export const DEFAULT_ORDER: readonly MessageType[] = ["photo", "sticker", "file", "txt"];
export const DEFAULTS: SpeedtestState = {
  schemaVersion: 1,
  default_server_id: null,
  preferred_type: null,
  legacyImported: false,
};

const store = (context: PluginContext) => context.storage.json<SpeedtestState>("v2-config.json", DEFAULTS);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function normalizeType(value: unknown): MessageType | null {
  if (value === "text") return "txt";
  return value === "photo" || value === "sticker" || value === "file" || value === "txt" ? value : null;
}

export function normalizeState(value: unknown): SpeedtestState {
  const source = record(value);
  return {
    ...source,
    schemaVersion: 1,
    default_server_id: positiveSafeInteger(source.default_server_id),
    preferred_type: normalizeType(source.preferred_type),
    legacyImported: source.legacyImported === true,
  };
}

function parseRecord(text: string): Record<string, unknown> {
  type SourceJson = {parse(input: string, reviver: (key: string, value: unknown, context: {source?: string}) => unknown): unknown};
  const sourceJson = JSON as unknown as SourceJson;
  const parsed = sourceJson.parse(text, (_key, value, context) => {
    if (typeof value === "number" && context?.source && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) {
      return BigInt(context.source);
    }
    return value;
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Legacy Speedtest configuration must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

type LegacyRead = {exists: false} | {exists: true; value: Record<string, unknown>};

async function readLegacy(context: PluginContext, fileName: string): Promise<LegacyRead> {
  return context.tasks.run(`speedtest:legacy:${fileName}`, async signal => {
    const file = context.files.dataPath(fileName);
    let info;
    try { info = await lstat(file); }
    catch (error) {
      signal.throwIfAborted();
      if (hasCode(error, "ENOENT")) return {exists: false};
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Legacy Speedtest configuration is not a regular file: ${fileName}`);
    const value = parseRecord(await readFile(file, {encoding: "utf8", signal}));
    return {exists: true, value};
  });
}

async function exists(context: PluginContext, fileName: string): Promise<boolean> {
  return context.tasks.run(`speedtest:exists:${fileName}`, async signal => {
    try {
      const info = await lstat(context.files.dataPath(fileName));
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Speedtest configuration is not a regular file: ${fileName}`);
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  });
}

export async function migrateConfig(context: PluginContext): Promise<SpeedtestState> {
  const currentStore = store(context);
  const current = normalizeState(await currentStore.read());
  if (current.legacyImported) return current;

  const currentExists = await exists(context, "v2-config.json");
  const [panel, command] = await Promise.all([
    readLegacy(context, "config.json"),
    readLegacy(context, "speedtest.json"),
  ]);
  const legacy = {...(panel.exists ? panel.value : {}), ...(command.exists ? command.value : {})};
  const merged = currentExists ? {...legacy, ...current} : legacy;
  return currentStore.update(() => normalizeState({...merged, legacyImported: true}));
}

export async function readConfig(context: PluginContext): Promise<SpeedtestState> {
  return normalizeState(await store(context).read());
}

export async function updateConfig(
  context: PluginContext,
  patch: Partial<Pick<SpeedtestState, "default_server_id" | "preferred_type">>,
): Promise<SpeedtestState> {
  return store(context).update(current => normalizeState({...current, ...patch, legacyImported: true}));
}

export function messageOrder(preferred: MessageType | null): MessageType[] {
  return preferred ? [preferred, ...DEFAULT_ORDER.filter(type => type !== preferred)] : [...DEFAULT_ORDER];
}
