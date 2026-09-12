import {isIP} from "node:net";

export type Server = {name: string; host: string; port: number; username: string; fingerprint: string};
export type State = {schemaVersion: 1; timeoutSeconds: number; servers: Server[]; legacyDatabaseDetected: boolean; legacyNoticeShown: boolean};
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 180;
export const DEFAULT_TIMEOUT_SECONDS = 180;
export const DEFAULTS: State = {schemaVersion: 1, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, servers: [], legacyDatabaseDetected: false, legacyNoticeShown: false};

export function parseTimeout(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_TIMEOUT_SECONDS && number <= MAX_TIMEOUT_SECONDS ? number : undefined;
}

export function normalizeTimeout(value: unknown): number {
  return parseTimeout(value) ?? DEFAULT_TIMEOUT_SECONDS;
}

function validHost(value: string): boolean {
  if (isIP(value)) return true;
  return value.length <= 253 && value.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

export function parseConnection(value: string): {username: string; host: string; port: number} {
  const matched = /^([A-Za-z0-9._-]{1,64})@(?:\[([0-9A-Fa-f:]+)\]|([^:\s]+))(?::([0-9]{1,5}))?$/u.exec(value);
  if (!matched) throw new Error("连接格式应为 user@host:port 或 user@[IPv6]:port");
  const host = matched[2] ?? matched[3]!; const port = Number(matched[4] ?? 22);
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("主机或端口无效");
  return {username: matched[1]!, host: host.toLowerCase(), port};
}

export function normalizeServer(value: any): Server | undefined {
  if (!value || typeof value !== "object") return;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const username = typeof value.username === "string" ? value.username : "";
  const host = typeof value.host === "string" ? value.host.toLowerCase() : "";
  const port = Number(value.port); const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint : "";
  if (!name || name.length > 64 || /[\u0000-\u001f|]/u.test(name) || !/^[A-Za-z0-9._-]{1,64}$/u.test(username) ||
      !validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^SHA256:[A-Za-z0-9+/]{20,100}={0,2}$/u.test(fingerprint)) return;
  return {name, username, host, port, fingerprint};
}

export function normalizeState(value: any): State {
  const source = value && typeof value === "object" ? value : {};
  const servers: Server[] = []; const names = new Set<string>();
  for (const raw of Array.isArray(source.servers) ? source.servers : []) {
    const server = normalizeServer(raw); const key = server?.name.toLowerCase();
    if (server && key && !names.has(key)) { names.add(key); servers.push(server); }
    if (servers.length >= 100) break;
  }
  return {...source, schemaVersion: 1, timeoutSeconds: normalizeTimeout(source.timeoutSeconds ?? source.timeout), servers,
    legacyDatabaseDetected: source.legacyDatabaseDetected === true, legacyNoticeShown: source.legacyNoticeShown === true};
}

export function selectServer(servers: readonly Server[], value: string): Server | undefined {
  if (/^[1-9][0-9]*$/u.test(value)) return servers[Number(value) - 1];
  const name = value.toLowerCase(); return servers.find(server => server.name.toLowerCase() === name);
}
