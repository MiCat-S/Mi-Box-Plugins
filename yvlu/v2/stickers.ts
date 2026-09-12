import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import {downloadMediaBuffer, MAX_INPUT_PIXELS} from "./media";
import {native, replyMessage, UserError} from "./runtime";

export async function saveSticker(ctx: PluginContext, message: MessageEnvelope, shortName: string): Promise<boolean> {
  if (!shortName.trim()) throw new UserError("未配置贴纸包，请使用 yvlu config sticker 贴纸包名称");
  const replied = await replyMessage(ctx, message);
  if (!replied) throw new UserError("请回复一张贴纸或图片");
  const {Api} = await import("teleproto");
  const media = replied.media;
  if (!media) throw new UserError("回复的消息不包含贴纸或图片");
  const doc = media.document;
  const sticker = doc?.attributes?.some((a: any) => a instanceof Api.DocumentAttributeSticker);
  const photo = media instanceof Api.MessageMediaPhoto;
  if (!sticker && !photo) throw new UserError("不支持的媒体类型，请回复贴纸或图片");
  const set = new Api.InputStickerSetShortName({shortName});
  let exists = false;
  try {
    const result = await native(ctx, client => client.invoke(new Api.messages.GetStickerSet({stickerset: set, hash: 0})));
    exists = result instanceof Api.messages.StickerSet;
  } catch (error) {
    ctx.signal.throwIfAborted();
    if ((error as any)?.errorMessage !== "STICKERSET_INVALID") throw error;
  }
  let document: any;
  if (sticker && doc.id && doc.accessHash) {
    document = new Api.InputDocument({id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference || Buffer.alloc(0)});
  } else if (photo) {
    const buffer = await downloadMediaBuffer(ctx, replied);
    const sharp = (await import("sharp")).default;
    const png = await sharp(buffer, {limitInputPixels: MAX_INPUT_PIXELS}).rotate().resize(512, 512, {fit: "inside"}).png().toBuffer();
    ctx.signal.throwIfAborted();
    const {CustomFile} = await import("teleproto/client/uploads.js");
    const uploaded = await native(ctx, client => client.uploadFile({file: new CustomFile("sticker.png", png.length, "", png), workers: 1}));
    // UploadMedia turns InputFile into the InputDocument required by sticker RPCs.
    const result: any = await native(ctx, client => client.invoke(new Api.messages.UploadMedia({
      peer: new Api.InputPeerSelf(), media: new Api.InputMediaUploadedDocument({file: uploaded as any, mimeType: "image/png",
        attributes: [new Api.DocumentAttributeFilename({fileName: "sticker.png"})]}),
    })));
    if (!result?.document?.id) throw new UserError("无法准备贴纸文档");
    document = new Api.InputDocument({id: result.document.id, accessHash: result.document.accessHash,
      fileReference: result.document.fileReference || Buffer.alloc(0)});
  }
  if (!document) throw new UserError("无法准备贴纸数据");
  const item = new Api.InputStickerSetItem({document, emoji: "📝"});
  if (exists) {
    await native(ctx, client => client.invoke(new Api.stickers.AddStickerToSet({stickerset: set, sticker: item})));
  } else {
    const me = await native(ctx, client => client.getMe());
    if (!me) throw new UserError("无法获取当前用户信息");
    await native(ctx, client => client.invoke(new Api.stickers.CreateStickerSet({
      userId: me as any, title: shortName, shortName, stickers: [item],
    })));
  }
  return !exists;
}
