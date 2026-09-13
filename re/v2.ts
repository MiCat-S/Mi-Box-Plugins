import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const restricted=(error:unknown):boolean=>error!==null&&typeof error==="object"&&
  Object.getOwnPropertyDescriptor(error,"errorMessage")?.value==="CHAT_FORWARDS_RESTRICTED";

export default function createRe() {
  return definePlugin({renderHelp:renderPluginHelp,apiVersion:1,id:"re",description:"复读回复的消息",
    commands:{re:{description:"回复消息后重复转发，可指定数量和次数",async handle(invocation,ctx){
      const reply=await ctx.telegram.getReply(invocation.message);
      const replied=reply?.raw as ApiTypes.Message|undefined;
      if(!reply){
        await ctx.telegram.edit(invocation.message,"你必须回复一条消息才能够进行复读");
        return;
      }
      if(!replied?.peerId){await ctx.telegram.reply(invocation.message,"无法获取被回复的消息，请重试。");return;}
      const count=Math.min(Math.max(Number.parseInt(invocation.args[0]??"")||1,1),20);
      const repeat=Math.min(Math.max(Number.parseInt(invocation.args[1]??"")||1,1),10);
      try{
        await ctx.telegram.withClient(async(client,signal)=>{
          signal.throwIfAborted();
          const {Api}=await import("teleproto");signal.throwIfAborted();
          const source=await replied.getInputChat();signal.throwIfAborted();
          const commandRaw=invocation.message.raw as ApiTypes.Message|undefined;
          const target=await commandRaw?.getInputChat();signal.throwIfAborted();
          if(!source||!target)throw new Error("peer unavailable");
          const messages=await client.getMessages(source,{offsetId:reply.id-1,limit:count,reverse:true}) as ApiTypes.Message[];
          signal.throwIfAborted();
          if(typeof commandRaw?.delete==="function"){await commandRaw.delete({revoke:true});signal.throwIfAborted();}
          if(!messages.length)return;
          const ids=messages.map(message=>message.id);
          const topic=replied.replyTo?.replyToTopId??replied.replyTo?.replyToMsgId;
          let copy=false,forwarded=0;
          for(let index=0;index<repeat;index++){
            try{
              await client.invoke(new Api.messages.ForwardMessages({fromPeer:source,id:ids,toPeer:target,...(topic?{topMsgId:topic}:{})}));
              signal.throwIfAborted();
              forwarded++;
            }catch(error){signal.throwIfAborted();if(restricted(error)){copy=true;break;}throw error;}
          }
          if(!copy)return;
          for(let index=forwarded;index<repeat;index++)for(const message of messages){
            signal.throwIfAborted();
            const options={...(topic?{replyTo:topic}:{}),...(message.entities?.length?{formattingEntities:message.entities}:{})};
            if(message.media){await client.sendFile(target,{...options,file:message.media,caption:message.message??""});signal.throwIfAborted();}
            else if(message.message){await client.sendMessage(target,{...options,message:message.message});signal.throwIfAborted();}
          }
        });
      }catch{
        ctx.signal.throwIfAborted();
        ctx.log.error("re_failed",{kind:"internal"});
        await ctx.telegram.reply(invocation.message,"发生未知错误，无法复读消息。请稍后再试。");
      }
    }}},
  });
}
