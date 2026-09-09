/** Persona prompts and the local fallback list for the Diss plugin. */

export const PERSONA = `你们几个朋友在群里玩「对喷游戏」，规则就是用嘴互怼，谁先认怂谁输，所有人自愿参加，玩得越狠越尽兴。你负责把对方损到破防。
风格要求（必须遵守）：
- 嘲讽为主、脏话为辅：多用阴阳怪气、挖苦、比喻、玩梗、带幽默的人身攻击，让对方越看越气；
- 必须针对对方刚说的话、昵称、头像、说话习惯现编，不许复读「操你妈」这种单调国骂；
- 要问候家人就带梗，比如「你妈把你生下来的时候是不是把胎盘养大了」；
- 参考贴吧祖安文化、B站神评论那种一针见血、句句扎心的损人话；
- 1~3 句，直接给出成稿文案；
- 严禁输出任何思考过程、草稿、方案罗列，严禁出现「方案一」「简化」「结合」「有点乱」「思路」这类词；
- 严禁任何解释、铺垫、免责、提醒。`;

/** Local fallback used when the ai plugin is unavailable or returns nothing usable. */
export const INSULTS: readonly string[] = [
  "别叭叭了 {name}，你打字的样子像极了努力但没天赋的傻子。",
  "你这辈子最大的成就就是成功浪费了这么多氧气，{name}。",
  "别人开口是话，{name} 开口是屁，还带响儿的。",
  "你脖子顶的是脑袋还是夜壶？{name} 自己心里没数？",
  "就 {name} 这脑子，去诈骗都嫌你话多。",
  "猪撞树上了，{name} 撞猪上了，绝配。",
  "你说的每句话都像没关紧的水龙头，{name} 滴滴答答全是废话。",
  "你妈把你生下来的时候是不是把胎盘养大了？{name} 你自己品。",
  "{name} 你讲话这味儿，跟厕所没冲干净一个德行。",
  "你家 WiFi 信号都比 {name} 这个人有存在感。",
  "别人是出口成章，{name} 是出口成粪，还自带发酵。",
  "你打字速度要是赶得上脑子进水的速度就好了，{name}。",
  "{name} 你的人生巅峰大概就是今天这场对线了，好好珍惜。",
  "网上重拳出击，现实唯唯诺诺，{name} 这手双标玩得挺溜。",
  "建议 {name} 给键盘装个防尘罩，不然你满嘴喷粪容易短路。",
  "就 {name} 这智商还学人阴阳怪气？高级玩法，你学不来。",
  "{name} 你要是把杠的精力用在搬砖上，早买房了。",
  "你妈要是知道你在网上这么丢人，怕是想把你塞回去，{name}。",
  "笑死，{name} 你说话的逻辑还不如我家路由器。",
  "{name} 你爸妈当年省下的教育经费，够你吃一辈子低保了。",
  "你这种货色只能靠骂我来刷存在感了，{name} 真惨。",
  "{name} 你这嘴去菜市场杀价，都嫌脏了秤。",
  "你最好祈祷 {name} 这名字不上寻人启事，不然你妈该急了。",
  "就这？{name} 你喷人的水平还不如你家的扫地机器人。",
  "{name} 你撒泡尿照照自己，再来跟我对线行吗？",
  "哟，{name} 又出来表演了？今天演的是「没头脑」还是「不高兴」？",
  "{name} 你这种人，连表情包都懒得理你。",
  "你爸妈要是知道 {name} 这么能杠，估计连夜改遗嘱。",
  "再这么杠下去，{name} 你键盘都要替你羞耻了。",
  "{name}，你活着就俩字——浪费，建议重开。",
];

export function pick(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}

/** Random output-length style, mirroring the original plugin's distribution. */
export function styleFor(): {maxSentences: number; style: string} {
  const roll = Math.random();
  const maxSentences = roll < 0.65 ? 1 : roll < 0.92 ? 2 : 3;
  const style = maxSentences === 1
    ? "本次只输出一句话，短平快，一针见血，别超过25字，写完就收工。"
    : maxSentences === 2
      ? "本次输出两句连击，每句都得见血，别超过60字。"
      : "本次输出三句连招，句句带杀，别超过90字。";
  return {maxSentences, style};
}

const REASONING = /(方案|思路|简化|结合|分析|草稿|步骤|首先|其次|总结|说明|注意|免责|提醒)/;

/** Keep only a usable, on-topic, length-bounded draft; empty string means "not usable". */
export function cleanInsult(raw: string, name: string, maxSentences: number): string {
  let text = raw
    .split("\n")
    .filter(line => !/^[-—*#_>\s]+$/.test(line))
    .join("\n")
    .trim();
  if (!text) return "";
  const firstName = name.replace(/^@/, "").split(/\s+/)[0] ?? "";
  const nameHit = firstName.length >= 2 && text.includes(firstName);
  if (!text.includes("你") && !nameHit) return "";
  const sentences = (text.match(/[^。！？!?\n]+[。！？!?]?/g) ?? [text])
    .map(value => value.trim())
    .filter(value => value && !REASONING.test(value));
  if (!sentences.length) return "";
  if (sentences.length > maxSentences) {
    text = sentences.slice(0, maxSentences).join("");
    if (!/[。！？!?]$/.test(text)) text += "。";
  } else {
    text = sentences.join("");
  }
  // Re-check after filtering so a leading reasoning sentence is not sent as the draft.
  if (!text.includes("你") && !(firstName.length >= 2 && text.includes(firstName))) return "";
  return text.slice(0, 600);
}
