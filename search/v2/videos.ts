import type {TelegramClient} from "teleproto";

export const normalize=(text:string)=>text.toLowerCase().replace(/[-_\s.|\\/#]+/g," ").replace(/\s+/g," ").trim();
export const fileName=(message:any):string=>message?.video?.attributes?.find((a:any)=>a.className==="DocumentAttributeFilename")?.fileName||"";
export const duration=(message:any):number=>Number(message?.video?.attributes?.find((a:any)=>a.className==="DocumentAttributeVideo")?.duration||0);
function fuzzyMatch(text:string,query:string){
  if(text.includes(query))return true;
  const queryParts=query.split(" ").filter(part=>part.length>0),textParts=text.split(" ");
  if(queryParts.length===1&&/[a-z]+\s*\d+/i.test(query)){
    if(text.replace(/\s+/g,"").includes(query.replace(/\s+/g,"")))return true;
  }
  return queryParts.every(queryPart=>textParts.some(textPart=>textPart.includes(queryPart)));
}
export function matches(message:any,query:string){
  const normalizedQuery=normalize(query);
  return [message.text,message.message,fileName(message)].some(source=>source&&fuzzyMatch(normalize(source),normalizedQuery));
}
export function score(message:any,query:string){
  const normalizedQuery=normalize(query);
  return (fileName(message)&&normalize(fileName(message)).includes(normalizedQuery)?100:0)+
    (message.message&&normalize(message.message).includes(normalizedQuery)?50:0);
}

export async function channelVideos(client:TelegramClient,entity:any,linkedGroup:string|undefined,query:string,type:"search"|"kkp",
  isAd:(message:any)=>boolean,processedGroupIds:Set<string>,signal:AbortSignal):Promise<any[]>{
  const {Api}=await import("teleproto");
  const read=async(peer:any,options:any)=>{
    signal.throwIfAborted();
    const messages=await client.getMessages(peer,options);
    signal.throwIfAborted();
    return messages;
  };
  const pureVideo=(message:any)=>message.video&&message.media?.className!=="MessageMediaWebPage"&&!isAd(message);
  const videos:any[]=[];
  if(type==="kkp"){
    const messages=await read(entity,{limit:entity.className==="Channel"&&entity.megagroup===true?200:100,filter:new Api.InputMessagesFilterVideo()});
    return messages.filter(message=>pureVideo(message)&&duration(message)>=20&&duration(message)<=180);
  }
  if(linkedGroup){
    try{
      const linked=await client.getEntity(linkedGroup);
      const groupMessages=await read(linked,{limit:100,search:query});
      const linkedVideos:any[]=[];
      for(const text of groupMessages){
        if(matches(text,query)&&text.replies){
          const comments=await read(linked,{limit:100,replyTo:text.id});
          const found=comments.filter(pureVideo);
          if(found.length){linkedVideos.push(...found);break;}
        }
      }
      if(!linkedVideos.length){
        const found=await read(linked,{limit:100,search:query,filter:new Api.InputMessagesFilterVideo()});
        linkedVideos.push(...found.filter(pureVideo));
      }
      videos.push(...linkedVideos);
    }catch{signal.throwIfAborted();}
  }
  const found=await read(entity,{limit:200,search:query});
  for(const message of found){
    if(!matches(message,query))continue;
    if(message.groupedId){
      const id=String(message.groupedId);
      if(processedGroupIds.has(id))continue;
      const surrounding=await read(entity,{limit:20,offsetId:message.id+10});
      const album=surrounding.filter(item=>item.groupedId&&String(item.groupedId)===id);
      const found=album.filter(item=>item.video&&!isAd(item));
      if(found.length){videos.push(...found);processedGroupIds.add(id);}
    }else if(message.video&&!isAd(message))videos.push(message);
  }
  return videos;
}
