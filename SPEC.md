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

界面全部用简体中文。

## 文件结构（仓库根目录）

- `manifest.json`
- `background.js`：service worker，经典脚本，不用 module
- `lib.js`：纯逻辑。浏览器端作为内容脚本先于 content.js 注入；Node 端用 `if (typeof module !== 'undefined') module.exports = ...` 导出以便测试。不得引用 `chrome` 或 `document`。
- `content.js`：内容脚本
- `popup.html` / `popup.css` / `popup.js`
- `icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`：用 Python Pillow 生成，主题是「HDR」字样或太阳图形。所有图标的生成脚本放在 `tools/make_icons.py`。
- `test/lib.test.js`：用 `node:assert` 写，`node test/lib.test.js` 直接运行，不依赖第三方包。
- `README.md`（英文）/ `README.zh-CN.md`（中文）：安装与使用说明，两者互相链接。
- `LICENSE`：MIT。

## manifest.json 要点

- `manifest_version: 3`，`name: "HDR Switch for RTX Video"`（商店安全的名字：不以第三方商标开头；界面里的显示名仍是「RTX HDR 开关」），`version: "1.0.0"`，带中文 description，`homepage_url` 指向 GitHub 仓库，`minimum_chrome_version: "116"`。
- `permissions: ["storage", "scripting", "tabs"]`，`host_permissions: ["<all_urls>"]`。
- `content_scripts`：
  - `matches ["<all_urls>"]`，`js ["lib.js","content.js"]`；
  - `all_frames: true`，`match_about_blank: true`，`match_origin_as_fallback: true`；
  - `run_at: "document_start"`。
- `background.service_worker: "background.js"`；`action.default_popup: "popup.html"`；配置 icons。
- `commands`：
  - `toggle-hdr`：建议键 `Alt+H`，描述「切换当前视频的 RTX HDR」；
  - `toggle-auto`：建议键 `Alt+Shift+H`，描述「开/关 自动检测白底视频」；
  - `forget-video`：不设默认键，描述「清除当前视频的记忆（恢复按规则决定）」。

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
  - 画中画中的视频（`document.pictureInPictureElement`，沿 shadow 树找到真正的元素）直接作为主视频；report 带 `pip:true`，弹窗提示「画中画窗口里可能无法关闭 HDR」。
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
  - 内容例如「RTX HDR：开（手动）」/「RTX HDR：关（自动检测·白底）」，1.6 秒后淡出。
  - 全屏时 append 到真正的全屏元素：`document.fullscreenElement` 会被重定向到 shadow host，要沿各级 shadowRoot 的 `fullscreenElement` 往下找；找到的元素自己挂着 shadow root（Web Components 播放器）时 append 到它的 shadow root。它是 video 本身时 append 到 documentElement，并承认看不到。不全屏时 append 到 `document.documentElement`。
  - **不得**使用 backdrop-filter，也不得给 OSD 或视频祖先加 filter。`settings.osd` 为 false 时不显示（护眼提醒除外）。
- **消息**：
  - 向 background 发 `{type:'report', ...}`，内容包括：是否有视频、视频总数、是否有视频只是不在视口里（`offscreen`）、主视频面积、是否在播放、state（实际生效的状态）、reason、key、hostname、是否 DRM、是否画中画、是否 contested、自动检测最近的 mean/white、当前帧是否全屏、护眼增量 `eyeHdr`/`eyeWatch`。在状态变化时发送，以及每 3 秒发一次心跳。回复里可能带护眼提醒 `remind`。
  - 接收：`{type:'command', command:'toggle-hdr'|'toggle-auto'|'forget-video'}`、`{type:'get-state'}`（同步返回完整状态）、`{type:'set-state', state:'on'|'off'|'clear'}`。
- **toggle-hdr**：主视频状态翻转，记为 manual。如果 `settings.rememberManual`（默认 true）就保存 `v:<key>`。显示 OSD。没有视频时显示 OSD「当前页面没有可控制的视频」（如果没有视频矩形，就把 OSD 放在视口左上角）。
- **toggle-auto**：在 `'off'` 和 `settings.autoLastMode`（默认 `'disable'`）之间切换 `settings.autoDetect`，显示 OSD。
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

```
{ defaultState:'on', rememberManual:true, autoDetect:'disable', autoLastMode:'disable', sensitivity:'medium',
  night:{enabled:false,start:'23:00',end:'07:00'}, eye:{minutes:45,autoOff:false}, osd:true, sites:{} }
```

按视频的规则单独存成 `v:<key>` 条目。超过 2000 条时，按时间删除最旧的（在 lib.js 里写纯函数 `pruneKeys(entries, max)`，content 或 background 写入时调用）。

## 弹窗（popup，宽约 340px，简体中文，跟随系统深浅色）

1. **标题**：「RTX HDR 开关」，小字说明「关闭时该视频的 RTX 超分也会一起关闭（Chrome 限制）」。
2. **当前视频卡片**：
   - 状态大字「HDR 开」/「HDR 关」，下面一行显示原因；
   - 一个大按钮「切换」，以及「清除此视频记忆」按钮；
   - 显示 key（小字、等宽、可截断），以及自动检测的最近亮度（例如「画面亮度 72% · 白色占比 41%」）；
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
