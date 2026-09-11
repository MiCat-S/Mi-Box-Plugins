# Mi Box Plugins

## 简介
本仓库为 [MiCat-S/Mi-Box](https://github.com/MiCat-S/Mi-Box) 提供 V2 插件及迁移参考源码。

## 安装方式

插件由 MiBot 主程序加载，`ai`、`gt` 等扩展均通过 Telegram 中的 TPM 安装。
首次使用按下面的顺序操作：

1. 按 [MiBot 从零部署教程](https://github.com/MiCat-S/Mi-Box/blob/main/INSTALL.md)
   在服务器安装主程序、登录自己的 Telegram 账号并启动后台服务。
   部署时下载主仓库，插件源码由 TPM 在安装时自动获取。
2. 打开该账号的 Telegram“收藏夹”，发送 `.tpm search 翻译` 查找插件，
   也可用 `.tpm search ai` 按名称搜索。
3. 发送 `.tpm install ai gt` 安装 AI 和翻译插件。等待安装结果，再发送
   `.tpm list` 确认它们已安装，随后用 `.help ai` 和 `.help gt` 查看配置方法。

安装其他插件时，把名称换成搜索结果中的名称，例如 `.tpm install dig ip ids`。
这些命令在 Telegram 发送；服务器终端用于部署和管理主程序。

| 用途 | Telegram 命令 |
| --- | --- |
| 一次安装多个插件 | `.tpm install ai gt dig` |
| 更新全部已安装插件 | `.tpm update all` |
| 卸载插件并保留配置 | `.tpm remove dig` |
| 查看插件帮助 | `.help 插件名` |

V2 入口为各插件的 `v2.ts`；其余源码仍待迁移，不代表可以直接安装到 V2。

`ai`、`gt`、`leech`、`re`、`sure` 等扩展的实现由本仓库维护。
Core 内置功能由 Core 维护；本仓库的 `exec` 保留历史身份和说明，命令由 Core 提供。
开发者运行跨仓库测试时，将本仓库放到 Core 同级的 `TeleBox-Plugins` 目录。

## 插件源码目录
- `aban` - 高级封禁管理  
- `acron` - 定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令  
- `admin_board` - 管理员排行榜 末位淘汰  
- `aff` - 机场Aff信息管理  
- `ai` - ai聚合  
- `aitc` - AI Prompt 转写  
- `annualreport` - 年度报告  
- `atadmins` - 一键艾特全部管理员  
- `atall` - 一键艾特全部成员  
- `audio_to_voice` - 音乐转音频  
- `autochangename` - 自动定时修改用户名  
- `autodel` - 定时删除消息  
- `autodelcmd` - 自动删除命令消息  
- `autorepeat` - 智能自动复读机  
- `banana` - Nano-Banana 图像编辑  
- `bgp` - BGP路由图查询工具  
- `biko` - 批量获取整理发送指定对话中指定用户的消息  
- `bin` - 卡头检测  
- `bizhi` - 发送一张壁纸  
- `botmzt` - 随机获取写真图片  
- `bs` - 保送  
- `bulk_delete` - 批量删除消息  
- `calc` - 计算器  
- `checkapi` - API Key 全功能检测  
- `checkin` - 自动签到插件  
- `clean` - 账号清理工具 Pro  
- `clean_member` - 群组成员清理  
- `clear_sticker` - 批量删除群组内贴纸  
- `codex_image` - 通过codex调用gpt-image-2  
- `convert` - 视频转音频  
- `copy_sticker_set` - 复制贴纸包  
- `cosplay` - 获取随机cos写真  
- `crazy4` - 疯狂星期四文案  
- `cy` - 词云  
- `da` - 删除群内所有消息  
- `dbdj` - 点兵点将 - 从最近的消息中随机抽取指定人数的用户  
- `dc` - 获取实体DC  
- `deepwiki` - DeepWiki多项目聚合  
- `dig` - DNS 查询  
- `diss` - 儒雅随和版祖安语录  
- `dme` - 删除指定数量的自己发送的消息  
- `duckduckgo` - DuckDuckGo 搜索  
- `eat` - 生成带头像表情包  
- `eatgif` - 生成"吃掉"动图表情包  
- `encode` - 简单的编码解码  
- `epic` - 检查Epic Games喜加一优惠  
- `exec` - 运行命令  
- `fadian` - fadian语录  
- `fbi` - 欢迎加入联邦调查局  
- `getstickers` - 下载整个贴纸包  
- `gif` - GIF与视频转贴纸  
- `git_PR` - Git PR 管理  
- `goodnight` - 自动统计晚安/早安  
- `gt` - AI 翻译  
- `his` - 查看被回复者最近消息  
- `hitokoto` - 获取随机一言  
- `httpcat` - 发送一张http状态码主题的猫猫图片  
- `ids` - 用户信息显示以及跳转链接  
- `im` - 图片监控插件  
- `ip` - IP 地址查询  
- `isalive` - 活了么  
- `javdb` - 寻找番号封面  
- `jupai` - 举牌小人  
- `keep_online` - 保活自动重启(测试版) 请查看说明操作  
- `keyword` - 关键词自动回复  
- `kkp` - 获取NSFW视频  
- `komari` - Komari 服务器监控  
- `leech` - 归档数据库统计与 Telegram 会话检查
- `listusernames` - 列出属于自己的公开群组/频道  
- `lottery` - 抽奖  
- `lu_bs` - 鲁小迅整点报时  
- `manage_admin` - 管理管理员  
- `mode` - 自定义消息格式  
- `moyu` - 摸鱼日报  
- `music` - YouTube音乐  
- `music_bot` - 多音源音乐搜索  
- `music_hub` - 多音源音乐搜索下载插件  
- `netease` - 网易云音乐  
- `news` - 每日新闻  
- `nezha` - 哪吒监控  
- `nodeseek` - NodeSeek 论坛每日签到，领取鸡腿  
- `ntp` - NTP 时间同步  
- `openlist` - openlist管理  
- `oxost` - 回复聊天中的文件与媒体 得到一个临时的下载链接  
- `pangu` - 消息自动pangu化  
- `paolu` - 群组一键跑路  
- `parsehub` - 社交媒体链接解析助手  
- `pic_to_sticker` - 图片转表情  
- `pmcaptcha` - 简单防私聊  
- `portball` - 临时禁言  
- `premium` - 群组大会员统计  
- `qr` - QR 二维码  
- `quote` - 引用贴纸生成（本地 glass：语音/文件/音频行、视频角标、stories/image；.q help）  
- `rate` - 货币实时汇率查询与计算  
- `re` - 回复消息后重复转发
- `restore_pin` - 恢复群组被取消的置顶消息  
- `rev` - 反转你的消息  
- `save` - 突破限制保存/转发消息  
- `say` - 自动语音合成 (MiMo / 火山豆包 / Fish)，每会话独立开关  
- `search` - 频道消息搜索  
- `sendat` - 定时消息发送插件  
- `service` - systemd服务状态查看  
- `shift` - 智能消息转发系统  
- `soutu` - soutu搜图  
- `speedlink` - 对其他服务器测速  
- `speedtest` - 网络速度测试  
- `ssh` - ssh管理  
- `sticker` - 偷表情  
- `sticker_to_pic` - 表情转图片  
- `sub` - substore简单管理  
- `subinfo` - 订阅链接信息查询  
- `sum` - 群消息总结  
- `sure` - 代发用户、对话和消息白名单
- `t` - 文字转语音  
- `teletype` - 打字机效果  
- `theme` - Telegram 主题转换  
- `tmp_admin` - 临时管理员  
- `trace` - 全局追踪点赞  
- `tts` - Azure文字转语音  
- `uai` - 引用消息 AI 分析  
- `warp` - warp管理  
- `weather` - 天气查询  
- `whois` - 域名查询  
- `xmsl` - 全自动羡慕  
- `yinglish` - 淫语翻译  
- `yt-dlp` - YouTube 视频下载  
- `yvlu` - 语录贴纸：语音/文件/音频行、转发标签、管理员头衔、视频/GIF 角标；支持 webp/image/stories 输出  
- `zhijiao` - 掷筊 强随机 使用 笅杯卦辞廿七句  
- `zpr` - 二次元图片  

## 技术栈

- **开发语言**: TypeScript
- **数据库**: Lowdb
- **任务调度**: node-schedule
- **Telegram API**: Teleproto
- **图像处理**: Sharp
- **其他依赖**: axios, lodash 等
  

## 贡献指南

欢迎提交新插件或改进现有插件。请确保：
1. 遵循 TypeScript 编码规范
2. 包含完整的功能说明
3. 添加适当的错误处理
4. 更新 plugins.json 配置文件
5. 同一插件保持一处业务实现；扩展的声明、帮助、监听器及回归测试集中维护在本仓库，复用 Core 能力时通过 SDK 或服务接口调用

## 声明

本仓库的表情素材等均来自网络，如有侵权请联系作者删除

## 许可证

本项目采用开源许可证，具体请查看各插件的许可证声明。
