import type {PluginContext} from "telebox/sdk";

export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/config.json";
export const ALLOWED_HOSTS = ["raw.githubusercontent.com", "github.com"] as const;

export type Role = {x:number;y:number;mask:string;brightness?:number;rotate?:number;flip?:boolean};
export type Stamp = {size:number;scale:number;rotate:number;opacity:number};
export type Entry = {name:string;url:string;me?:Role;you?:Role;stamp?:Stamp};
export type Catalog = Record<string, Entry>;
export type LoadedCatalog = {sourceUrl:string;resources:Catalog};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};

export function sourceURL(value: unknown): URL {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !ALLOWED_HOSTS.includes(url.hostname.toLowerCase() as typeof ALLOWED_HOSTS[number])) throw new Error("配置地址仅支持 GitHub HTTPS 原始文件");
  return url;
}

function repositoryRoot(configUrl: URL): URL {
  const parts = configUrl.pathname.split("/").filter(Boolean);
  if (configUrl.hostname === "raw.githubusercontent.com") {
    const branchAt = parts[2] === "refs" && parts[3] === "heads" ? 4 : 2;
    if (parts.length <= branchAt + 1) throw new Error("配置地址缺少仓库、分支或文件路径");
    return new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(2, branchAt + 1).join("/")}/`);
  }
  const rawAt = parts.indexOf("raw");
  const branchAt = parts[rawAt + 1] === "refs" && parts[rawAt + 2] === "heads" ? rawAt + 3 : rawAt + 1;
  if (rawAt !== 2 || parts.length <= branchAt + 1) throw new Error("配置地址必须是 GitHub raw 文件链接");
  return new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(rawAt + 1, branchAt + 1).join("/")}/`);
}

function assetURL(value: unknown, root: URL): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\u0000-\u001f]/.test(value)) throw new Error("素材路径无效");
  let url: URL;
  if (/^https:/i.test(value)) {
    url = sourceURL(value);
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean), rawAt = parts.indexOf("raw");
      if (rawAt !== 2 || parts.length <= rawAt + 2) throw new Error("素材地址必须是 GitHub raw 文件链接");
      url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(rawAt + 1).join("/")}`);
    }
  } else {
    if (value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("素材相对路径无效");
    url = new URL(value, root);
  }
  if (url.hostname !== "raw.githubusercontent.com") throw new Error("素材地址必须使用 GitHub raw 主机");
  return url.href;
}

function role(value: unknown, root: URL): Role | undefined {
  if (value === undefined) return;
  if (!record(value)) throw new Error("头像区域配置无效");
  return {x:Math.trunc(finite(value.x, 0, -4096, 4096)), y:Math.trunc(finite(value.y, 0, -4096, 4096)),
    mask:assetURL(value.mask, root), brightness:finite(value.brightness, 1, 0.1, 2),
    rotate:finite(value.rotate, 0, -360, 360), flip:value.flip === true};
}

function stamp(value: unknown): Stamp | undefined {
  if (value === undefined) return;
  if (!record(value)) throw new Error("印章配置无效");
  return {size:Math.trunc(finite(value.size, 512, 64, 512)), scale:finite(value.scale, 0.9, 0.05, 2),
    rotate:finite(value.rotate, -12, -360, 360), opacity:finite(value.opacity, 0.6, 0.05, 1)};
}

export function validateCatalog(value: unknown, configUrl: URL): Catalog {
  if (!record(value) || !record(value.resources)) throw new Error("配置文件缺少 resources");
  const entries = Object.entries(value.resources);
  if (!entries.length || entries.length > 100) throw new Error("配置项目数量无效");
  const root = repositoryRoot(configUrl), resources: Catalog = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key) || !record(raw) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) throw new Error("配置项目无效");
    const me = role(raw.me, root), you = role(raw.you, root), seal = stamp(raw.stamp);
    if (!me && !you && !seal) throw new Error("配置项目缺少头像区域");
    resources[key.toLowerCase()] = {name:raw.name.trim(), url:assetURL(raw.url, root), ...(me?{me}:{}), ...(you?{you}:{}), ...(seal?{stamp:seal}:{})};
  }
  return resources;
}

export async function readBytes(context: PluginContext, url: URL, maximum: number): Promise<Buffer> {
  return context.http.withResponse(url, {credentials:"omit"}, async (response, signal) => {
    if (!response.ok || !response.body) throw new Error(`素材下载失败（HTTP ${response.status}）`);
    const reader = response.body.getReader(), parts:Buffer[]=[]; let total=0, done=false;
    try {
      for (;;) {
        signal.throwIfAborted(); const result=await reader.read(); if(result.done){done=true;break;}
        total+=result.value.byteLength; if(total>maximum)throw new Error("远程内容超过大小限制"); parts.push(Buffer.from(result.value));
      }
    } finally { try{if(!done)await reader.cancel();}catch{}finally{reader.releaseLock();} }
    if (!total) throw new Error("远程内容为空");
    return Buffer.concat(parts,total);
  }, {timeoutMs:30_000, redirects:{allowedHosts:ALLOWED_HOSTS,maxRedirects:2}});
}

export async function loadCatalog(context: PluginContext, value: unknown): Promise<LoadedCatalog> {
  const url=sourceURL(value), bytes=await readBytes(context,url,512*1024);
  let decoded:unknown; try{decoded=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("配置文件不是有效 JSON");}
  return {sourceUrl:url.href, resources:validateCatalog(decoded,url)};
}
