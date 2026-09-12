export const htmlEscape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export type ProviderProtocol = "auto" | "chat" | "responses" | "gemini" | "anthropic";

export type CustomProvider = {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  // 旧配置中的 openai 会在读取时自动迁移为 auto。
  type?: ProviderProtocol | "openai";
};

type AIConfig = {
  providers: Record<string, CustomProvider>;
  default_provider?: string;
  aiMigrated?: boolean;
  default_prompt?: string;
  default_spoiler?: boolean;
  max_output_length?: number;
  link_preview?: boolean;
  [key: string]: unknown;
};

export const DEFAULT_PROMPT =
  '你是 Telegram 群聊摘要助手。根据以下聊天记录，只输出 Telegram HTML 格式的中文总结。\n\n允许使用 <b>、<code>、<a href="...">、<blockquote expandable>；禁止使用 Markdown、#、**、```、[文字](链接)、裸 URL、<https://...>。聊天记录中每条消息末尾都有“来源”链接。每条摘要、资源、结论、互动、零散信息或时间线条目都必须附带最对应的 Telegram 原消息链接，格式为 <a href="Telegram消息链接">来源</a>；不要编造链接。\n\n只记录聊天中明确出现的事实、反馈、决定和计划。只有存在明确完成反馈、验证结果或维护者确认时，才可使用“已确认”“已解决”“已完成”等表达；个人测试、成员讨论或推测使用“有人反馈”“初步判断”“可能”“尚待复测”“未见最终确认”等表述。不要把“计划支持”“准备测试”“正在修改”写成已经实现或可用。合并重复消息，忽略纯寒暄、表情、广告、机器人状态和无结论闲聊。\n\n总长度控制在 900-1600 个中文字符；重要讨论较多时可接近上限。信息应完整、可回溯，但不要逐条复述聊天记录。\n\n固定输出：\n<b>📌 本次摘要</b>\n用 2-3 句话概括本次聊天背景、关键结果和当前状态；末尾附 1-2 个 <a href="Telegram消息链接">来源</a>。\n\n随后按实际内容选择下列栏目，不相关的栏目完全不要输出：\n<b>💬 主要话题</b>：日常交流、综合讨论、一般观点或群内共识。\n<b>🧩 技术与项目</b>：技术方案、配置、开发、排障、版本更新、命令和实现细节。\n<b>📰 资源分享</b>：重要外部链接、文件、工具、新闻或可复用资源。\n<b>👥 重要互动</b>：明确的求助、答复、邀请、提醒、分工、争议或值得关注的人际互动。\n<b>🗂 零散信息</b>：无法归入其他栏目但值得保留的版本、环境、数据、状态、背景或简短结论。\n<b>🕒 时间线梳理</b>：仅在同一轮聊天出现多个明确时间点，且时间顺序有助于理解事件进展时输出。\n\n不要输出“待处理事项”“行动项”“下一步”这类面向管理者的栏目；群成员未必负责跟进。若聊天中存在未解决问题、风险或后续计划，将其放入最相关的上述栏目，并使用“仍待确认”“尚待复测”“计划继续”等中性表述。\n\n每个栏目使用以下格式：\n<b>栏目标题</b>\n<blockquote expandable>• 要点：说明结论、必要背景、明确分歧、风险或计划 <a href="Telegram消息链接">来源</a>\n• 要点：说明结论、必要背景、明确分歧、风险或计划 <a href="Telegram消息链接">来源</a></blockquote>\n\n规则：\n1. 每个栏目 1-3 条；每条建议 35-90 个中文字符。内容多时优先压缩重复过程，保留结论、关键依据、数据、风险和计划。\n2. 技术内容较多时，可在 <b>🧩 技术与项目</b> 内使用 <b>1. 小标题</b> 分组；最多 3 个小标题，每个小标题只保留 1-2 条。\n3. 时间线每条使用“<code>HH:MM</code>：事件概述 <a href="Telegram消息链接">来源</a>”；最多 4 条，只保留转折、决定、故障、修复或重要更新。\n4. 命令、模型名、插件名、配置名、版本号、错误码使用 <code>...</code>。\n5. 外部链接仅在确实影响后续操作时保留，格式为 <a href="完整URL">名称</a>，并在同一条末尾保留 Telegram <a href="Telegram消息链接">来源</a>。\n6. 不输出空栏目、“无”“暂无”“未发现”或处理过程。每个栏目之间空一行，只输出最终总结。';

export function promptStatus(prompt: string | undefined): string {
  if (!prompt || prompt === DEFAULT_PROMPT) return "内置详细版（来源跳转）";
  return "自定义提示词";
}

export type SummaryTask = {
  id: string;
  cron: string;
  chatId: string;
  chatDisplay?: string;
  interval: string;
  messageCount: number;
  timeRange?: number; // 时间范围（小时），如果设置则按时间范围总结
  pushTarget?: string;
  aiProvider?: string; // 提供商名称
  aiPrompt?: string;
  useSpoiler?: boolean; // 是否使用折叠
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  disabled?: boolean;
  remark?: string;
};

export type SummaryDB = {
  seq: string;
  tasks: SummaryTask[];
  aiConfig: AIConfig;
  defaultPushTarget?: string;
};

export function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export function normalizeStoredTimeout(value: unknown): number | undefined {
  const timeout = toInt(value);
  if (timeout === undefined) return undefined;
  return timeout >= 10 && timeout <= 300 ? timeout * 1000 : timeout;
}

export function timeoutToPanelSeconds(value: unknown): number | undefined {
  const timeout = normalizeStoredTimeout(value);
  return timeout === undefined ? undefined : Math.round(timeout / 1000);
}

// 构建群组链接
export function buildChatLink(chatId: string, username?: string): string {
  if (username) {
    return `https://t.me/${username}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}`;
}

// 构建消息链接
export function buildMessageLink(
  chatId: string,
  messageId: number,
  username?: string,
): string {
  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageId}`;
}

// 消息数据结构
export type MessageData = {
  text: string; // 格式化后的消息文本
  content: string; // 原始消息内容
  telegramLink: string; // Telegram 消息链接
  urls: string[]; // 消息中的所有 URL（包括 entities 中的）
};

// 从消息 entities 中提取 URL
export function extractUrlsFromEntities(message: any): string[] {
  const urls: string[] = [];

  // 从 entities 中提取
  if (message.entities && Array.isArray(message.entities)) {
    for (const entity of message.entities) {
      // TextUrl 类型：[文本](URL) 格式的链接
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        urls.push(entity.url);
      }
      // Url 类型：消息中的纯文本 URL
      if (entity.className === "MessageEntityUrl" && message.message) {
        const url = message.message.substring(
          entity.offset,
          entity.offset + entity.length,
        );
        urls.push(url);
      }
    }
  }

  return urls;
}

// 提取文本中的 URL
export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s\]）】>]+/g;
  return text.match(urlRegex) || [];
}

// 格式化消息数据为文本
export function formatMessagesForAI(messageData: MessageData[]): string {
  // 消息正文，每条消息附带 Telegram 链接
  const messageTexts = messageData.map(
    (m) => `${m.text} [来源](${m.telegramLink})`,
  );

  // 提取所有外部 URL 及其对应的 Telegram 消息链接
  // 优先使用 entities 中提取的 URL，其次使用文本中的 URL
  const urlMappings: { url: string; telegramLink: string }[] = [];
  for (const m of messageData) {
    // 合并两种来源的 URL
    const allUrls = [...m.urls, ...extractUrlsFromText(m.content)];
    for (const url of allUrls) {
      // 去重：检查是否已存在相同 URL
      if (!urlMappings.some((u) => u.url === url)) {
        urlMappings.push({ url, telegramLink: m.telegramLink });
      }
    }
  }

  let result = messageTexts.join("\n");

  if (urlMappings.length > 0) {
    result += "\n\n--- 消息中包含的外部链接（资源URL - 来源消息链接）---\n";
    for (const mapping of urlMappings) {
      result += `${mapping.url} - [查看原消息](${mapping.telegramLink})\n`;
    }
  }

  return result;
}

// 包裹折叠标签
export function wrapWithSpoiler(content: string, useSpoiler: boolean): string {
  if (!useSpoiler) {
    return content;
  }

  // 检查内容是否已经包含折叠标签
  if (content.includes("<blockquote expandable>")) {
    return content;
  }

  // 用折叠标签包裹整个内容
  return `<blockquote expandable>${content}</blockquote>`;
}
