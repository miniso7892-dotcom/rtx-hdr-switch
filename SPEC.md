# RTX HDR 开关：Chrome/Edge MV3 扩展设计规格

## 背景与已验证事实（2026-10，Chrome 155 / Chromium 155，NVIDIA 驱动 617.42，Windows HDR 开）

- NVIDIA「RTX 视频增强」的 HDR（TrueHDR）和超分（VSR）在 NVIDIA App 里全局开启。Chrome 只在视频被提升为 DirectComposition overlay/underlay 时才调用 NVIDIA 视频处理器（`ui/gl/swap_chain_presenter.cc` 的 `VideoProcessorBlt`）。
- 用 FP16 桌面抓取实测了以下结果（RTX HDR 生效时白色约 1000 nit，不生效时等于 Windows「SDR 内容亮度」对应的 SDR 白）：
  - 在 `<video>` 元素自身加内联 `filter: brightness(1)` → 白色降到 SDR 白，即该视频的 RTX 关闭。窗口和 `video.requestFullscreen()` 全屏都有效。去掉后立即恢复到约 1000 nit，不需要刷新页面，开和关两个方向都实时生效。
  - `opacity:0.999` 和 `transform: rotate(0.01deg)` 同样能关闭；`border-radius:1px`、在视频角上叠一个小 div 都不能关闭。
  - 源码依据：filter 会让 Blink 创建 render surface（`property_tree_manager.cc` 的 `kFilter`）。视频 quad 进入非根 render pass 后不会被 DC overlay 处理，因此 VSR 和 TrueHDR **一起**关闭。页面层面没有办法只关其中一个。
- 机制定为：关闭时在 video 元素上设置内联 `style.setProperty('filter', 'brightness(0.9999)', 'important')`。对 8 bit 画面没有可见变化，又避免将来 Chromium 把恒等滤镜优化掉。开启时恢复页面原有的内联 filter 值（先保存，再还原）。必须加在 video 元素本身，不能加在祖先元素上（全屏 top layer 的原因）。
- 画面亮度采样：MSE（blob:）视频绘制到 canvas 不会被污染；跨源且无 CORS 的视频会让 canvas 被污染，`getImageData` 抛 SecurityError，要捕获并标记为 unknown；EME/DRM 视频读出来是全黑，用 `video.mediaKeys !== null` 识别并跳过。DRM 视频走 MediaFoundation overlay，CSS 控制不了，要在 UI 里标明「受版权保护的视频无法控制」。
- `chrome.commands`：最多 4 个建议快捷键，必须带 Ctrl 或 Alt，不能用 Ctrl+Alt；默认只在浏览器有焦点时生效。Google Chrome 稳定版会忽略 `--load-extension`，用户必须手动「加载已解压的扩展程序」。

## 目标用户需求

用户喜欢 HDR 的高亮度，但白底、纯白的视频不适合，长时间看也伤眼。需要：

- 针对某个具体视频选择是否开启 RTX HDR；
- 快捷键；
- 记住选择；
- 自动处理白底视频；
- 护眼功能。

界面用简体中文（1.2 起中英双语，见文末「1.2」一节；1.3 的新功能见文末「1.3」一节）。

## 文件结构（仓库根目录）

- `manifest.json`
- `background.js`：service worker，经典脚本，不用 module
- `lib.js`：纯逻辑。浏览器端作为内容脚本先于 content.js 注入；Node 端用 `if (typeof module !== 'undefined') module.exports = ...` 导出以便测试。不得引用 `chrome` 或 `document`。
- `content.js`：内容脚本
- `popup.html` / `popup.css` / `popup.js`
- `icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`：用 Python Pillow 生成（`tools/make_icons.py [--accent #RRGGBB]`）。1.2 起是 C 风格图标：黑色圆角方块里一块左白右黑的「屏幕」，中间一道主题色分割线；运行时由 `icon-draw.js` 按主题色重画。
- `test/lib.test.js`：用 `node:assert` 写，`node test/lib.test.js` 直接运行，不依赖第三方包。
- `README.md`（英文）/ `README.zh-CN.md`（中文）：安装与使用说明，两者互相链接。
- `LICENSE`：MIT。

## manifest.json 要点（1.3.0）

- `manifest_version: 3`，`name: "__MSG_extName__"`（英文「HDR Switch for RTX Video」：商店安全的名字，不以第三方商标开头；界面里的显示名仍是「RTX HDR 开关」），`version: "1.3.0"`，`default_locale: "en"`，名称、说明和快捷键说明走 `_locales/en`、`_locales/zh_CN`，`homepage_url` 指向 GitHub 仓库，`minimum_chrome_version: "120"`（`chrome.alarms` 30 秒周期）。`key` 固定扩展 ID 为 `omgekmljdifpghaimigdbbbcmnjddmdd`。
- `permissions: ["storage", "scripting", "nativeMessaging", "alarms"]`，`host_permissions: ["<all_urls>"]`。1.3 去掉了 `tabs`：`<all_urls>` 已经能读到 `tab.url`。
- `content_scripts`：
  - `matches ["<all_urls>"]`，`js ["i18n.js","lib.js","content.js"]`；
  - `all_frames: true`，`match_about_blank: true`，`match_origin_as_fallback: true`；
  - `run_at: "document_start"`。
- `background.service_worker: "background.js"`；`action.default_popup: "popup.html"`；`options_ui: {page: "options.html", open_in_tab: true}`；配置 icons。
- `web_accessible_resources`：只有 `panel.html`，`use_dynamic_url: true`，`matches` 由 `lib.js` 的 `PLAYER_HOSTS` 生成（只含播放器网站的 `https://<host>/*`，见「1.3」一节）。
- `commands`（Chrome 最多 4 个建议快捷键，已用满；其余命令不设 `suggested_key`，用户自己分配）：

  | 命令 | 建议键 | 说明 |
  |---|---|---|
  | `toggle-hdr` | `Alt+H` | 切换当前视频的 RTX HDR |
  | `toggle-auto` | `Alt+Shift+H` | 开启或关闭白底视频自动检测 |
  | `nv-mg-up` / `nv-mg-down` | `Alt+Shift+Up` / `Alt+Shift+Down` | NVIDIA 中间灰 +5 / −5 |
  | `forget-video` | 无 | 清除当前视频的记忆 |
  | `nv-next-preset` | 无 | 切换到下一个 NVIDIA 预设 |
  | `peek` | 无 | 临时对比 HDR 和 SDR（1.3） |
  | `next-profile` | 无 | 切换到下一个配置档（1.3） |
  | `nv-undo` | 无 | 撤销上一次 NVIDIA 修改（1.3） |

  （修订：1.0 为 `version: "1.0.0"`、`permissions` 含 `tabs`、只有 `toggle-hdr`、`toggle-auto`、`forget-video` 三个命令、`minimum_chrome_version: "116"`。）

## 决策模型（全部在 lib.js 里实现，可测试）

每个视频的有效决策 `decide(ctx)` 返回 `{state: 'on'|'off', reason}`。按以下优先级取第一个命中的：

1. `manual`：本页面会话里对这个视频元素手动切换过（不论是否保存）。
2. `video`：已保存的按视频规则（`storage.local` 键 `v:<key>`，值 `{s:'on'|'off', t:时间戳}`）。
3. `site`：网站规则（`settings.sites[hostname]` 为 `'on'`/`'off'`，hostname 去掉 `www.` 再比较）。视频在 iframe 里时先看顶层页面的域名（弹窗「本网站」编辑的就是它），没有再看 iframe 自己的域名。
4. `night`：夜间护眼时段生效（`settings.night.enabled` 且当前时间在 `[start,end)` 内，支持跨午夜，例如 23:00–07:00）时为 off。
5. `auto`：自动检测判定当前视频为「亮/白底」时为 off（细节见下文）。
6. `default`：`settings.defaultState`（默认 `'on'`）。

`reason` 的中文显示：手动 / 已记住此视频 / 网站规则 / 夜间护眼 / 自动检测(白底) / 默认。

## 视频 key（lib.js 的 `videoKey(url)`）

| 网站 | URL 形式 | key |
|---|---|---|
| YouTube | `watch?v=ID`、`/shorts/ID`、`/live/ID`、`/embed/ID`、`youtu.be/ID`、`music.youtube.com/watch?v=ID` | `yt:ID` |
| YouTube 频道直播嵌入 | `/embed/live_stream?channel=<id>`（没有 channel 参数时走兜底） | `yt:live:<id>` |
| Bilibili | `/video/BVxxx`（带 `?p=N`，默认 1） | `bili:BVxxx:pN` |
| Bilibili | `/video/avN` | `bili:av:N` |
| Bilibili | `/bangumi/play/epN` | `bili:ep:N` |
| Bilibili | `/bangumi/play/ssN` | `bili:ss:N` |
| Bilibili 直播 | `live.bilibili.com/<room>` | `blive:<room>` |
| Bilibili 嵌入播放器 | `player.bilibili.com/player.html?bvid=..&p=..` | 与 `/video/` 同格式 |
| 腾讯视频 | `v.qq.com/x/cover/<cid>/<vid>.html` | `qq:<vid>` |
| 腾讯视频 | `v.qq.com/x/cover/<cid>.html` | `qq:<cid>` |
| 腾讯视频 | `v.qq.com/x/page/<vid>.html` | `qq:<vid>` |
| 爱奇艺 | `iqiyi.com/v_<id>.html` | `iqiyi:<id>` |
| Twitch | `twitch.tv/videos/<id>` | `twitch:v:<id>` |
| Twitch 剪辑 | `twitch.tv/<channel>/clip/<slug>`、`clips.twitch.tv/<slug>`、`clips.twitch.tv/embed?clip=<slug>` | `twitch:clip:<slug>` |
| Twitch | `twitch.tv/<channel>` | `twitch:<channel>` |
| 其他 | — | `u:` + `origin + pathname` + 去掉 `utm_*`/`spm*`/`from`/`share*`/`vd_source`/`t`/`si`/`feature` 等跟踪参数并排序后的 query |

## 自动检测（lib.js 的纯函数 + content.js 的采样）

**采样（content.js）：**
- 主视频在播放、页面可见、自动检测未关闭，并且更高优先级的规则（manual/video/site/night）都没有命中时，每 1500 ms 采样一次。
- 用 `OffscreenCanvas(64,36)`（`willReadFrequently:true`）执行 `drawImage(video)` 再 `getImageData`。
- `analyzeFrame(rgbaArray)` 返回：
  - `mean`：平均亮度，0–1，按 Rec.709 权重；
  - `white`：亮度 > 0.85 的像素占比；
  - `black`：亮度 < 0.03 的像素占比。
- 全黑帧（`black > 0.98`）不计入。DRM 视频（`mediaKeys`）和被污染的 canvas 标记为 unknown 并停止采样。

**判定状态机（lib.js 的 `createAutoDetector(sensitivity, mode)`，带 `update(sample, nowMs)` 方法）：**
- 灵敏度阈值：

  | 灵敏度 | white | mean |
  |---|---|---|
  | low | ≥ 0.45 | ≥ 0.70 |
  | medium（默认） | ≥ 0.30 | ≥ 0.62 |
  | high | ≥ 0.20 | ≥ 0.55 |

- 满足任一阈值即为「亮帧」。连续 3 个亮帧 → 判定为 bright，状态变为 off。
- `mode === 'disable'`（默认，「只自动关闭」）：一旦判定为 bright，在这个视频（同一个 key）的本次页面会话内保持 off。
- `mode === 'both'`（「自动开关」）：需要连续 6 个「暗帧」（white < 阈值×0.6 且 mean < 阈值×0.85）才恢复 on；任何一次自动切换后至少保持 10 秒不再切换。
- `mode === 'off'`：不检测。
- 视频 key 变化或重新 loadstart 时重置检测器的计数。但 content.js 按 key 记住本页面会话内「已判定为 bright」的结论：同一 key 重新 loadstart（例如 YouTube 中插广告→正片）、页面换了 video 元素、在弹窗改灵敏度或模式而重建检测器时，检测器直接以 off 开始（`createAutoDetector(sensitivity, mode, 'off')`），不会先回到 HDR 再等 3 帧。`both` 模式恢复 on 时清除这个记录。
  （修订：原文「loadstart 时重置检测器」与上一条「同一 key 本次会话保持 off」矛盾，会造成每次中插广告都闪一次满亮度白屏。）
- 采样定时器启动时立即先采一帧（距上次采样不足 1500 ms 时不补），不必等第一个间隔。

## 护眼

- **夜间时段**：见决策第 4 条。默认 `enabled:false`，`start:'23:00'`，`end:'07:00'`。
- **连续观看提醒**：`settings.eye.minutes`，默认 45，0 表示关闭。累计「主视频在播放且 HDR 没被阻止」的时间（暂停、隐藏或 off 都不计；DRM 视频扩展阻止不了，按 on 计）。**跨视频、跨标签页、跨整页导航累计**：内容脚本只在本地攒增量（`eyeHdr`：在播放且 HDR 开的毫秒数；`eyeWatch`：主视频在播放的毫秒数，不论 HDR 开关），随 report 交给 background；background 用 `lib.eyeUpdate` 累计（多个 frame 同时上报时按实际经过时间封顶），状态存 `storage.session` 的 `eye`。**停止观看（没有任何主视频在播放）超过 5 分钟才清零**，切换视频不清零。
  - 达到设定值后 background 在该 report 的回复里带 `remind`，由发报告的内容脚本在视频上显示 OSD，持续 6 秒：没开 autoOff 时为「已连续观看 HDR N 分钟，休息一下眼睛吧」；开了 autoOff 时为「已连续观看 HDR N 分钟，已切回 SDR，休息一下眼睛吧（按 <快捷键> 可恢复 HDR）」（没有快捷键时为「可在扩展弹窗里恢复 HDR」）。
  - 如果 `settings.eye.autoOff` 为 true，进入「护眼 SDR」：background 写 `storage.local` 的 `eyeRest: {on:true, at}`，所有内容脚本把**主视频**切到 off，reason 为 `eye`，中文「护眼提醒」，优先级等同 manual（在它之后的手动切换优先）但不保存。护眼 SDR 对之后的视频（下一个视频、新标签页）同样有效，直到：停止观看超过 5 分钟；用户手动切回 HDR（内容脚本删除 `eyeRest`）；在弹窗关掉 autoOff 或把分钟数设为 0。
  - 提醒后计时清零重新开始。
  （修订：原文按页面实例计时、视频 key 变化时清零护眼计时并清除护眼造成的 off，导致自动连播、分 P、每个视频都短于设定值时永远不提醒，护眼 SDR 在下一个视频就失效。）

## content.js 行为

- **避免重复注入**：用 `window.__rtxHdrSwitchLoaded` 防止重复执行。扩展重新加载后新实例在新的 isolated world 里看不到这个属性，因此新实例启动时在 document 上派发 `rtxhdrswitch-takeover` 事件（DOM 事件跨 world），已失效的旧实例收到后停止工作且不还原视频样式；每个实例在 video 上写 `data-rtxhdr-owner=<随机标记>`，失效实例只还原仍归自己管的视频。旧实例发现自己失效（`runtime.id` 为空）时先等 5 秒，没有新实例接管（扩展被停用/卸载）再还原。
- **发现视频**：
  - `document.querySelectorAll('video')`，加上递归遍历 open shadowRoot（有 `chrome.dom.openOrClosedShadowRoot` 时用它）；
  - 用 MutationObserver 监听 document 的子树新增；每 2 秒再兜底扫描一次；
  - 每个视频监听 `play`/`playing`/`pause`/`loadstart`/`emptied`/`loadedmetadata`/`resize`。
- **主视频**：可见（与视口相交面积 > 0）、未暂停、`readyState >= 2` 的视频里面积最大的；都没有在播放时，取可见面积最大的。
  - 子 frame 里另用 IntersectionObserver（隐式根 = 顶层视口，含父页面的滚动和裁剪）观察每个 video，可见面积取两者较小值，避免折叠区外的 iframe 广告被当成主视频。
  - 画中画中的视频（`document.pictureInPictureElement`，沿 shadow 树找到真正的元素）直接作为主视频；report 带 `pip:true`，弹窗提示「画中画窗口里无法关闭 HDR，回到页面内播放后生效」。
  - 每个视频都按决策应用状态（同一页面上其他视频也按 site/default 等规则处理），但手动切换、自动检测、护眼提醒只作用于主视频。
- **应用状态**：
  - off：保存原内联 filter（`dataset.rtxhdrOrigFilter`、优先级 `dataset.rtxhdrOrigImportant`），然后 `style.setProperty('filter', lib.offFilterFor(原值), 'important')`：原值为空/`none`/关键字/含 `var()` 时就是 `brightness(0.9999)`，否则叠加成 `原值 brightness(0.9999)`，保留页面自己的滤镜效果（任何 filter 都会让视频离开 overlay）；浏览器不接受叠加值时退回单独的 `brightness(0.9999)`。设 `dataset.rtxhdr='off'`。
  - on：只有当前 filter 以我们的 `brightness(0.9999)` 结尾（`lib.isOffFilter`）且为 important 时才还原原值，设 `dataset.rtxhdr='on'`。
  - 页面改写 style 时用 MutationObserver 监听 video 的 style 属性，立刻重新应用（回调在下一次绘制前执行，逐帧改 style 的播放器也不闪）。同一元素 20 ms 内被改回超过 6 次（页面在反向监听、互相触发）或 1 秒超过 120 次时让步，标记 contested：不再重新应用，report 的 state 为实际生效的 `on`、reason 为 `contested`（「页面不断改写视频样式，无法关闭」），主视频显示一次 OSD；10 秒后重试，失败次数越多间隔越长（最长约 5 分钟）；用户手动切换时立即重试。
  - **DRM 视频**（`video.mediaKeys` 不为空）：不加滤镜（CSS 管不了），不显示状态 OSD；report 带 `drm:true`、state 为 `on`、reason 为 `drm`。
  - （修订：原文 off 时整条替换页面的内联 filter、DRM 视频照常应用状态、反复让步与每秒重新应用互相打架。）
- **URL 变化**：每秒轮询 `location.href`；监听 `yt-navigate-finish` 和 navigation API 的 `navigatesuccess`（如果有）。视频 key 绑定在「元素 + 当前媒体」上：每个元素记住取得 key 时的 key 和 `currentSrc`。key 变化时，对每个元素：清除 manual、重置检测器，归到新 key，然后重新决策；**例外**：新 key 是兜底的 `u:`（跳到了首页、目录等非视频页）而元素原来的 key 是站点视频 key、且仍在播放同一个 `currentSrc` 时（YouTube 小窗、Twitch 迷你播放器），保留原 key 及其手动状态、记忆和自动检测结果。元素 loadstart 时按当前页面 key 重新归属。护眼计时不因 key 变化清零（见「护眼」）。
  （修订：原文 key 变化时把页面上所有 video 都改归新 key，小窗里继续播放的视频会静默回到 HDR，在小窗里按快捷键还会把规则存到首页的 key 上。）
- **离开页面**：`pagehide` 时（已经报告过的 frame）发一条 `{type:'report', bye:true, hasVideo:false}`；`prerenderingchange` 时重新报告一次。
- **OSD 提示**：
  - 一个 `position:fixed`、`pointer-events:none`、高 z-index 的小标签，显示在主视频矩形的左上角内侧 16px 处。
  - 内容例如「RTX HDR：开（手动）」/「RTX HDR：关（检测到白底）」，1.6 秒后移除（1.3 起不用透明度过渡，见「1.3」一节的 overlay 约束）。
  - 全屏时 append 到真正的全屏元素：`document.fullscreenElement` 会被重定向到 shadow host，要沿各级 shadowRoot 的 `fullscreenElement` 往下找；找到的元素自己挂着 shadow root（Web Components 播放器）时 append 到它的 shadow root。它是 video 本身时 append 到 documentElement，并承认看不到。不全屏时 append 到 `document.documentElement`。
  - **不得**使用 backdrop-filter，也不得给 OSD 或视频祖先加 filter。`settings.osd` 为 false 时不显示（护眼提醒除外）。
- **消息**：
  - 向 background 发 `{type:'report', ...}`，内容包括：是否有视频、视频总数、是否有视频只是不在视口里（`offscreen`）、主视频面积、是否在播放、state（实际生效的状态）、reason、key、hostname、是否 DRM、是否画中画、是否 contested、自动检测最近的 mean/white、当前帧是否全屏、护眼增量 `eyeHdr`/`eyeWatch`。在状态变化时发送，以及每 3 秒发一次心跳。回复里可能带护眼提醒 `remind`。
  - 接收：`{type:'command', command:'toggle-hdr'|'toggle-auto'|'forget-video'|'peek'}`、`{type:'get-state'}`（同步返回完整状态）、`{type:'set-state', state:'on'|'off'|'clear'}`；1.3 另有 `{type:'osd', text, warn}`（background 的提示）和 `{type:'fs-hint', on}`（父页面把本 frame 设为全屏，见「1.3」一节）。
- **toggle-hdr**：主视频状态翻转，记为 manual。如果 `settings.rememberManual`（默认 true）就保存 `v:<key>`。显示 OSD。没有视频时显示 OSD「当前页面没有可控制的视频」（如果没有视频矩形，就把 OSD 放在视口左上角）。
- **toggle-auto**：在 `'off'` 和 `settings.autoLastMode`（默认 `'disable'`）之间切换 `settings.autoDetect`，显示 OSD。（修订：1.3 起由 background 的 `settingsTxn` 执行，内容脚本只发 `settings-patch` 的 `op:'toggle-auto'`，不再自己写 settings。）
- **forget-video**：删除 `v:<key>`，清除 manual，重新决策，显示 OSD「已清除此视频的记忆」。
- 监听 `storage.onChanged` 后重新决策（设置是在弹窗里改的）。
- 性能：没有视频时不启动采样定时器；`document.hidden` 时停止采样。

## background.js

- 每个 tab 保存 frameId → report，放在 `chrome.storage.session`（service worker 会被回收），同时用内存缓存。
- 报告的清理（修订：原文只在整页导航时按时间清子 frame，SPA 移除 iframe 后旧报告会永远留着）：
  - `sender.documentLifecycle` 不是 `active` 的报告（预渲染、往返缓存、正在卸载的旧文档）不记录。
  - 顶层 frame 的文档换了（`sender.documentId` 变化；没有 documentId 时用 report 里的 `timeOrigin`）：删除该 tab 所有子 frame 的报告，新页面里有视频的 iframe 会在 3 秒内通过心跳重新上报。
  - `bye` 报告：删除该子 frame 的报告（顶层 frame 记为没有视频）；只处理与记录中 documentId 相同的文档发来的。
  - 选最佳 frame 时忽略 10 秒没有消息的子 frame（`pickBestFrame(frames, now, staleMs, childMaxAgeMs)`）；最佳 frame 是子 frame 时安排一次到期复查，iframe 悄悄消失时角标会自己更新。60 秒没有消息的子 frame 报告直接删除。
- 选最佳 frame：有视频，并且在播放的优先，再按面积大的优先。
- 根据最佳 frame 设置角标：on 显示「HDR」绿色 `#2e7d32`，off 显示「SDR」灰色 `#616161`，DRM 视频显示「DRM」深黄色 `#8d6e00`（扩展管不了，不显示 HDR/SDR），没有视频清空。白色文字用 `setBadgeTextColor`。角标「HDR」的含义是「扩展没有阻止 RTX HDR」，实际是否生效以 NVIDIA App 为准。
- 连续观看提醒的累计、`remind` 回复和 `eyeRest` 标记的维护见「护眼」；监听 `storage.onChanged` 同步设置和 `eyeRest`。
- `chrome.commands.onCommand(command, tab)`：tab 缺失时查当前活动 tab。发给最佳 frame（`{frameId}`）；没有报告时发给 frameId 0。`sendMessage` 失败要捕获，比如 chrome:// 页面。
- `onInstalled`：给所有已打开的 http/https tab 执行 `scripting.executeScript({target:{tabId, allFrames:true}, files:['lib.js','content.js']})`，失败要捕获；写入默认设置（不覆盖已有设置）。
- `tabs.onRemoved` 时清理；`webNavigation` 不使用。
- 弹窗通过 `{type:'popup-get', tabId}` 向 background 取最佳 frameId，然后直接用 `chrome.tabs.sendMessage(tabId, msg, {frameId})` 跟内容脚本通信。

## 设置（chrome.storage.local `settings`，lib.js 提供 DEFAULT_SETTINGS 和 mergeSettings）

1.3.0 的默认值（`mergeSettings(undefined)` 与它深相等，测试保证）：

```
{ defaultState:'on',            // 'on' | 'off' | 'fullscreen'（1.3）
  fullscreenWeb:true,           // 网页全屏也算全屏（1.3）
  rememberManual:true, autoDetect:'disable', autoLastMode:'disable', sensitivity:'medium',
  night:{enabled:false,start:'23:00',end:'07:00'}, eye:{minutes:45,autoOff:false}, osd:true,
  playerButton:true,            // 1.2
  playerPanel:'hover',          // 'hover' | 'right' | 'off'（1.3）
  hdrOnly:false,                // 1.2
  updateCheck:true,             // 1.3，只对解压安装生效
  sites:{},                     // host → 'on' | 'off' | 'fullscreen'（1.3 加 fullscreen）
  ui:{lang:'auto',accent:'#A98BFF'},
  nv:{presets:[], nightPresetId:null, dayPresetId:null, followSdr:false, displayId:null,
      sitePresets:{}} }         // sitePresets：host → 预设 id，最多 200 条（1.3）
```

1.3 起 `settings` 只由 background 写（见「1.3」一节的「设置写入方」）。

按视频的规则单独存成 `v:<key>` 条目。超过 2000 条时，按时间删除最旧的（在 lib.js 里写纯函数 `pruneKeys(entries, max)`，content 或 background 写入时调用）。

## 弹窗（1.0 / 1.1 版，宽约 340px；1.2 起的改版见文末「1.2」一节）

1. **标题**：「RTX HDR 开关」，小字说明「关闭时该视频的 RTX 超分也会一起关闭（Chrome 限制）」。
2. **当前视频卡片**：
   - 状态大字「HDR 开」/「HDR 关」，下面一行显示原因；
   - 一个大按钮「切换」，以及「清除此视频记忆」按钮；
   - 显示 key（小字、等宽、可截断），以及自动检测的最近亮度（例如「画面亮度 72%，白色占比 41%」）；
   - 没有视频时显示「此页面没有检测到视频」（有 video 元素但都没在显示时为「此页面没有检测到正在显示的视频」，有视频只是滚出了视口时为「视频不在可见区域内」）；DRM 视频显示「受版权保护的视频，无法控制」；chrome:// 页面显示「此页面无法使用」。
   - `aria-live` 只放在状态大字和原因上（不放在每秒变化的亮度行上），并且只在文字真的变化时才写 DOM。
3. **本网站**：下拉框「跟随规则 / 总是开 HDR / 总是关 HDR」，写入 `settings.sites`。
4. **自动检测白底/高亮视频**：下拉框「关闭 / 只自动关闭（推荐）/ 自动开关」+ 灵敏度「低 / 中 / 高」。
5. **夜间护眼**：开关 + 开始/结束时间（`input type=time`）。
6. **连续观看提醒**：分钟数（0 = 关闭）+ 复选框「到时自动切回 SDR」。
7. **默认（没有任何规则时）**：开 / 关。
8. **其他**：复选框「手动切换后记住此视频」「显示屏幕提示」。
9. **快捷键区**：用 `chrome.commands.getAll()` 列出当前绑定。按钮「修改快捷键」用 `chrome.tabs.create` 打开 `chrome://extensions/shortcuts`；Edge 打开 `edge://extensions/shortcuts`（用 `navigator.userAgent` 判断 Edg/）。

弹窗每 1 秒刷新一次当前视频状态。

## 测试要求

- `node --check` 检查所有 js。
- `node test/lib.test.js` 覆盖：
  - `videoKey` 各站点 URL 和兜底；
  - `decide` 的优先级（每一级）；
  - 夜间时段跨午夜和不跨午夜；
  - `analyzeFrame`；
  - 自动检测状态机（disable 粘滞、both 的恢复与 10 秒最短保持、全黑帧忽略、灵敏度、以 off 状态重建）；
  - 关闭用滤镜的叠加与识别（`offFilterFor` / `isOffFilter`）；
  - 护眼累计（跨视频累计、停看 5 分钟清零、多 frame 不重复累计、护眼 SDR 的开始与结束）；
  - `pickBestFrame` 忽略过期子 frame；
  - `mergeSettings` 对缺失或旧字段的处理；
  - `pruneKeys`。
- `manifest.json` 必须是合法 JSON，并且引用的文件都存在。

## 1.2：界面改版与新功能（2026-10-21）

**界面（C 方案：高反差信号）**：黑白两色加一个主题色；数字用 Anton，界面拉丁字母用 Archivo（`fonts/`，OFL，只含 latin 子集），中文用系统的微软雅黑。弹窗 360×600，分「视频 / NVIDIA / 规则」三个页签，前两个页签不用滚动（Chrome 弹窗最高 600px）。跟随系统深浅色；深色下 SDR 状态块用深灰，不用大块亮白。

**中英双语**：`i18n.js`（纯数据 + `t(lang, key, params)`、`resolve(setting, uiLanguage)`）在弹窗、选项页、内容脚本、service worker 里都先于 `lib.js` 加载。设置 `ui.lang`：`auto`（浏览器界面语言以 zh 开头时中文，否则英文）/ `zh` / `en`，弹窗右上角切换后立即生效。`lib.js` 的文字函数（`reasonText`、`osdText`、`nvErrorText` 等）多一个 `lang` 参数，省略时是中文，和旧输出一致。扩展名称、说明和快捷键说明走 `_locales`（`default_locale: en`）。测试保证两种语言的键一一对应、占位符一致，页面和脚本里用到的键都存在。

**主题色**：`ui.accent`，6 个预设（荧光绿 #C8FF2E、明黄 #FFE600、信号橙 #FF7A1A、霓虹粉 #FF5CA8、电光青 #22E1FF、薰衣紫 #A98BFF，默认薰衣紫）加自定义。`accentInk(hex)` 按相对亮度在黑字和白字里选对比度更高的（分界约 0.18），主题色太暗时放在黑底上的文字改用白色。弹窗用 CSS 变量；工具栏图标由 `icon-draw.js`（OffscreenCanvas）重画后 `action.setIcon`（浏览器启动、安装和换色时）；角标 HDR 用主题色，SDR 黑底白字，DRM 灰底白字；屏幕提示是黑底白字加一个主题色小方块。

**读取 Windows SDR 亮度，一键同步**：本地组件 `display` 命令（user32 `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo`，只读）给出每台显示器的 SDR 白电平。建议值（`nvSuggest`）：中间灰 = SDR 白 × 0.2158（sRGB 128/255 的线性亮度，让 RTX HDR 的 50% 灰和桌面上的一样亮），夹到 10..100；最高亮度 = min(显卡上限, 1000)（驱动实测输出到约 1000 尼特为止）；对比度 +25（实测伽马约 2.18，接近 Windows 显示 SDR 内容的曲线）；不碰饱和度。「跟随 SDR 亮度」（`nv.followSdr`）：白电平和上次调中间灰时（`nvLastSdrWhite`）不一样才调，弹窗开着时每 2 秒看一次，关着时 background 的 `nv-follow` alarm 每 30 秒看一次（所以 `minimum_chrome_version` 提到 120）。

**中间灰快捷键**：`nv-mg-up` / `nv-mg-down`（建议 `Alt+Shift+Up` / `Alt+Shift+Down`），读当前值 ±5 夹到 10..100 再写，到头只提示。四个建议快捷键正好用满 Chrome 的上限。

**只关 HDR，保留超分（`hdrOnly`）**：实测页面层面没有办法只关某个视频的 HDR（`dynamic-range-limit` 对 overlay 路径无效；`swap_chain_presenter.cc` 里 auto HDR 只看片源是否 SDR、显示器是否 HDR、驱动、是否用电池），但播放中切换 NVIDIA 全局 HDR 开关（0x318 enabled 位）0.1–0.3 秒内生效、超分不受影响、白色正好落到 SDR 白（实测 996.5 → 480.2 尼特，和页面自身的白一致）。所以这个模式下：
- 内容脚本只在 background 借开关时看的那个 frame 里，不给想关的主视频加滤镜（视频仍走 overlay，超分保留），只照常上报决策；内容脚本从报告的回复里得知自己的 `tabId` / `frameId`。其他窗口、其他 frame 里想关的视频照常加滤镜，全局 HDR 开着时它们也真的是 SDR（`lib.js` 的 `hdrOnlyApplies`）；
- background 看当前窗口的当前标签页：主视频想关（不是 DRM）就通过常驻的 `connectNative` 端口向本地组件 `hdrLease on:true` 借用全局开关，否则 `on:false` 还回去并断开端口；
- 本地组件在端口断开（浏览器退出或崩溃、扩展重载）时自己把开关恢复；
- 用户在弹窗里亲手改全局 HDR 时，弹窗让 background `hdrLease on:false, restore:false` 放手，这个视频不再借；
- 状态写在 `storage.local` 的 `hdrOnlyStatus`（`{active, leased, tabId, frameId, error?}`）：`active` 为真、`tabId` / `frameId` 是自己时内容脚本才不加滤镜；本地组件不支持（没有 `caps: hdrLease`）或借用失败时 `active` 为假，退回逐视频滤镜，60 秒后再试。
- 代价写在界面上：关的是全局 HDR，同时播放的其他视频也会变成 SDR。

**备份**：选项页 `options.html`（文件选择框会关掉弹窗，所以放在单独的页面）。导出 `{format:'rtx-hdr-switch-backup', version:1, exportedAt, extensionVersion, settings, videos}`，只含设置和按视频的记忆；导入前 `validateBackup` 检查格式和版本、按 `mergeSettings` 规范化、视频记忆超过 2000 条只留最新的，显示摘要，确认后覆盖。

**全局关闭提示**：本地组件已连接、NVIDIA 全局 HDR 关着（且不是「只关 HDR」在借用）时，视频页签顶部提示并给「开启」按钮；HDR 出错（Windows 没开 HDR 等）时显示原因。

**播放器控制栏按钮（`playerButton`，默认开）**：在网站自己的控制栏里放一个 HDR 按钮，点击 = 对这个视频按一次 `Alt+H`。每个 frame 最多一个，放在主视频所在播放器的控制栏里。
- 网站按视频所在 frame 自己的完整域名判断（`lib.js` 的 `playerSite(hostname, pathname)`；1.3 加了 B 站直播、YouTube 嵌入和爱奇艺，见「1.3」一节）：`www.bilibili.com`、`bilibili.com`、`player.bilibili.com`；`www.youtube.com`、`youtube.com`，`/embed/` 除外（嵌入播放器是另一套移动端样式的控制栏，没有 `.ytp-right-controls`）；`www.twitch.tv`、`twitch.tv`；`v.qq.com`。B 站直播（控制区鼠标移出就删掉、移入再重建，class 带 svelte 哈希）、爱奇艺（class 名每次构建都变，只在贴片广告时见过）和其他网站不加。
- 选择器只写在 `content.js` 的 `PLAYER_BARS` 里：从主视频往上找播放器（`root`，在 `skip` 里的悬停预览不算），在播放器里找控制栏右侧（`bars`，取第一个找得到的），插在控制栏里含有 `before` 之一的那个直接子元素前面（依次找）：

| 网站 | root | 控制栏 | 插在前面 |
|---|---|---|---|
| B 站 | `.bpx-player-container`（跳过 `.v-recommend-inline-player`） | `.bpx-player-control-bottom-right` | `.bpx-player-ctrl-setting` → `-pip` → `-full`（外链播放器没有前两个） |
| YouTube | `#movie_player`（跳过 `#inline-preview-player`） | delhi：`.ytp-chrome-bottom .ytp-right-controls-left`（和字幕、设置同一个圆角框）；旧版：`.ytp-right-controls` | `.ytp-subtitles-button` → `.ytp-settings-button` |
| Twitch | `.video-player` | `.player-controls__right-control-group` | 包着 `[data-a-target="player-settings-button"]` 的那一层 |
| 腾讯视频 | `#player-component, .txp_player` | `.txp_right_controls` | `.txp_btn_pip` → `.txp_btn_fake` → `.txp_btn_fullscreen` |

- 照原生按钮的结构和 class 造按钮，大小、悬停、全屏变大、键盘焦点框都来自网站自己的 CSS（不写死尺寸）：B 站 `div.bpx-player-ctrl-btn[role=button][tabindex=0] > .bpx-player-ctrl-btn-icon > span.bpx-common-svg-icon > svg`；YouTube `<button class="ytp-button">`；Twitch 的 class 名每次构建都变，运行时照设置按钮抄 class 和外面两层；腾讯 `div.txp_btn > svg.txp_icon + div.txp_tooltip`。
- 图标：白色「HDR」徽标，开是实心徽标、字母镂空，关是描边徽标加斜杠；画在 24×24 上，用 `createElementNS` 拼路径和 mask（YouTube 页面有 Trusted Types），不用 `<text>` 和字体，不用主题色。原生图标的 viewBox 更大时（YouTube 旧版 36、腾讯 28）居中放，和原生图标一样大。
- 状态取主视频的实际生效状态（`info.eff`，和报告给角标的是同一个值；「只关 HDR」借全局开关时视频没加滤镜，按钮照样显示关）：开 `aria-pressed="true"`，关 `aria-pressed="false"`；DRM 视频 `aria-disabled="true"`、变暗、提示 `player.drm`，点了不动。文字是 `player.on/off/drm`，跟界面语言。evaluate() 末尾同步，状态或语言变了才写 DOM。
- 提示：B 站和 YouTube 的提示由它们自己的脚本统一管理，插进来的按钮没有，所以自己画一个（B 站放在按钮里，YouTube 挂在 `#movie_player` 上，全屏时也在全屏元素里；样式照原生，不用 backdrop-filter）；腾讯用它自己的 `.txp_tooltip`；Twitch 用 `title`（1.3 改为自绘提示）。
- 交互：mousedown 时 preventDefault（不抢焦点，网站快捷键照常）；不拦截控制栏里 click 的冒泡（实测不会暂停视频）；回车 = 点击（1.3 改为松开时切换，按住为对比）；空格留给播放器（`<button>` 松开空格时自己点的那一下不算）。
- 稳健性：所有回调包在 guard 里，不外抛异常。播放器或锚点还没出现时每 500 ms 再找，15 秒后放弃，等下一次导航（`yt-navigate-finish`、`yt-player-updated`、`popstate`、`navigatesuccess`、`pageshow`）或主视频换了再找。B 站实测控制栏先出现、原生按钮后填进来：锚点没出现时先等 3 秒，还没有才加在最后，锚点出现后挪过去；每次放置最多挪 3 次，别的扩展插在按钮和锚点之间不算错位，不来回抢。按钮被网站删掉（控制栏重建）时，在已有的 document 观察者里顺带看一眼 `isConnected`，下一帧重新放；网站 10 秒内从同一个控制栏删掉 8 次就停手。不新增 document 级的观察者，自己插入的节点不扫描视频。每秒的 tick、导航事件、fullscreenchange 也会重新检查。B 站小窗（`data-screen="mini"`）用一条样式规则隐藏。
- 扩展重新加载：按钮、提示、样式都带 `rtxhdr-player-btn` class 和 `data-rtxhdr-owner=<实例标记>`；失效的旧实例收到 `rtxhdrswitch-takeover` 后 destroy 删掉自己的，新实例放按钮前再删掉别的实例留下的。destroy 时按钮一起删掉。
- 「规则」里的「在播放器控制栏显示 HDR 按钮」改了立即生效：关掉时删掉按钮，打开时从头找。

测试：`node test/lib.test.js`（i18n、主题色、建议值、备份、manifest 与 `_locales`、`playerSite`）；service worker 逻辑和真实本地组件的端到端在开发时用一次性的 headless Chrome（CDP `Extensions.loadUnpacked`）验证。控制栏按钮在开发时用照各网站结构和 CSS 做的本地页面（`--host-resolver-rules` 把真实域名指过去）逐项验证（位置、和原生按钮一样大、点击 / 回车 / 空格、重建后重新放、开关设置、切换语言、DRM、扩展重新加载后不重复），再以游客身份在真实网站上看一遍。

## 1.3：播放器面板、观看功能、配置档与诊断（2026-10-22）

### 架构决定

1. 播放器内的设置面板做成扩展 iframe（`panel.html`），不在网页里画 DOM：它是跨源的扩展页面，网页脚本读不到它，也合成不了它里面的可信事件。面板和内容脚本之间用 `chrome.tabs.connect` 端口通信，不用 `postMessage`（实验发现会把扩展 ID 暴露给网页）。
2. `settings` 和 `profiles` 只由 background 写：`settingsTxn` 串行读、改、写，其他页面和内容脚本通过 `settings-patch` 消息提交补丁。结构测试保证 background 以外的 js 不对这两个键调用 `storage.local.set`。
3. 所有非拖动的 NVIDIA 写入都经 background 的 `nvWrite`：快捷键、时段、跟随 SDR、配置档、网站预设、撤销、套用预设、全局 HDR 开关。它们共用一个常驻的本地组件端口和一把互斥锁（`nvTxn`），每次写入都进修改记录。弹窗和面板拖滑块仍走各自的本地组件端口（低延迟），提交后补发 `nv-log`。
4. 「只关 HDR」借用期间保存或比较，一律用借用前的开关值（`nvUnleased`；`hdrLease` 回复里的 `prevEnabled` 存进 `hdrOnlyStatus`）。这同时修掉了 1.2 里借用期间保存的预设会带上 `enabled:false` 的问题。
5. 不新增权限，去掉 `tabs`。更新检查只对解压安装运行，`chrome.management.getSelf()` 不需要 `management` 权限。
6. 本地组件 1.3 不改：仍是 1.2.1、协议 1。扩展按 hello 的 `caps` 判断功能（`nvHostCheck`，需要 `display` 和 `hdrLease`），旧组件在诊断页提示重新运行 `install.cmd`。

### 决策优先级（`L.decide`，修订）

| # | reason | 来源 | 作用范围 | 持久 |
|---|---|---|---|---|
| 1 | `manual` / `eye` | 本页面的手动切换；护眼 SDR 以 manual 身份传入 | 这个视频 | `v:*`（rememberManual 开时）/ 不存 |
| 2 | `tab` | 本标签页沿用（内容脚本内存里的 `tabSticky`） | 这个文档里之后的视频 | 不存，刷新或整页导航后失效 |
| 3 | `video` | `v:<key>` | key | 存 |
| 4 | `site` | `sites[顶层域名]`，没有再看 frame 自己的域名；值为 `on` / `off` / `fullscreen` | 网站 | settings |
| 5 | `night` | 夜间时段 → 关 | | |
| 6 | `auto` | 白底检测 → 关 | 主视频 | |
| 7 | `default` / `fullscreen` | `defaultState` 为 on / off 时 reason 是 `default`；为 `fullscreen` 时状态等于「主视频是否全屏」，reason 是 `fullscreen` | | settings |

- 网站规则 `fullscreen` 的状态同样等于是否全屏，reason 仍是 `site`，和 on / off 一样压过夜间。默认级的「仅全屏」排在夜间和白底检测之后：这两条是保护性规则，全屏看白底视频反而最刺眼。
- 白底检测在 reason 为 `default` 或 `fullscreen` 且状态为 on 时采样。
- `reasonText`：本标签页沿用 / 仅全屏；英文 kept for this tab / fullscreen only。

### 按住对比

- 控制栏按钮：主指针按下 300 ms 内松开 = 单击切换（不变）；按满 300 ms（`L.PEEK_HOLD_MS`，`L.createHoldGesture`）主视频临时变成相反状态，左上角显示紧凑提示「对比：SDR」或「对比：HDR」（不受 `settings.osd` 控制）。松开、`pointercancel`、`lostpointercapture`、页面隐藏、按钮被移除、主视频或 key 变了、决策状态变了都立即恢复；跟在按住之后的那个 click 吞掉。安全上限 30 s（`PEEK_MAX_MS`）。
- 回车（按钮有键盘焦点）：keydown 只开始计时，300 ms 前松开 = 切换，按满 = 对比，松开恢复。（修订：1.2 的「回车 = 点击」改为松开时切换。）空格不参与，仍是播放器的播放 / 暂停（YouTube 按住空格是 2 倍速）。
- 命令 `peek`（不设建议键）：对比 5 s（`PEEK_CMD_MS`）；对比中再按一次立即恢复；开始后 500 ms 内重复到达的命令忽略（按键自动重复）。
- 面板里的「按住对比」：按下立即开始，松开、面板收起、端口断开时结束。
- 不变量：对比期间不调用 `setManual`，不写 `v:*`，不动护眼计时；`info.eff` 仍是决策状态，所以报告、角标、「只关 HDR」借用和护眼计时都不受影响。按钮图标跟显示状态走，`aria-pressed` 仍按决策状态。
- 拒绝对比、只给提示的情况：没有视频、DRM、决策为关但页面在抢样式（contested）、决策为关且「只关 HDR」对本 frame 生效（全局 HDR 已被借走，没有 HDR 可比，提示 `content.peekHdrOnly`）。
- 网站自己的长按不会被触发：e2e 里按住 0.8 s 时 `playbackRate` 保持 1。

### 只在全屏时开启 HDR

- `isFullscreenFor(v)` 只对主视频求值：
  1. 有全屏元素（沿各级 shadowRoot 找真正的全屏元素）时，看它是否包含视频（YouTube 的全屏元素是 `<html>`，也成立）；
  2. 没有全屏元素、不是顶层 frame、收到了 `fs-hint`、本 frame 视口不小于屏幕面积的 1/4 时，算全屏（1/4 防止「退出」通知丢失时小尺寸嵌入一直被当成全屏）；
  3. `settings.fullscreenWeb` 开着、`PLAYER_BARS[site].webFull` 存在且 `v.closest(webFull)` 命中时算全屏（网页全屏）。B 站：`.bpx-player-container[data-screen="web"]`；B 站直播：`body.player-full-win`（「网页模式」，顶层直播间实测，`/blanc/` iframe 形态没测）；
  4. 画中画和浏览器 F11 全屏都不算。
- 父页面把 iframe 设为全屏：顶层 frame 的报告带 `fsFrame`（有全屏元素、它不包含顶层自己的主视频，并且它本身是 iframe 或里面有占视口一半以上的 iframe）。background 用 `L.fsHintTarget` 选出目标子 frame（某个新鲜的子 frame 自己报告了全屏时不选），变化时 `tabs.sendMessage(tabId, {type:'fs-hint', on}, {frameId})` 通知旧目标 off、新目标 on；报告回复里另带 `topFs` 作为兜底（心跳 3 s）。只转发顶层到它的子 frame，更深的嵌套不支持。
- 报告里的 `fullscreen` 改为「本 frame 的全屏元素包含主视频」。
- 「只关 HDR」开着时，每次进出全屏都会借或还一次全局开关。rememberManual 开着时手动切换会写视频记忆，之后压过「仅全屏」。

### 本标签页沿用

- `tabSticky = {state, at}` 是内容脚本的模块变量，跟着当前文档：单页应用的连播、分 P、播放列表都保留；刷新、整页导航、关闭后失效。每个 frame 各一份。
- 入口一，屏幕提示上的提议：上一次手动切换是另一个 key、同一个状态、当前没有沿用时（`L.tabOffer`），这次的提示变成可点的「本标签页后续视频沿用」，显示 4 s；宿主元素临时 `pointer-events:auto`，对 pointerdown、mousedown、mouseup、click、dblclick、contextmenu 调用 `stopPropagation`，按钮只认 `isTrusted` 的点击。`settings.osd` 关闭时不提议。
- 入口二：面板「本视频」页签的复选框。
- 沿用期间主视频上的手动切换同时更新沿用的状态。清除记忆（弹窗、快捷键、`set-state clear`）一并取消沿用。由沿用决定的新视频每个 key 显示一次提示。自动沿用不写 `v:*`。

### 播放器面板

**触发（`settings.playerPanel`）**

| 模式 | 打开 | 收起 |
|---|---|---|
| `hover`（默认） | 可信的 `pointerenter` 时预载 iframe，停 350 ms 打开（临时态）；触屏的点按不算 | 指针离开按钮和面板 400 ms 后；拖滑块、按住对比期间不收 |
| `right` | 右键：`contextmenu` 上 `preventDefault` 加 `stopPropagation`，网站的右键菜单不出现，打开为固定态 | 见下 |
| `off` | 不打开，键盘方式也不响应 | |

- `hover` 和 `right` 模式下，按钮有键盘焦点时 ArrowUp 或 Shift+Enter 打开为固定态，焦点进面板的第一个控件。面板里有过可信操作后也变成固定态。
- 固定态只在这些情况收起：Esc、点击面板外（只收起，不拦事件）、Tab 移出、播放器 root 变了、全屏后看不到、B 站切到小窗、页面隐藏、被遮挡。Esc 和 Tab 收起时焦点还给按钮。
- 左键单击和回车始终是切换，面板保持打开并即时更新；从按钮开始对比时面板先收起。
- 收起只切换 `visibility`，iframe 保留 60 s 再销毁；预载了却没打开的同样 60 s 后销毁。面板的本地组件端口在收起 20 s 后断开。网站把播放器挪到别的容器导致 iframe 重新加载时，打开着的面板就地重建（10 s 内最多 3 次）。B 站直播的控制区被删掉时，打开着的面板留着，控制区重建后接回新按钮。

**布局**：宽 320（播放器窄于 336 时为播放器宽减 16，下限 260），放在按钮正上方居中、左右各留 8 px（YouTube 嵌入放在按钮正下方），高度取面板上报的值，放不下时面板内部滚动；播放器小于 260×160 时不打开，按钮只做开关。三个页签：本视频（开启 HDR / 关闭 HDR / 跟随规则、本标签页后续视频沿用、按住对比、本网站规则四段、白底检测、灵敏度）、NVIDIA（全局 HDR 开关、四个滑块、超分 6 段、GPU 优先级、预设标签、还原到打开时）、配置档（列表点一下就套用、保存当前为配置档、撤销切换）。界面按「让布局自己说话」：每个控件或分组一个短标签，不加说明行。面板里不用原生 `<select>`（下拉列表画在 iframe 外面）。「完整设置」先试 `action.openPopup()`，不行就在新标签页打开 `popup.html?tab=<标签页 id>`，弹窗按那个标签页显示。

**挂载与握手**

- 内容脚本在播放器 root 里插入空白 iframe（YouTube 嵌入的控制层盖在播放器上，挂到 body），再 `contentWindow.location.replace(runtime.getURL('panel.html') + '#f=<本 frame id>&n=<nonce>')`。地址不写进 `src` 属性：网页读得到属性，读得到就能自己嵌一份；跨源导航之后网页读不到 iframe 的地址。nonce 是 16 字节随机数。
- 面板加载后先发 `{type:'panel-claim', nonce}` 向 background 认领自己：background 从 sender 得知这个 iframe 的 frameId（扩展页面和内容脚本都拿不到它）。同一个 nonce 被两个 frame 认领（地址泄漏）时谁都不登记；认领 30 s 内有效。
- 面板用 `tabs.getCurrent()` 拿到标签页、用 hash 里的 frame id 连回内容脚本（端口名 `rtxhdr-panel`），第一条消息是带 nonce 的 `hello`。内容脚本只认本扩展 `/panel.html` 发起的端口、每个面板只认第一个端口、10 s 内没有正确的 hello 就拆掉面板。
- 握手成功后内容脚本发 `{type:'panel-frame', op:'add', nonce}`，background 把 nonce 认领的 frameId 登记为面板（存 `storage.session` 的 `panelFrames`，每个标签页最多 8 个，扛得过 service worker 回收）。面板显示时 `op:'open'` 启用、收起时 `op:'close'` 停用、销毁时 `op:'remove'` 注销。`panel-frame` 只接受播放器网站上的内容脚本发来的。
- background 的 `fromExtensionPage` 把 `/panel.html` 认作扩展页面 `panel` 的条件：`sender.id` 是本扩展、协议是 `chrome-extension:`（`use_dynamic_url` 下主机名是动态的）、所在 (tabId, frameId) 已登记且处于启用状态、文档是活动的。其他扩展页面（popup、options、diag）带 tab 时必须是顶层 frame。
- 面板只在播放器网页里的 iframe 中工作：顶层打开，或 `location.ancestorOrigins[0]` 的域名不在 `PLAYER_HOSTS` 里时什么都不显示。

**协议**

| 方向 | 消息 | 含义 |
|---|---|---|
| 面板 → 内容 | `hello {nonce}` | 握手 |
| 内容 → 面板 | `init {state, topHost, site, trigger}` | 握手和登记成功后发送 |
| 内容 → 面板 | `state {state}` | `panelSnapshot()`：hasVideo、drm、state、reason、manual、saved、tab、peek、hdrOnly、eyeRest、pip、topHostname；签名变了才推送，不轮询 |
| 内容 → 面板 | `open {via, focus}` / `close` | 显示和收起；面板收到 `open` 之前不发任何写入 |
| 面板 → 内容 | `size {h}` | 面板内 ResizeObserver 报告的高度 |
| 面板 → 内容 | `video {op:'on'\|'off'\|'clear'}` | 作用于按钮所在播放器的视频；`clear` 即跟随规则，清除这个视频的记忆；DRM 视频忽略 |
| 面板 → 内容 | `tab {on}`、`peek {on}`、`pin`、`hold {on}`、`hover {on}`、`activity {x, y}`、`close {reason}` | 沿用、对比、固定、拖动中不收起、指针在面板上、唤醒网站控制栏（节流 500 ms，只派发 mousemove）、收起 |

- 内容脚本发给面板的只有 `init`、`state`、`open`、`close`，面板不会因为它们写任何东西。`size` 以外的面板消息只在面板显示着时处理。
- 面板对 background：设置用 `settings-patch`（只能改 `L.contentPatchAllowed` 放行的字段，另可改顶层网站那一条 `nv.sitePresets`）；全局 HDR 开关（`mode:'suppress'`）、套用预设、还原到打开时（`mode:'yield'`）走 `nv-op`；`nv` 桥只开放 `hello` / `get`；配置档只开放 `list` / `apply` / `next` / `undo` / `save`；拖滑块用面板自己的本地组件端口，提交后发 `nv-log`。面板的写入（`list` 除外）和内容脚本的 `settings-patch` 共用每个标签页每秒 10 次的上限。
- 面板 NVIDIA 页签只在显示时每 2 s 拉一次状态。「还原到打开时」用 `L.nvRevertPatch` 只写有差异的字段，两边都用借用前的开关值。

**安全**

- 按钮的点击、键盘、悬停、右键处理和面板里的每个写操作都检查 `isTrusted`；面板只在显示着时接受操作（收起后焦点还留在面板里时的按键不算，界面撤回原样）。
- 面板收起时不保留键盘焦点（网站快捷键会被吞掉，方向键会改到看不见的控件）。
- 点击劫持：iframe 的内联样式全部带 `!important`（`all:initial`、不透明、无 filter / transform / clip-path / transition），每次求值时写回；打开期间检查 `checkVisibility`、祖先链的透明度乘积不低于 0.9、祖先没有 filter 和 mask、面板中心和四角 5 个点 `elementFromPoint` 命中 iframe，连续两次不通过就收起。IntersectionObserver v2 在 Twitch（整块透明遮罩）和腾讯视频上误判，播放器网站本身不用它。
- 播放器嵌在第三方网页里（`ancestorOrigins` 里有不是播放器网站的）时，第三方网页把嵌入播放器改透明或盖住，内容脚本看不到：面板用 IntersectionObserver v2（`trackVisibility`）的 `isVisible` 给写入把关，不可用时一律不写。
- 网页自己嵌的面板副本拿不到 nonce，连不上内容脚本，也认领不了，什么都不显示。
- 探测：`use_dynamic_url`，WAR 只对播放器网站开放，静态 ID 的地址被拒；iframe 只在悬停后到销毁之间存在。

**overlay 约束**：面板文档和 iframe 元素上都不用 `backdrop-filter`、`filter`、`opacity` 过渡或 `transform`；显示和隐藏只切换 `visibility`；不改视频和它祖先的样式。屏幕提示、对比提示、按钮提示同样遵守（结构测试扫描 content.js 和 panel.css）。面板盖在视频上时 RTX HDR 是否仍生效，需要在 HDR 显示器上用有界面的浏览器实测（hdrcap，未遮挡区域的白块亮度不低于基线的 0.9 倍），headless 测不出来。

### 新增网站（`PLAYER_BARS` 和 `PLAYER_HOSTS`）

| 网站 | 域名（`playerSite`） | root | 控制栏 | 插在前面 | 说明 |
|---|---|---|---|---|---|
| B 站直播 | `live.bilibili.com` | `#live-player` | `.control-area .right-area` | `.quality-wrap` → `.ext-nodes` | 控制区移出就删、移入重建（class 带 svelte 哈希）：`rebuild: '#web-player-controller-wrap-el'`，在已有观察者里看到它下面有新增节点就重新放；10 s 内最多插 20 次。顶层和 `/blanc/` iframe 两种形态都验证过 |
| YouTube 嵌入 | `www.youtube.com`、`youtube.com`、`www.youtube-nocookie.com`、`youtube-nocookie.com` 的 `/embed/` | `#movie_player` | `#player-controls .player-controls-top-right`（`scope: 'doc'`，控制栏不在播放器里） | `.player-settings-icon` | 移动版控制栏，提示用 `title`（和原生静音、字幕按钮一样）；面板放在按钮下方、挂在 body 上。网站规则按顶层页面的域名 |
| 爱奇艺 | `www.iqiyi.com` | `#container1MainContent` | `[class*="defaultController_playCtrl__"] > #right` | `settingBtn` → `voice` → `mini`（`data-xplayer-control-key`） | class 带构建哈希，只用前缀和 data 属性；按钮结构运行时照原生按钮抄；自绘提示照原生样式，不用它的 backdrop-filter |

- `PLAYER_BARS` 条目新增字段：`scope`（`'doc'` 时在整个文档里找控制栏）、`rebuild`、`webFull`、`hideIn`（B 站小窗规则迁到这里）、`tipGap(btnRect)`、`panelZ`、`panelBelow`。
- Twitch 不再用 `title`，改为照原生提示画的自绘提示（`TIP_CSS_TWITCH`，白底黑字带小三角），挂在 `.video-player` 里；React 重渲染拿掉提示后再次聚焦时挂回去。
- `manifest.json` 的 WAR `matches` 和测试都由 `PLAYER_HOSTS` 派生。

### 设置写入方

- `settingsTxn(mutator)`：读最新值 → mutator → `mergeSettings` → 和原值不同才写，排队执行。使用方：`settings-patch` 消息、`initSettings`、配置档套用和撤销、备份导入、`toggle-auto`。
- `settings-patch {patch}` 或 `{op:'toggle-auto'}`：
  - 扩展页面（popup、options、diag）能改任何字段；
  - 播放器 frame 里的内容脚本和登记过的面板只能改 `autoDetect`、`autoLastMode`、`sensitivity`、`playerButton`、`playerPanel`、`sites[顶层域名]`（on / off / fullscreen / null），面板另可改 `nv.sitePresets[顶层域名]`；出现别的字段整单拒绝（`L.contentPatchAllowed`）；每个标签页每秒最多 10 次；没登记的 `panel.html` 一律拒绝；
  - 弹窗用 `L.settingsPatchFor(prev, next)` 生成最小补丁，防抖期间合并（`mergeSettingsPatch`）；收到 onChanged 时用 `applySettingsPatch(新值, 还没发出的补丁)` 渲染，刚输入的值不被覆盖。
- MV3 里 `storage.local` 无法禁止内容脚本直接写：白名单保证的是正确，不是安全边界。

### NVIDIA 写入服务与修改记录

- `hostCall(msg)`：background 共用一个常驻本地组件端口，请求按 id 匹配回复。没有借用、15 s 内也没有请求时断开（service worker 才能休眠）；`connectNative` 抛错或连续 3 次退出时改用一次一个进程的 `sendNativeMessage`。
- `nvWrite({source, label, patch | build(st), lease:'yield'|'suppress'})`：get → 生成补丁（自动来源过 `nvAutoGuard`）→ `nvPatchDelta` 去掉和实时值相同的字段（全同则不写不记）→ `nvLeaseAdjust` 处理借用（`suppress`：用户亲手拨 HDR 开关，只要在借就放手，并不再借这个视频；`yield`：enabled 等于借用前的值时去掉 enabled，否则放手后写、写完重新评估）→ `nvValidatePatch` → set → 记日志。永远不 reject。
- 来源（`NV_SOURCES`）：popup、panel、hotkey、schedule、follow、profile、site、lease、undo。
- 修改记录：`storage.session` 的 `nvLog`，环形 100 条，记录前后值（`nvStateDiff`，只比较可写字段）、来源、是否成功、是否可撤销。借和还只在真的变了时记，不可撤销。弹窗和面板端口上的写入由页面补发 `nv-log`；页面关闭时还在途的提交记为 unconfirmed，不可撤销。
- 撤销：`nvUndoTarget` 取最近一条成功、可撤销、没撤销过、不是 undo 或 lease、1 小时内的记录；`nvUndoPatch` 只撤销实时值仍等于当时写入值的字段（之后又被改过的跳过并说明），peak 夹到实时范围，HDR 出错时去掉 hdr 部分。连按逐条往前撤销。入口：命令 `nv-undo`、弹窗 NVIDIA 页签修改后 10 s 内的「上一次：…（来源）撤销」、`nv-op undo`。
- 行为变化：跟随 SDR 开着时，自动来源（时段、网站预设）不再写中间灰；用户来源照写，白电平下次变化时跟随再接管。

**NVIDIA 参数的优先级**（哪个视频开或关仍由 `decide` 决定）

| 来源 | 触发 | 优先级 | 与「只关 HDR」借用 | 与跟随 SDR | 记录 / 撤销 |
|---|---|---|---|---|---|
| 手动：弹窗、面板、中间灰快捷键、套用预设、下一个预设、撤销 | 用户操作 | 1 | HDR 开关 suppress，其余 yield | 照常写中间灰 | 记录，可撤销 |
| 配置档：套用、命令、撤销 | 用户操作 | 1 | yield | 照常写 | 记录，可撤销；另有 10 分钟整体撤销 |
| 网站绑定的预设 | 焦点窗口活动标签页的主视频在绑定网站上播放 | 2 | yield | 跟随开着时不写中间灰 | 记录，可撤销 |
| 时段（夜间 / 其余时间） | 进入新时段 | 3 | yield | 跟随开着时不写中间灰 | 记录，可撤销 |
| 跟随 SDR | Windows SDR 白电平变化 | 事件驱动，只写中间灰 | 不涉及 | | 记录，可撤销 |
| 「只关 HDR」借用 | 主视频想关 | 不参与，只临时改 enabled | | | 记录，不可撤销 |

### 配置档、NVIDIA 预设、备份

| 概念 | 内容 | 用途 |
|---|---|---|
| 配置档 | 一整套观看方案：`PROFILE_BEHAVIOR_KEYS` 的行为设置（默认状态、网页全屏、记住手动、白底检测、灵敏度、夜间、护眼、屏幕提示、按钮、面板方式、只关 HDR），可选网站规则（最多 1000 条），可选 NVIDIA 参数（HDR 开关和四项参数、超分、指示器） | 一键切换，10 分钟内可撤销 |
| NVIDIA 预设 | 只含显卡参数 | 时段、网站绑定、快捷键自动切换 |
| 备份 | 整个扩展（设置、预设、配置档、记住的视频） | 换电脑；导入会覆盖 |

- 配置档存 `storage.local` 的 `profiles`（`{v:1, list, activeId}`），最多 20 个，名称最多 24 个字，只由 background 的 `profilesTxn` 写。`ui`、`nv`（含网站绑定，预设 id 只在本机有效）、`updateCheck` 不进配置档；结构测试保证两组键的并集正好是 `DEFAULT_SETTINGS` 的全部键。
- `profile` 消息：save（同名要 `overwrite` 才覆盖；需要 NVIDIA 部分时在锁里读一次，并用借用前的开关）、apply（先写 `profileUndo`，带 NVIDIA 部分时预写 `nvLastPhase`，再 `settingsTxn(profileApply)`，再 `nvWrite(source:'profile')`，HDR 不可用时只写超分并提示）、next（命令 `next-profile`）、undo（10 分钟内，设置部分整体写回，NVIDIA 部分只恢复实时值仍等于写入值的字段）、rename、delete、import（`profilesMerge`：全部换新 id，重名改成「名 (2)」）。
- 配置档文件格式 `rtx-hdr-switch-profiles` v1，复制为文本用同一格式；遇到更新版本的文件返回 `newer`。
- 弹窗规则页签：配置档卡（点一下套用、当前配置档有差异时标「已修改」、复制、删除、保存时可选包含网站规则和 NVIDIA 参数、粘贴导入、10 分钟内撤销切换）。选项页（「配置档与备份」）：套用、重命名、导出单个或全部、从文件导入。面板：套用、保存、撤销。
- 备份格式仍是 `version: 1`，只增加可选的顶层字段 `profiles`。1.3 导入没有 profiles 的备份时保留现有配置档，有就整体替换；导入时清掉 local 里的 `nvLastPresetId`、`nvSite`、`nvLastPhase`、`nvLastSdrWhite` 和 session 里的 `profileUndo`。1.2 导入 1.3 的备份会忽略 profiles、`nv.sitePresets` 和 `updateCheck`，`defaultState: 'fullscreen'` 退回 on，网站规则里的 fullscreen 被丢掉，不报错。

### 按网站切换 NVIDIA 预设（`nv.sitePresets`）

- 触发：标签页激活、窗口焦点变化、报告、活动标签页网址变化、标签页关闭、`nv.sitePresets` 或 `nv.presets` 变化、闹钟 `nv-site`。2 s 去抖后执行 `siteEvaluate()`，同一时间只跑一个。
- 目标是焦点窗口活动标签页的最佳 frame；网站按顶层域名，没有再看 frame 自己的域名（`sitePresetFor`）。
- `nvSiteDecide`：在绑定网站上主视频在播放时套用；同一网站同一预设不动作；换到另一个绑定网站时保留第一次进入前的基准值，只补上新预设多写的字段；仍在绑定网站但没有视频时等 30 s（一次性闹钟，扛得过 service worker 回收），之后离开；换到未绑定的网站、浏览器内部页或绑定被删时离开。
- 离开：时段已经变了且新时段选了预设时套用时段预设；否则只恢复实时值仍等于当时写入值的字段（`nvSiteRestorePatch`），记为 `site` 来源、label `restore`。
- 网站预设生效期间有手动修改（任何用户来源）：记 `manual`，这个网站不再重新套用，离开时只恢复没被改过的字段。生效期间时段切换让路。
- 记录 `nvSite` 存 `storage.local`，浏览器启动和安装时重新判断，离开时能恢复。同一网站的套用失败只提示一次。
- 界面：弹窗规则页签「本网站套用」下拉框和已绑定列表（可以取消绑定）。

### 诊断页（`diag.html`）

- 入口：弹窗底栏「诊断」（带 `?tab=<当前标签页>`）、选项页右上角。
- 内容：本地组件（hello、版本、caps、dll、`nvHostCheck` 结论和处理办法）、NVIDIA 原始状态、显示器、只关 HDR 借用、当前标签页各 frame 的报告、NVIDIA 修改记录（新的在上，撤销过的划掉）、闹钟、存储用量（local 和 session 的字节数、视频记忆条数 / 2000）、更新检查、设置。
- 「复制诊断信息」默认用 `L.diagRedact` 脱敏：域名、网址、sites 和 sitePresets 的键 → `host#n`；视频 key 和 `v:*` → `key#n`；显示器 id 和名称、`nv.displayId` → `display#n`；路径里的 `C:\Users\<名>` → `<user>`；同一个值总是对应同一个编号。勾选「包含网址和设备名」时显示和复制原文。
- `diag {op:'snapshot', tabId?}` 只接受 popup、options、diag。

### 更新检查

- 只对解压安装（`management.getSelf().installType === 'development'`）运行：商店安装由浏览器自动更新，其他安装方式不检查。设置 `updateCheck`（默认开；弹窗规则页签「检查新版本」，只在解压安装时显示）。
- 闹钟 `update-check`：安装或浏览器启动 2 分钟后开始，每 180 分钟醒一次；距上次成功不满 24 小时（`updateDue`）或还在退避期内就不请求；离线、超时时下一轮闹钟再试。诊断页「立即检查」不等 24 小时。
- 请求：`GET https://api.github.com/repos/miniso7892-dotcom/rtx-hdr-switch/releases/latest`，`credentials:'omit'`、`referrerPolicy:'no-referrer'`、`cache:'no-store'`、带 `If-None-Match`（ETag），15 s 超时。不发送任何设置、浏览记录或标识；GitHub 能看到 IP 和浏览器 UA。
- 结果（`L.updateAfter`）：200 用 `parseRelease` 校验（draft、prerelease 不算；发布页和 zip 地址必须在本仓库的 releases 下）并存 ETag；304 只更新检查时间；403 / 429 按 `X-RateLimit-Reset` 或 `Retry-After` 退避；5xx 退避 3 → 6 → 12 → 24 小时；离线或超时不改检查时间。状态存 `storage.local` 的 `updateState`，不进备份。
- 提醒：有比当前版本新（`semverCmp`）且没被跳过、不在 7 天免打扰内的版本时，工具栏图标右上角画一个小点（`icon-draw.js` 的 `dot`，不占角标文字），弹窗规则页签顶部显示提醒卡（先导出备份、下载 zip、发布页、跳过此版本、× 为 7 天内不再提醒），规则页签标签带小点，底栏版本号变成主题色。
- 解压安装的更新方法：用新版 zip 覆盖原文件夹里的文件，再在扩展管理页点「重新加载」。移除扩展再加载会清空设置。

### 消息（1.3 后的完整列表）

| type / op | 谁能发 | 作用 |
|---|---|---|
| `report` | 内容脚本 | 不变；回复可能带 `remind`、`topFs`、自己的 tabId / frameId |
| `popup-get` | 扩展页面（面板只能查自己的标签页） | 最佳 frame |
| `settings-patch` | 扩展页面全部字段；播放器 frame 的内容脚本和登记过的面板按白名单 | `settingsTxn` |
| `nv` hello / get / display / set | 扩展页面（面板只有 hello / get） | 页面端口不可用时的桥；set 走 `nvWrite` |
| `nv-op` set {patch, mode} / apply-preset {id} / undo / follow-check | 扩展页面（面板没有 follow-check） | 写入服务 |
| `nv-log` | popup、面板 | 记录页面自己端口上的写入 |
| `profile` | 扩展页面（面板只有 list / apply / next / undo / save） | 配置档服务 |
| `backup` import | popup、options、diag | 后台再校验一遍，在 `settingsTxn` 和 `profilesTxn` 里导入 |
| `update` state / check / skip / snooze | popup、options、diag | 更新检查 |
| `diag` snapshot | popup、options、diag | 诊断快照 |
| `hdr-only` drop | popup、options、diag | 放手借用 |
| `panel-claim` {nonce} | 未登记的 `panel.html` | 面板认领自己的 frameId |
| `panel-frame` add / open / close / remove | 播放器网站上的内容脚本 | 面板登记 |

background 发往内容脚本：`command`（toggle-hdr、forget-video、peek）、`osd`、`fs-hint`。

### 测试

`node test/lib.test.js`（同步，纯函数和源码结构）新增：`decide` 的 tab 和 fullscreen、`createHoldGesture`、`tabOffer`、`fsHintTarget`、设置补丁和白名单、`nvUnleased` / `nvLeaseAdjust` / `nvAutoGuard` / `nvPatchDelta`、修改记录与撤销、网站预设判定与恢复、配置档全套、更新检查的版本比较和退避、`nvHostCheck`、`diagRedact`、`placeAbove` / `placeBelow` / `panelWidth`、`playerSite` 与 `PLAYER_BARS` 和 WAR 一致；结构测试覆盖面板握手、登记只在显示时启用、`isTrusted`、面板写入门控、只有 background 写 settings 和 profiles、盖在视频上的 CSS 不用 filter / backdrop-filter / transform / 透明度过渡、manifest 与 `_locales`、i18n 中英键一致且占位符相同、界面文字不含「·」和含糊词。service worker 逻辑在开发时用 vm 里的假 `chrome.*` 和假本地组件验证；面板、按钮、对比和新网站用一次性的无头 Chrome（CDP `Extensions.loadUnpacked`，去掉 `nativeMessaging` 的副本，service worker 里换成假的 `hostCall`）在真实网站上以游客身份验证，YouTube 嵌入和 B 站直播另有本地复刻页面。
