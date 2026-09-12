export type ProviderName = "mimo" | "volc" | "fish";
export type SayConfig = {
  schemaVersion: 1;
  providers: {
    mimo: {apiKey: string; voice: string; endpoint: "standard" | "tokenplan"};
    volc: {apiKey: string; resourceId: string; voice: string};
    fish: {apiKey: string; voice: string};
  };
  primary: ProviderName;
  speed: number;
  style: string;
  translate: boolean;
  chats: Record<string, boolean>;
};

export const FISH_ROLES: Readonly<Record<string, string>> = Object.freeze({
  "薯薯":"cc1c9874effe4526883662166456513c", "麦当劳":"4066d617322e41abb30ed70eaeaf273f",
  "影视飓风":"91648d8a8d9841c5a1c54fb18e54ab04", "丁真":"54a5170264694bfc8e9ad98df7bd89c3",
  "雷军":"aebaa2305aa2452fbdc8f41eec852a79", "蔡徐坤":"e4642e5edccd4d9ab61a69e82d4f8a14",
  "邓紫棋":"3b55b3d84d2f453a98d8ca9bb24182d6", "周杰伦":"1512d05841734931bf905d0520c272b1",
  "周星驰":"faa3273e5013411199abc13d8f3d6445", "孙笑川":"e80ea225770f42f79d50aa98be3cedfc",
  "央视配音":"59cb5986671546eaa6ca8ae6f29f6d22", "阿诺":"daeda14f742f47b8ac243ccf21c62df8",
  "卢本伟":"24d524b57c5948f598e9b74c4dacc7ab", "电棍":"25d496c425d14109ba4958b6e47ea037",
  "炫狗":"b48533d37bed4ef4b9ad5b11d8b0b694", "阿梓":"c2a6125240f343498e26a9cf38db87b7",
  "七海":"a7725771e0974eb5a9b044ba357f6e13", "嘉然":"1d11381f42b54487b895486f69fb14fb",
  "东雪莲":"7af4d620be1c4c6686132f21940d51c5", "永雏塔菲":"e1cfccf59a1c4492b5f51c7c62a8abd2",
  "可莉":"626bb6d3f3364c9cbc3aa6a67300a664", "刻晴":"5611bf78886a4a9998f56538c4ec7d8c",
  "烧姐姐":"60d377ebaae44829ad4425033b94fdea", "AD学姐":"7f92f8afb8ec43bf81429cc1c9199cb1",
  "御姐":"f44181a3d6d444beae284ad585a1af37", "台湾女":"e855dc04a51f48549b484e41c4d4d4cc",
  "御女茉莉":"6ce7ea8ada884bf3889fa7c7fb206691", "真实女声":"c189c7cff21c400ba67592406202a3a0",
  "女大学生":"5c353fdb312f4888836a9a5680099ef0", "温情女学生":"a1417155aa234890aab4a18686d12849",
  "蒋介石":"918a8277663d476b95e2c4867da0f6a6", "李云龙":"2e576989a8f94e888bf218de90f8c19a",
  "姜文":"ee58439a2e354525bd8fa79380418f4d", "黑手":"f7561ff309bd4040a59f1e600f4f4338",
  "马保国":"794ed17659b243f69cfe6838b03fd31a", "罗永浩":"9cc8e9b9d9ed471a82144300b608bf7f",
  "祁同伟":"4729cb883a58431996b998f2fca7f38b", "郭继承":"ecf03a0cf954498ca0005c472ce7b141",
  "麦克阿瑟":"405736979e244634914add64e37290b0", "营销号":"9d2a825024ce4156a16ba3ff799c4554",
  "蜡笔小新":"60b9a847ba6e485fa8abbde1b9470bc4", "奶龙":"3d1cb00d75184099992ddbaf0fdd7387",
  "懒羊羊":"131c6b3a889543139680d8b3aa26b98d", "剑魔":"ffb55be33cbb4af19b07e9a0ef64dab1",
  "小明剑魔":"a9372068ed0740b48326cf9a74d7496a", "唐僧":"0fb04af381e845e49450762bc941508c",
  "孙悟空":"8d96d5525334476aa67677fb43059dc5", "王琨":"4f201abba2574feeae11e5ebf737859e",
  "麦辣鸡腿堡":"c293697468924f3089cd9b90520dbc16", "猪八戒":"4313e3ec56f14eb3946630dbdad01059",
  "夏(中配) 蔚蓝档案":"c5fca4f670214e3cb7fbb9d595552e6e", "蔚蓝档案阿洛娜":"6ec8168d8392467c82358a780b35c5ca",
  "蔚蓝档案星野":"057265ac020c41a9a91d57c747d3b4c",
});

export const DEFAULT_CONFIG: SayConfig = {
  schemaVersion: 1,
  providers: {
    mimo: {apiKey: "", voice: "冰糖", endpoint: "standard"},
    volc: {apiKey: "", resourceId: "seed-tts-2.0", voice: ""},
    fish: {apiKey: "", voice: FISH_ROLES["雷军"]!},
  },
  primary: "mimo", speed: 1, style: "", translate: true, chats: {},
};

const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;

export function normalizeConfig(value: any): SayConfig {
  const source = value && typeof value === "object" ? value : {};
  const providers = source.providers && typeof source.providers === "object" ? source.providers : {};
  const speed = Number(source.speed);
  return {
    ...source,
    schemaVersion: 1,
    providers: {
      mimo: {apiKey: text(providers.mimo?.apiKey), voice: text(providers.mimo?.voice, "冰糖").slice(0, 80),
        endpoint: providers.mimo?.endpoint === "tokenplan" ? "tokenplan" : "standard"},
      volc: {apiKey: text(providers.volc?.apiKey ?? providers.volc?.token),
        resourceId: text(providers.volc?.resourceId, "seed-tts-2.0").slice(0, 80), voice: text(providers.volc?.voice).slice(0, 120)},
      fish: {apiKey: text(providers.fish?.apiKey), voice: text(providers.fish?.voice, FISH_ROLES["雷军"]).slice(0, 128)},
    },
    primary: source.primary === "volc" || source.primary === "fish" ? source.primary : "mimo",
    speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1,
    style: text(source.style).slice(0, 500), translate: typeof source.translate === "boolean" ? source.translate : true,
    chats: source.chats && typeof source.chats === "object" && !Array.isArray(source.chats)
      ? Object.fromEntries(Object.entries(source.chats).filter(([key, enabled]) => /^-?[0-9]+$/.test(key) && enabled === true)) : {},
  };
}

export function configured(config: SayConfig, provider: ProviderName): boolean {
  return Boolean(config.providers[provider].apiKey);
}

export function providerOrder(config: SayConfig): ProviderName[] {
  return [config.primary, ...(["volc", "mimo", "fish"] as ProviderName[]).filter(value => value !== config.primary)]
    .filter(value => configured(config, value));
}

export function fishVoiceLabel(value: string): string {
  return (Object.entries(FISH_ROLES).find(([, id]) => id === value)?.[0] ?? value) || "未设";
}
