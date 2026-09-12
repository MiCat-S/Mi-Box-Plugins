import {readFile} from "node:fs/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type MessageEnvelope, type PluginContext, type SubcommandDefinition,
} from "telebox/sdk";
import type {Api} from "teleproto";

type State = {schemaVersion:1; accessToken:string; model:string; maxWaitMs:number; importedLegacy:boolean; aiMigrated?:boolean; [key:string]:unknown};
type ImageResult = {data?:Uint8Array; mimeType?:string; revisedPrompt?:string};
const defaults: State = {schemaVersion:1, accessToken:"", model:"", maxWaitMs:600_000, importedLegacy:true, aiMigrated:true};
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MAX_INPUT = 20 * 1024 * 1024, MAX_IMAGE = 32 * 1024 * 1024;
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults);
const esc = (value:unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

async function migrate(context: PluginContext): Promise<void> {
  let current = await store(context).read();
  if (!current.importedLegacy) {
    let source: any = current;
    try {source = {...JSON.parse(await readFile(context.files.dataPath("config.json"), "utf8")), ...current};} catch {}
    current = await store(context).update(() => ({...source, schemaVersion:1,
      accessToken:typeof source.accessToken === "string" ? source.accessToken.trim() : "",
      model:typeof source.model === "string" && source.model.trim() ? source.model.trim() : "gpt-5.4",
      maxWaitMs:Math.max(60_000, Math.min(1_800_000, Number(source.maxWaitMs) || 600_000)),
      importedLegacy:true, aiMigrated:source.aiMigrated === true}));
  }
  if (current.aiMigrated) return;
  if (!current.accessToken) {
    await store(context).update(value => ({...value, accessToken:"", model:"", aiMigrated:true})); return;
  }
  if (!context.services.available("ai", "import_provider")) return;
  await context.services.call("ai", "import_provider", {tag:"codex", url:ENDPOINT, key:current.accessToken,
    type:"codex", models:{image:current.model || "gpt-5.4"}, select:["image"]}, context.signal);
  await store(context).update(value => ({...value, accessToken:"", model:"", aiMigrated:true}));
}

async function reference(context: PluginContext, message: MessageEnvelope) {
  if (!message.replyToId) return;
  const reply = await context.telegram.getReply(message); if (!reply?.raw) return;
  return context.telegram.withClient(async (client, signal) => {
    const raw = reply.raw as any;
    const mimeType = String(raw.media?.document?.mimeType ?? (raw.media?.photo ? "image/jpeg" : ""));
    if (!mimeType.startsWith("image/")) throw new Error("reply_not_image");
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of client.iterDownload(raw.media, {})) {
      signal.throwIfAborted(); total += chunk.length;
      if (total > MAX_INPUT) throw new Error("image_too_large"); chunks.push(Buffer.from(chunk));
    }
    if (!total) throw new Error("empty_image");
    return {mimeType, data:Buffer.concat(chunks, total), reply};
  });
}

export default function createCodexImage() {
  const token: SubcommandDefinition = {
    description:"查看统一 AI 配置方式", args:"", async handle({message,prefix}, context) {
      await context.telegram.edit(message,
        `供应商、Access Token 和图片模型由 ai 插件统一管理，请使用 ${prefix}ai config 与 ${prefix}ai model image。`);
    },
  };
  const cximg: CommandDefinition = {
    description:"使用统一 AI 图片模型生成或编辑图片", helpArgs:["help","h"], args:"<提示词>",
    arguments:[{name:"提示词",required:true,description:"生成或编辑图片的提示词"}],
    examples:[{args:"一只坐在窗边的橘猫，水彩插画"},{args:"保留主体，把背景改成海边。",description:"回复图片后发送"}],
    subcommandsCaseSensitive:false, subcommands:{token}, ignoreEdited:true,
    help:[
      {heading:"AI 配置：",body:"供应商、凭据和图片模型由 ai 插件统一管理；先用 <code>{prefix}ai config</code> 添加配置，再用 <code>{prefix}ai model image</code> 选择图片模型。Codex 服务可使用类型 <code>codex</code>。"},
      {heading:"使用：",body:"直接发送提示词按文字生成；回复图片后发送提示词，会把该图片作为参考图，成功发送后删除生成命令。"},
      {heading:"媒体与结果：",body:"参考图需为图片媒体或图片文件，单张下载上限 20 MiB；生成图片上限 32 MiB。最大等待时间默认 600000 毫秒，可在本插件设置中调整。"},
      {heading:"隐私：",body:"提示词和参考图会发送到 ai 插件当前选择的图片服务。"},
    ],
    async handle({message,args,prefix}, context) {
      const prompt = args.join(" ").trim();
      if (!prompt) {await context.telegram.edit(message, `用法：${prefix}cximg <提示词>`); return;}
      try {
        await migrate(context);
        if (!context.services.available("ai", "image")) {await context.telegram.edit(message, "请先安装并配置 ai 插件的图片模型"); return;}
        const ref = await reference(context, message);
        await context.telegram.edit(message, ref ? "已读取参考图，正在生成…" : "正在生成图片…");
        const state = await store(context).read();
        const results = await context.services.call<ImageResult[]>("ai", "image", {prompt, timeoutMs:state.maxWaitMs,
          ...(ref ? {input:{data:ref.data,mimeType:ref.mimeType}} : {})}, context.signal);
        const first = results[0], image = Buffer.from(first?.data ?? []);
        if (!image.length || image.length > MAX_IMAGE) throw new Error("invalid_image");
        await context.telegram.withClient(async client => {
          const {CustomFile} = await import("teleproto/client/uploads.js"); const raw = message.raw as Api.Message;
          if (!raw?.peerId) throw new Error("missing_peer");
          await client.sendFile(raw.peerId, {file:new CustomFile(`ai-image-${Date.now()}.png`, image.length, "", image),
            caption:`<b>提示词：</b>\n<blockquote expandable>${esc(prompt)}</blockquote>${first?.revisedPrompt ? `\n<b>修订提示词：</b>\n<blockquote expandable>${esc(first.revisedPrompt)}</blockquote>` : ""}`,
            parseMode:"html", replyTo:ref?.reply.id ?? message.id});
          if (typeof raw.delete === "function") { try { await raw.delete({revoke:true}); }
            catch { if (!context.signal.aborted) context.log.info("codex_image_receipt_cleanup_failed"); } }
        });
      } catch {if (!context.signal.aborted) {context.log.error("codex_image_failed"); await context.telegram.edit(message, "图片生成失败，请检查 ai 配置、网络和服务状态");}}
    },
  };
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION, id:"codex_image",
    description:"通过统一 AI 图片服务生成或编辑图片", renderHelp:prefix => renderCommandHelp("cximg", cximg, {prefix,title:"🎨 AI 图片生成"}),
    commands:{cximg},
    settings:context => ({id:"codex_image", title:"AI 图片生成", description:"图片生成等待时间", category:"插件配置", icon:"🎨",
      getSchema:() => [{key:"maxWaitMs",label:"最大等待时间（毫秒）",type:"number",min:60_000,max:1_800_000}],
      async getValues(){return {maxWaitMs:(await store(context).read()).maxWaitMs};},
      async setValues(patch){await store(context).update(value => ({...value,
        maxWaitMs:typeof patch.maxWaitMs === "number" ? Math.max(60_000,Math.min(1_800_000,patch.maxWaitMs)) : value.maxWaitMs}));}}),
    setup:migrate,
  });
}
