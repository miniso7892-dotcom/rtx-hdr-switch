# RTX HDR 开关：Chrome/Edge MV3 扩展设计规格

## 背景与已验证事实（2026-10；Chrome 155，即 Chromium 155；NVIDIA 驱动 617.42；Windows HDR 已开启）

- NVIDIA“RTX 视频增强”的 HDR（TrueHDR）和超分（VSR）在 NVIDIA App 中全局开启。只有当视频被提升为 DirectComposition overlay 或 underlay 时，Chrome 才会调用 NVIDIA 视频处理器（`ui/gl/swap_chain_presenter.cc` 中的 `VideoProcessorBlt`）。
- 用 FP16 桌面抓取实测得到以下结果（RTX HDR 生效时，白色亮度约为 1000 尼特；不生效时，白色亮度等于 Windows“SDR 内容亮度”对应的 SDR 白色亮度）：
  - 在 `<video>` 元素自身加上内联样式 `filter: brightness(1)` 后，白色降到 SDR 白色亮度，即该视频的 RTX 视频增强被关闭。这在窗口模式和 `video.requestFullscreen()` 全屏模式下均有效。移除该样式后，白色立即恢复到约 1000 尼特，不需要刷新页面；开启和关闭两个方向的切换都实时生效。
  - `opacity:0.999` 和 `transform: rotate(0.01deg)` 同样能将其关闭；设置 `border-radius:1px` 或在视频角落叠加一个小 `<div>` 元素都不能将其关闭。
  - 源码依据：`filter` 会让 Blink 创建 render surface（`property_tree_manager.cc` 中的 `kFilter`）。视频 quad 进入非根 render pass 后，不会再被 DC overlay 处理，因此 VSR 和 TrueHDR 会**一起**关闭。在页面层面无法只关闭其中一项。
- 机制定为：关闭时，在视频元素上设置内联样式 `style.setProperty('filter', 'brightness(0.9999)', 'important')`。这个数值对 8 bit 画面没有可见影响，又能避免将来 Chromium 把恒等滤镜优化掉。开启时，恢复页面原有的内联 `filter` 值（先保存，再还原）。滤镜必须加在视频元素本身上，不能加在祖先元素上，因为全屏时进入 top layer 的元素不受祖先元素滤镜的影响。
- 画面亮度采样：MSE（`blob:`）视频绘制到 canvas 时不会污染 canvas；跨源且没有 CORS 的视频会污染 canvas，此时 `getImageData` 会抛出 `SecurityError`，需要捕获并标记为 `unknown`；使用 EME 的 DRM 视频读取出的画面为全黑，用 `video.mediaKeys !== null` 识别并跳过。DRM 视频通过 MediaFoundation overlay 呈现，无法用 CSS 控制，需要在界面中标明“受版权保护的视频无法控制”。
- `chrome.commands`：最多 4 个建议快捷键，必须带 Ctrl 或 Alt，不能用 Ctrl+Alt；默认只在浏览器拥有焦点时生效。Google Chrome 稳定版会忽略 `--load-extension` 参数，用户必须手动“加载已解压的扩展程序”。

## 目标用户需求

用户喜欢 HDR 的高亮度，但白底、纯白的视频不适合用 HDR 观看，长时间观看也伤眼。因此需要以下功能：

- 针对某个具体视频选择是否开启 RTX HDR；
- 快捷键；
- 记住选择；
- 自动处理白底视频；
- 护眼功能。

界面使用简体中文（1.2 版起改为中英双语，见文末“1.2”一节；1.3 版的新功能见文末“1.3”一节）。

## 文件结构（仓库根目录）

- `manifest.json`。
- `background.js`：service worker，经典脚本，不使用 ES 模块。
- `lib.js`：纯逻辑。在浏览器端作为内容脚本先于 `content.js` 注入；在 Node 端用 `if (typeof module !== 'undefined') module.exports = ...` 导出，以便测试。不得引用 `chrome` 或 `document`。
- `content.js`：内容脚本。
- `popup.html`、`popup.css`、`popup.js`。
- `icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`：用 Python Pillow 生成（`tools/make_icons.py [--accent #RRGGBB]`）。1.2 版起采用 C 风格图标：黑色圆角方块内有一块左白右黑的“屏幕”，中间有一道主题色分割线；运行时由 `icon-draw.js` 按主题色重新绘制。
- `test/lib.test.js`：用 `node:assert` 编写，用 `node test/lib.test.js` 直接运行，不依赖第三方包。
- `README.md`（英文）和 `README.zh-CN.md`（中文）：安装与使用说明，两者互相链接。
- `LICENSE`：MIT。

## manifest.json 要点（1.3.0）

- `manifest_version: 3`；`name: "__MSG_extName__"`（英文名为“HDR Switch for RTX Video”，这是适合上架商店的名称，不以第三方商标开头；界面中的显示名仍是“RTX HDR 开关”）；`version: "1.3.0"`；`default_locale: "en"`。名称、说明和快捷键说明由 `_locales/en` 和 `_locales/zh_CN` 提供。`homepage_url` 指向 GitHub 仓库；`minimum_chrome_version: "120"`（因为需要 `chrome.alarms` 的 30 秒周期）。`key` 把扩展 ID 固定为 `omgekmljdifpghaimigdbbbcmnjddmdd`。
- `permissions: ["storage", "scripting", "nativeMessaging", "alarms"]`，`host_permissions: ["<all_urls>"]`。1.3 版去掉了 `tabs` 权限：拥有 `<all_urls>` 权限就已经能读取 `tab.url`。
- `content_scripts`：
  - `matches ["<all_urls>"]`，`js ["i18n.js","lib.js","content.js"]`；
  - `all_frames: true`，`match_about_blank: true`，`match_origin_as_fallback: true`；
  - `run_at: "document_start"`。
- `background.service_worker: "background.js"`；`action.default_popup: "popup.html"`；`options_ui: {page: "options.html", open_in_tab: true}`；配置 `icons`。
- `web_accessible_resources`（下文简称 WAR）：只包含 `panel.html`，`use_dynamic_url: true`，`matches` 由 `lib.js` 的 `PLAYER_HOSTS` 生成（只包含播放器网站的 `https://<host>/*`，见“1.3”一节）。
- `commands`（Chrome 最多允许 4 个建议快捷键，已经用满；其余命令不设置 `suggested_key`，由用户自行分配）：

  | 命令 | 建议键 | 说明 |
  |---|---|---|
  | `toggle-hdr` | `Alt+H` | 切换当前视频的 RTX HDR |
  | `toggle-auto` | `Alt+Shift+H` | 开启或关闭白底视频自动检测 |
  | `nv-mg-up`、`nv-mg-down` | `Alt+Shift+Up`、`Alt+Shift+Down` | 将 NVIDIA 中间灰增加 5 或减少 5 |
  | `forget-video` | 无 | 清除当前视频的记忆 |
  | `nv-next-preset` | 无 | 切换到下一个 NVIDIA 预设 |
  | `peek` | 无 | 临时对比 HDR 和 SDR（1.3） |
  | `next-profile` | 无 | 切换到下一个配置档（1.3） |
  | `nv-undo` | 无 | 撤销上一次 NVIDIA 修改（1.3） |

  （修订：1.0 版为 `version: "1.0.0"`，`permissions` 中含有 `tabs`，只有 `toggle-hdr`、`toggle-auto`、`forget-video` 三个命令，`minimum_chrome_version` 为 `"116"`。）

## 决策模型（全部在 lib.js 中实现，可以测试）

每个视频的有效决策由 `decide(ctx)` 给出，返回 `{state: 'on'|'off', reason}`。按以下优先级取第一个命中的规则：

1. `manual`：在本页面会话中对这个视频元素手动切换过（不论是否保存）。
2. `video`：已保存的单视频规则（`storage.local` 中的键 `v:<key>`，值为 `{s:'on'|'off', t:时间戳}`）。
3. `site`：网站规则（`settings.sites[hostname]` 为 `'on'` 或 `'off'`，比较前先去掉 hostname 开头的 `www.`）。视频位于 iframe 中时，先查找顶层页面的域名（弹窗中“本网站”编辑的就是这个域名）；没有匹配的规则时，再查找 iframe 自身的域名。
4. `night`：夜间护眼时段生效时（`settings.night.enabled` 为真，且当前时间在 `[start,end)` 内，支持跨午夜，例如 23:00 至 07:00），状态为 `'off'`。
5. `auto`：自动检测判定当前视频为高亮或白底画面时，状态为 `'off'`（细节见下文）。
6. `default`：取 `settings.defaultState`（默认为 `'on'`）。

`reason` 的中文显示依次为：“手动”“已记住此视频”“网站规则”“夜间护眼”“自动检测(白底)”“默认”。

## 视频 key（lib.js 的 `videoKey(url)`）

| 网站 | URL 形式 | key |
|---|---|---|
| YouTube | `watch?v=ID`、`/shorts/ID`、`/live/ID`、`/embed/ID`、`youtu.be/ID`、`music.youtube.com/watch?v=ID` | `yt:ID` |
| YouTube 频道直播嵌入 | `/embed/live_stream?channel=<id>`（没有 `channel` 参数时使用兜底规则） | `yt:live:<id>` |
| B 站 | `/video/BVxxx`（可带 `?p=N`，默认为 1） | `bili:BVxxx:pN` |
| B 站 | `/video/avN` | `bili:av:N` |
| B 站 | `/bangumi/play/epN` | `bili:ep:N` |
| B 站 | `/bangumi/play/ssN` | `bili:ss:N` |
| B 站直播 | `live.bilibili.com/<room>` | `blive:<room>` |
| B 站嵌入播放器 | `player.bilibili.com/player.html?bvid=..&p=..` | 与 `/video/` 的格式相同 |
| 腾讯视频 | `v.qq.com/x/cover/<cid>/<vid>.html` | `qq:<vid>` |
| 腾讯视频 | `v.qq.com/x/cover/<cid>.html` | `qq:<cid>` |
| 腾讯视频 | `v.qq.com/x/page/<vid>.html` | `qq:<vid>` |
| 爱奇艺 | `iqiyi.com/v_<id>.html` | `iqiyi:<id>` |
| Twitch | `twitch.tv/videos/<id>` | `twitch:v:<id>` |
| Twitch 剪辑 | `twitch.tv/<channel>/clip/<slug>`、`clips.twitch.tv/<slug>`、`clips.twitch.tv/embed?clip=<slug>` | `twitch:clip:<slug>` |
| Twitch | `twitch.tv/<channel>` | `twitch:<channel>` |
| 其他 | — | `u:` 加上 `origin + pathname`，再加上去掉 `utm_*`、`spm*`、`from`、`share*`、`vd_source`、`t`、`si`、`feature` 等跟踪参数并排序后的查询串 |

## 自动检测（lib.js 的纯函数加上 content.js 的采样）

**采样（content.js）：**
- 主视频正在播放、页面可见、自动检测未关闭，并且更高优先级的规则（`manual`、`video`、`site`、`night`）都没有命中时，每 1500 毫秒采样一次。
- 用 `OffscreenCanvas(64,36)`（`willReadFrequently:true`）执行 `drawImage(video)`，然后调用 `getImageData`。
- `analyzeFrame(rgbaArray)` 返回：
  - `mean`：平均亮度，取值范围为 0～1，按 Rec.709 权重计算；
  - `white`：亮度大于 0.85 的像素所占比例；
  - `black`：亮度小于 0.03 的像素所占比例。
- 全黑帧（`black > 0.98`）不计入。DRM 视频（`mediaKeys` 不为空）和会污染 canvas 的视频标记为 `unknown`，并停止采样。

**判定状态机（lib.js 的 `createAutoDetector(sensitivity, mode)`，带有 `update(sample, nowMs)` 方法）：**
- 灵敏度阈值：

  | 灵敏度 | white | mean |
  |---|---|---|
  | low | ≥ 0.45 | ≥ 0.70 |
  | medium（默认） | ≥ 0.30 | ≥ 0.62 |
  | high | ≥ 0.20 | ≥ 0.55 |

- 满足任一阈值的帧即为“亮帧”。连续出现 3 个亮帧时，判定为亮画面，状态变为 `'off'`。
- `mode === 'disable'`（默认，即“只自动关闭”）：一旦判定为亮画面，这个视频（同一个 key）在本次页面会话内一直保持 `'off'`。
- `mode === 'both'`（即“自动开关”）：需要连续出现 6 个“暗帧”（`white` < 阈值 × 0.6 且 `mean` < 阈值 × 0.85）才恢复为 `'on'`；任何一次自动切换之后，至少保持 10 秒不再切换。
- `mode === 'off'`：不检测。
- 视频 key 变化或重新触发 `loadstart` 事件时，重置检测器的计数。但 `content.js` 会按 key 记住本页面会话内“已判定为亮画面”的结论：同一 key 重新触发 `loadstart`（例如 YouTube 从中插广告回到正片）、页面换用了新的视频元素、在弹窗中修改灵敏度或模式而重建检测器时，检测器直接以 `'off'` 状态开始（`createAutoDetector(sensitivity, mode, 'off')`），不会先回到 HDR 再等待 3 帧。`both` 模式恢复为 `'on'` 时，清除这条记录。
  （修订：原文中“`loadstart` 时重置检测器”与上一条“同一 key 在本次会话内保持 `'off'`”相矛盾，会导致每次插播广告时都闪一次满亮度的白屏。）
- 采样定时器启动时，立即先采样一帧（距上次采样不足 1500 毫秒时不补采），不必等待第一个间隔。

## 护眼

- **夜间时段**：见“决策模型”一节第 4 条。默认值为 `enabled:false`、`start:'23:00'`、`end:'07:00'`。
- **连续观看提醒**：`settings.eye.minutes`，默认为 45，0 表示关闭。累计“主视频正在播放且 HDR 未被阻止”的时间（暂停、页面隐藏或状态为 `'off'` 时都不计时；扩展无法阻止 DRM 视频的 HDR，因此 DRM 视频按 `'on'` 计时）。**跨视频、跨标签页、跨整页导航累计**：内容脚本只在本地累积增量（`eyeHdr`：主视频正在播放且 HDR 处于开启状态的毫秒数；`eyeWatch`：主视频正在播放的毫秒数，不论 HDR 是否开启），随报告提交给 background；background 用 `lib.eyeUpdate` 累计（多个 frame 同时上报时，按实际经过的时间封顶），状态存入 `storage.session` 的 `eye` 键。**停止观看（没有任何主视频在播放）超过 5 分钟后才清零**，切换视频不会清零。
  - 达到设定值后，background 在对该报告的回复中带上 `remind`，由发送报告的内容脚本在视频上显示 OSD，持续 6 秒。未开启 `autoOff` 时，提示为“已连续观看 HDR N 分钟，休息一下眼睛吧”；开启了 `autoOff` 时，提示为“已连续观看 HDR N 分钟，已切回 SDR，休息一下眼睛吧（按 <快捷键> 可恢复 HDR）”（没有快捷键时，括号内改为“可在扩展弹窗里恢复 HDR”）。
  - 如果 `settings.eye.autoOff` 为 `true`，则进入“护眼 SDR”状态：background 在 `storage.local` 中写入 `eyeRest: {on:true, at}`，所有内容脚本把**主视频**切换为 `'off'`，`reason` 为 `eye`，中文显示为“护眼提醒”。它的优先级等同于 `manual`（在它之后发生的手动切换优先），但不会保存。护眼 SDR 对之后的视频（下一个视频、新标签页）同样有效，直到出现以下情况之一：停止观看超过 5 分钟；用户手动切回 HDR（内容脚本删除 `eyeRest`）；在弹窗中关闭 `autoOff`，或把分钟数设为 0。
  - 提醒之后，计时清零并重新开始。
  （修订：原文按页面实例计时，并在视频 key 变化时清零护眼计时、清除由护眼造成的 `'off'` 状态，导致自动连播、分 P 以及每个视频都短于设定值时永远不会提醒，护眼 SDR 到下一个视频就失效。）

## content.js 行为

- **避免重复注入**：用 `window.__rtxHdrSwitchLoaded` 防止重复执行。扩展重新加载后，新实例位于新的 isolated world 中，看不到这个属性，因此新实例启动时会在 `document` 上派发 `rtxhdrswitch-takeover` 事件（DOM 事件可以跨 world 传递）；已失效的旧实例收到事件后停止工作，并且不还原视频样式。每个实例都在视频元素上写入 `data-rtxhdr-owner=<随机标记>`，失效实例只还原仍由自己管理的视频。旧实例发现自己已失效（`runtime.id` 为空）时，先等待 5 秒；如果没有新实例接管（扩展被停用或卸载），再还原视频样式。
- **发现视频**：
  - 使用 `document.querySelectorAll('video')`，并递归遍历 open shadowRoot（有 `chrome.dom.openOrClosedShadowRoot` 时使用它）；
  - 用 MutationObserver 监听 `document` 子树中新增的节点；另外每 2 秒兜底扫描一次；
  - 每个视频都监听 `play`、`playing`、`pause`、`loadstart`、`emptied`、`loadedmetadata`、`resize` 事件。
- **主视频**：取可见（与视口相交的面积大于 0）、未暂停且 `readyState >= 2` 的视频中面积最大的一个；如果都没有在播放，就取可见面积最大的一个。
  - 在子 frame 中，另外用 IntersectionObserver（隐式根即顶层视口，包含父页面的滚动和裁剪）观察每个视频，可见面积取两者中的较小值，避免把首屏以外的 iframe 广告当成主视频。
  - 画中画中的视频（`document.pictureInPictureElement`，沿 shadow 树找到真正的元素）直接作为主视频；报告中带有 `pip:true`，弹窗提示“画中画窗口里无法关闭 HDR，回到页面内播放后生效”。
  - 每个视频都按决策应用状态（同一页面上的其他视频也按 `site`、`default` 等规则处理），但手动切换、自动检测和护眼提醒只作用于主视频。
- **应用状态**：
  - `'off'`：先保存原有的内联 `filter`（`dataset.rtxhdrOrigFilter`，优先级存入 `dataset.rtxhdrOrigImportant`），然后执行 `style.setProperty('filter', lib.offFilterFor(原值), 'important')`。原值为空、`none`、关键字或含有 `var()` 时，新值就是 `brightness(0.9999)`；否则叠加为 `原值 brightness(0.9999)`，以保留页面自身的滤镜效果（任何 `filter` 都会让视频离开 overlay）。浏览器不接受叠加值时，退回单独的 `brightness(0.9999)`。最后设置 `dataset.rtxhdr='off'`。
  - `'on'`：只有当前 `filter` 以本扩展的 `brightness(0.9999)` 结尾（`lib.isOffFilter`）且带有 `important` 时，才还原原值，并设置 `dataset.rtxhdr='on'`。
  - 页面改写样式时：用 MutationObserver 监听视频元素的 `style` 属性，立即重新应用（回调在下一次绘制之前执行，因此逐帧改写样式的播放器也不会闪烁）。同一元素在 20 毫秒内被改回超过 6 次（页面在反向监听，双方互相触发），或在 1 秒内被改回超过 120 次时，扩展让步并将其标记为 `contested`：不再重新应用；报告中的 `state` 为实际生效的 `'on'`，`reason` 为 `contested`（显示为“页面不断改写视频样式，无法关闭”），并在主视频上显示一次 OSD。10 秒后重试，失败次数越多，间隔越长（最长约 5 分钟）；用户手动切换时立即重试。
  - **DRM 视频**（`video.mediaKeys` 不为空）：不添加滤镜（无法用 CSS 控制），不显示状态 OSD；报告中带有 `drm:true`，`state` 为 `'on'`，`reason` 为 `drm`。
  - （修订：原文在 `'off'` 时整条替换页面的内联 `filter`，对 DRM 视频也照常应用状态，并且反复让步与每秒重新应用互相冲突。）
- **URL 变化**：每秒轮询 `location.href`；监听 `yt-navigate-finish` 事件和 Navigation API 的 `navigatesuccess` 事件（如果存在）。视频 key 绑定在“元素加当前媒体”上：每个元素都记住取得 key 时的 key 和 `currentSrc`。key 变化时，对每个元素清除 `manual`、重置检测器、归入新 key，然后重新决策。**例外**：新 key 是兜底的 `u:`（跳到了首页、目录等非视频页面），而元素原来的 key 是站点视频 key，并且仍在播放同一个 `currentSrc` 时（例如 YouTube 小窗、Twitch 迷你播放器），保留原 key 及其手动状态、记忆和自动检测结果。元素触发 `loadstart` 时，按当前页面的 key 重新归属。护眼计时不因 key 变化而清零（见“护眼”一节）。
  （修订：原文在 key 变化时把页面上所有视频都改归新 key，导致在小窗中继续播放的视频会静默地回到 HDR，在小窗中按快捷键还会把规则保存到首页的 key 上。）
- **离开页面**：触发 `pagehide` 时，已经报告过的 frame 发送一条 `{type:'report', bye:true, hasVideo:false}`；触发 `prerenderingchange` 时，重新报告一次。
- **OSD 提示**：
  - 这是一个 `position:fixed`、`pointer-events:none`、z-index 很高的小标签，显示在主视频矩形左上角向内 16 px 处。
  - 内容例如“RTX HDR：开（手动）”或“RTX HDR：关（检测到白底）”，1.6 秒后移除（1.3 版起不再使用透明度过渡，见“1.3”一节的“overlay 约束”）。
  - 全屏时，挂载到真正的全屏元素上：`document.fullscreenElement` 会被重定向到 shadow host，因此要沿各级 shadowRoot 的 `fullscreenElement` 向下查找；如果找到的元素自身带有 shadow root（Web Components 播放器），就挂载到它的 shadow root 中；如果全屏元素就是 `<video>` 本身，就挂载到 `document.documentElement`，并接受此时 OSD 不可见。不处于全屏时，挂载到 `document.documentElement`。
  - **不得**使用 `backdrop-filter`，也不得给 OSD 或视频的祖先元素添加 `filter`。`settings.osd` 为 `false` 时不显示 OSD（护眼提醒除外）。
- **消息**：
  - 向 background 发送 `{type:'report', ...}`，内容包括：是否有视频、视频总数、是否有视频只是不在视口内（`offscreen`）、主视频面积、是否正在播放、`state`（实际生效的状态）、`reason`、`key`、`hostname`、是否为 DRM 视频、是否处于画中画、是否为 `contested`、自动检测最近一次的 `mean` 和 `white`、当前 frame 是否全屏，以及护眼增量 `eyeHdr` 和 `eyeWatch`。报告在状态变化时发送，另外每 3 秒发送一次心跳。回复中可能带有护眼提醒 `remind`。
  - 接收的消息：`{type:'command', command:'toggle-hdr'|'toggle-auto'|'forget-video'|'peek'}`、`{type:'get-state'}`（同步返回完整状态）、`{type:'set-state', state:'on'|'off'|'clear'}`；1.3 版另有 `{type:'osd', text, warn}`（background 发来的提示）和 `{type:'fs-hint', on}`（父页面把本 frame 设为全屏，见“1.3”一节）。
- **toggle-hdr**：翻转主视频的状态，记为 `manual`。如果 `settings.rememberManual` 为真（默认为 `true`），就保存 `v:<key>`。显示 OSD。没有视频时，显示 OSD“当前页面没有可控制的视频”（如果没有视频矩形，就把 OSD 放在视口左上角）。
- **toggle-auto**：让 `settings.autoDetect` 在 `'off'` 和 `settings.autoLastMode`（默认为 `'disable'`）之间切换，并显示 OSD。（修订：1.3 版起改由 background 的 `settingsTxn` 执行，内容脚本只发送 `settings-patch` 的 `op:'toggle-auto'`，不再自行写入 `settings`。）
- **forget-video**：删除 `v:<key>`，清除 `manual`，重新决策，并显示 OSD“已清除此视频的记忆”。
- 监听 `storage.onChanged`，在设置变化时重新决策（设置是在弹窗中修改的）。
- 性能：没有视频时不启动采样定时器；`document.hidden` 为真时停止采样。

## background.js

- 为每个标签页保存从 frameId 到报告的映射，存放在 `chrome.storage.session` 中（因为 service worker 会被回收），同时在内存中缓存。
- 报告的清理（修订：原文只在整页导航时按时间清理子 frame，SPA 移除 iframe 后，旧报告会一直残留）：
  - `sender.documentLifecycle` 不是 `active` 的报告（预渲染文档、往返缓存中的文档、正在卸载的旧文档发来的）不记录。
  - 顶层 frame 的文档发生更换时（`sender.documentId` 变化；没有 documentId 时，使用报告中的 `timeOrigin` 判断），删除该标签页所有子 frame 的报告；新页面中有视频的 iframe 会在 3 秒内通过心跳重新上报。
  - `bye` 报告：删除该子 frame 的报告（顶层 frame 则记为没有视频）；只处理与记录中 documentId 相同的文档发来的 `bye` 报告。
  - 选择最佳 frame 时，忽略 10 秒内没有消息的子 frame（`pickBestFrame(frames, now, staleMs, childMaxAgeMs)`）；最佳 frame 是子 frame 时，安排一次到期复查，这样 iframe 被静默移除时，角标也会自动更新。60 秒内没有消息的子 frame，其报告直接删除。
- 选择最佳 frame：优先选择有视频且正在播放的 frame，其次按视频面积由大到小选择。
- 根据最佳 frame 设置角标：状态为 `'on'` 时显示绿色 `#2e7d32` 的“HDR”，状态为 `'off'` 时显示灰色 `#616161` 的“SDR”，DRM 视频显示深黄色 `#8d6e00` 的“DRM”（扩展无法控制，因此不显示“HDR”或“SDR”），没有视频时清空角标。用 `setBadgeTextColor` 把文字设为白色。角标“HDR”的含义是“扩展没有阻止 RTX HDR”，RTX HDR 实际是否生效以 NVIDIA App 为准。
- 连续观看提醒的累计、`remind` 回复和 `eyeRest` 标记的维护见“护眼”一节；监听 `storage.onChanged`，以同步设置和 `eyeRest`。
- `chrome.commands.onCommand(command, tab)`：缺少 `tab` 时，查询当前活动标签页。命令发给最佳 frame（`{frameId}`）；没有报告时，发给 frameId 为 0 的 frame。`sendMessage` 失败时要捕获异常，例如在 `chrome://` 页面上。
- `onInstalled`：对所有已打开的 http 和 https 标签页执行 `scripting.executeScript({target:{tabId, allFrames:true}, files:['lib.js','content.js']})`，失败时要捕获异常；写入默认设置（不覆盖已有设置）。
- 触发 `tabs.onRemoved` 时清理数据；不使用 `webNavigation`。
- 弹窗通过 `{type:'popup-get', tabId}` 向 background 获取最佳 frameId，然后直接用 `chrome.tabs.sendMessage(tabId, msg, {frameId})` 与内容脚本通信。

## 设置（chrome.storage.local 中的 `settings`，由 lib.js 提供 DEFAULT_SETTINGS 和 mergeSettings）

1.3.0 的默认值如下（`mergeSettings(undefined)` 与它深度相等，由测试保证）：

```
{ defaultState:'on',            // 'on' | 'off' | 'fullscreen'（1.3）
  fullscreenWeb:true,           // 网页全屏也算作全屏（1.3）
  rememberManual:true, autoDetect:'disable', autoLastMode:'disable', sensitivity:'medium',
  night:{enabled:false,start:'23:00',end:'07:00'}, eye:{minutes:45,autoOff:false}, osd:true,
  playerButton:true,            // 1.2
  playerPanel:'hover',          // 'hover' | 'right' | 'off'（1.3）
  hdrOnly:false,                // 1.2
  updateCheck:true,             // 1.3，只对解压安装生效
  sites:{},                     // 域名到 'on' | 'off' | 'fullscreen' 的映射（1.3 增加 fullscreen）
  ui:{lang:'auto',accent:'#A98BFF'},
  nv:{presets:[], nightPresetId:null, dayPresetId:null, followSdr:false, displayId:null,
      sitePresets:{}} }         // sitePresets：域名到预设 ID 的映射，最多 200 条（1.3）
```

1.3 版起，`settings` 只由 background 写入（见“1.3”一节的“设置写入方”）。

单视频规则单独存为 `v:<key>` 条目。超过 2000 条时，按时间删除最旧的条目（在 lib.js 中编写纯函数 `pruneKeys(entries, max)`，由 content 或 background 在写入时调用）。

## 弹窗（1.0 和 1.1 版，宽约 340 px；1.2 版起的改版见文末“1.2”一节）

1. **标题**：“RTX HDR 开关”，下方小字说明“关闭时该视频的 RTX 超分也会一起关闭（Chrome 限制）”。
2. **当前视频卡片**：
   - 用大字显示状态“HDR 开”或“HDR 关”，下面一行显示原因；
   - 一个大按钮“切换”，以及“清除此视频记忆”按钮；
   - 显示 key（小字、等宽字体、可截断），以及自动检测最近一次测得的亮度（例如“画面亮度 72%，白色占比 41%”）；
   - 没有视频时显示“此页面没有检测到视频”（有视频元素但均未显示时，显示“此页面没有检测到正在显示的视频”；有视频但只是滚出了视口时，显示“视频不在可见区域内”）；DRM 视频显示“受版权保护的视频，无法控制”；`chrome://` 页面显示“此页面无法使用”。
   - `aria-live` 只放在状态大字和原因上（不放在每秒都会变化的亮度行上），并且只在文字实际发生变化时才写入 DOM。
3. **本网站**：下拉框，选项为“跟随规则”“总是开 HDR”“总是关 HDR”，写入 `settings.sites`。
4. **自动检测白底/高亮视频**：下拉框，选项为“关闭”“只自动关闭（推荐）”“自动开关”；另有灵敏度选项“低”“中”“高”。
5. **夜间护眼**：一个开关，以及开始时间和结束时间（`input type=time`）。
6. **连续观看提醒**：分钟数（0 表示关闭），以及复选框“到时自动切回 SDR”。
7. **默认（没有任何规则时）**：“开”或“关”。
8. **其他**：复选框“手动切换后记住此视频”和“显示屏幕提示”。
9. **快捷键区**：用 `chrome.commands.getAll()` 列出当前绑定。按钮“修改快捷键”用 `chrome.tabs.create` 打开 `chrome://extensions/shortcuts`；在 Edge 中则打开 `edge://extensions/shortcuts`（根据 `navigator.userAgent` 是否包含 `Edg/` 判断）。

弹窗每 1 秒刷新一次当前视频的状态。

## 测试要求

- 用 `node --check` 检查所有 JS 文件。
- `node test/lib.test.js` 覆盖以下内容：
  - `videoKey` 对各站点 URL 和兜底规则的处理；
  - `decide` 的优先级（每一级）；
  - 夜间时段跨午夜和不跨午夜的情况；
  - `analyzeFrame`；
  - 自动检测状态机（`disable` 模式的粘滞、`both` 模式的恢复与 10 秒最短保持、忽略全黑帧、灵敏度、以 `'off'` 状态重建）；
  - 关闭用滤镜的叠加与识别（`offFilterFor` 和 `isOffFilter`）；
  - 护眼累计（跨视频累计、停止观看 5 分钟后清零、多个 frame 不重复累计、护眼 SDR 的开始与结束）；
  - `pickBestFrame` 忽略过期的子 frame；
  - `mergeSettings` 对缺失字段或旧字段的处理；
  - `pruneKeys`。
- `manifest.json` 必须是合法的 JSON，并且其中引用的文件都存在。

## 1.2：界面改版与新功能（2026-10-21）

**界面（C 方案：高反差信号）**：采用黑、白两色加一个主题色；数字使用 Anton 字体，界面中的拉丁字母使用 Archivo 字体（位于 `fonts/`，采用 OFL 许可，只含 `latin` 子集），中文使用系统自带的微软雅黑。弹窗尺寸为 360×600 px，分为“视频”“NVIDIA”“规则”三个页签，前两个页签不需要滚动（Chrome 弹窗的最大高度为 600 px）。界面跟随系统的深浅色设置；深色模式下，SDR 状态块使用深灰色，不使用大块亮白色。

**中英双语**：`i18n.js`（纯数据，加上 `t(lang, key, params)` 和 `resolve(setting, uiLanguage)` 两个函数）在弹窗、选项页、内容脚本和 service worker 中都先于 `lib.js` 加载。设置项 `ui.lang` 可取 `auto`（浏览器界面语言以 `zh` 开头时使用中文，否则使用英文）、`zh` 或 `en`，在弹窗右上角切换后立即生效。`lib.js` 中的文字函数（`reasonText`、`osdText`、`nvErrorText` 等）增加了一个 `lang` 参数，省略时输出中文，与旧版输出一致。扩展名称、说明和快捷键说明由 `_locales` 提供（`default_locale: en`）。测试保证两种语言的键一一对应、占位符一致，并且页面和脚本中用到的键都存在。

**主题色**：`ui.accent`，提供 6 个预设（荧光绿 #C8FF2E、明黄 #FFE600、信号橙 #FF7A1A、霓虹粉 #FF5CA8、电光青 #22E1FF、薰衣紫 #A98BFF，默认为薰衣紫），另可自定义。`accentInk(hex)` 根据相对亮度，在黑色文字和白色文字中选择对比度更高的一种（分界值约为 0.18）；主题色太暗时，放在黑底上的文字改用白色。弹窗使用 CSS 变量。浏览器启动、安装和更换主题色时，由 `icon-draw.js`（使用 `OffscreenCanvas`）重新绘制工具栏图标，再调用 `action.setIcon` 设置。角标在 HDR 状态下使用主题色，在 SDR 状态下使用黑底白字，DRM 视频使用灰底白字；屏幕提示为黑底白字，并带有一个主题色小方块。

**读取 Windows SDR 亮度，一键同步**：本地组件的 `display` 命令（调用 user32 的 `QueryDisplayConfig` 和 `DisplayConfigGetDeviceInfo`，只读）给出每台显示器的 SDR 白电平。建议值（`nvSuggest`）如下：中间灰取 SDR 白电平 × 0.2158（这是 sRGB 128/255 的线性亮度，可以让 RTX HDR 的 50% 灰和桌面上的 50% 灰一样亮），并限制在 10～100 范围内；最高亮度取 min(显卡上限, 1000)（实测驱动的输出最高只到约 1000 尼特）；对比度取 +25（实测伽马约为 2.18，接近 Windows 显示 SDR 内容时的曲线）；不修改饱和度。“跟随 SDR 亮度”（`nv.followSdr`）：只有当白电平与上次调整中间灰时的白电平（`nvLastSdrWhite`）不同时，才调整中间灰。弹窗打开时，每 2 秒检查一次；弹窗关闭时，由 background 的 `nv-follow` 闹钟每 30 秒检查一次（因此 `minimum_chrome_version` 提高到 120）。

**中间灰快捷键**：`nv-mg-up` 和 `nv-mg-down`（建议键为 `Alt+Shift+Up` 和 `Alt+Shift+Down`），读取当前值后加 5 或减 5，限制在 10～100 范围内再写入；已经达到上限或下限时，只给出提示。四个建议快捷键正好用满 Chrome 的上限。

**只关 HDR，保留超分（`hdrOnly`）**：实测表明，在页面层面无法只关闭某个视频的 HDR（`dynamic-range-limit` 对 overlay 路径无效；`swap_chain_presenter.cc` 中的 auto HDR 逻辑只检查片源是否为 SDR、显示器是否为 HDR、驱动以及是否使用电池供电）。但在播放过程中切换 NVIDIA 全局 HDR 开关（0x318 的 `enabled` 位），会在 0.1～0.3 秒内生效，超分不受影响，白色正好降到 SDR 白色亮度（实测从 996.5 尼特降到 480.2 尼特，与页面自身的白色一致）。因此在这个模式下：
- 内容脚本只在 background 借用开关时所针对的那个 frame 中，不给需要关闭 HDR 的主视频添加滤镜（视频仍通过 overlay 呈现，超分得以保留），只照常上报决策；内容脚本从报告的回复中得知自己的 `tabId` 和 `frameId`。其他窗口、其他 frame 中需要关闭 HDR 的视频照常添加滤镜，因此全局 HDR 处于开启状态时，这些视频也确实是 SDR（`lib.js` 的 `hdrOnlyApplies`）；
- background 关注当前窗口的当前标签页：如果主视频需要关闭 HDR（且不是 DRM 视频），就通过常驻的 `connectNative` 端口向本地组件发送 `hdrLease on:true`，借用全局开关；否则发送 `on:false` 归还开关，并断开端口；
- 端口断开时（浏览器退出或崩溃、扩展重新加载），本地组件自行把开关恢复原状；
- 用户在弹窗中手动修改全局 HDR 时，弹窗请 background 发送 `hdrLease on:false, restore:false` 释放借用，此后不再为这个视频借用开关；
- 状态写在 `storage.local` 的 `hdrOnlyStatus` 中（`{active, leased, tabId, frameId, error?}`）：只有当 `active` 为真，且 `tabId` 和 `frameId` 与自身一致时，内容脚本才不添加滤镜。本地组件不支持此功能（没有 `caps: hdrLease`）或借用失败时，`active` 为假，此时退回逐视频添加滤镜的方式，60 秒后再重试。
- 界面上要写明代价：关闭的是全局 HDR，同时播放的其他视频也会变成 SDR。

**备份**：使用选项页 `options.html`（打开文件选择框会导致弹窗关闭，所以放在单独的页面中）。导出格式为 `{format:'rtx-hdr-switch-backup', version:1, exportedAt, extensionVersion, settings, videos}`，只包含设置和单视频记忆。导入前，由 `validateBackup` 检查格式和版本，按 `mergeSettings` 规范化，视频记忆超过 2000 条时只保留最新的记录；然后显示摘要，用户确认后覆盖现有数据。

**全局关闭提示**：本地组件已连接、NVIDIA 全局 HDR 处于关闭状态（且不是“只关 HDR”正在借用）时，在视频页签顶部给出提示，并提供“开启”按钮；HDR 出错时（例如 Windows 未开启 HDR），显示出错原因。

**播放器控制栏按钮（`playerButton`，默认开启）**：在网站自身的控制栏中放置一个 HDR 按钮，点击它相当于对这个视频按一次 `Alt+H`。每个 frame 最多放置一个按钮，放在主视频所在播放器的控制栏中。
- 网站按视频所在 frame 自身的完整域名判断（`lib.js` 的 `playerSite(hostname, pathname)`；1.3 版增加了 B 站直播、YouTube 嵌入播放器和爱奇艺，见“1.3”一节）。1.2 版支持的域名为：`www.bilibili.com`、`bilibili.com`、`player.bilibili.com`；`www.youtube.com`、`youtube.com`，但不包括 `/embed/`（嵌入播放器使用另一套移动端样式的控制栏，没有 `.ytp-right-controls`）；`www.twitch.tv`、`twitch.tv`；`v.qq.com`。1.2 版不在 B 站直播（鼠标移出控制区时控制区即被删除，移入时再重建，class 带有 svelte 哈希）、爱奇艺（class 名每次构建都会变化，只在贴片广告期间实测过）和其他网站上添加按钮。
- 选择器只写在 `content.js` 的 `PLAYER_BARS` 中：从主视频向上查找播放器（`root`，`skip` 中列出的悬停预览播放器不算），在播放器中查找控制栏右侧（`bars`，取第一个能找到的），然后按顺序逐个尝试 `before` 中的选择器，把按钮插在控制栏中含有首个命中元素的那个直接子元素前面：

| 网站 | root | 控制栏 | 插在其前面（依次查找） |
|---|---|---|---|
| B 站 | `.bpx-player-container`（跳过 `.v-recommend-inline-player`） | `.bpx-player-control-bottom-right` | `.bpx-player-ctrl-setting`、`-pip`、`-full`（外链播放器没有前两个） |
| YouTube | `#movie_player`（跳过 `#inline-preview-player`） | delhi 版：`.ytp-chrome-bottom .ytp-right-controls-left`（与字幕、设置按钮位于同一个圆角框中）；旧版：`.ytp-right-controls` | `.ytp-subtitles-button`、`.ytp-settings-button` |
| Twitch | `.video-player` | `.player-controls__right-control-group` | 包着 `[data-a-target="player-settings-button"]` 的那一层元素 |
| 腾讯视频 | `#player-component, .txp_player` | `.txp_right_controls` | `.txp_btn_pip`、`.txp_btn_fake`、`.txp_btn_fullscreen` |

- 仿照原生按钮的结构和 class 创建按钮，大小、悬停效果、全屏时变大、键盘焦点框都来自网站自身的 CSS（不写死尺寸）：B 站为 `div.bpx-player-ctrl-btn[role=button][tabindex=0] > .bpx-player-ctrl-btn-icon > span.bpx-common-svg-icon > svg`；YouTube 为 `<button class="ytp-button">`；Twitch 的 class 名每次构建都会变化，因此在运行时复制设置按钮及其外面两层元素的 class；腾讯视频为 `div.txp_btn > svg.txp_icon + div.txp_tooltip`。
- 图标：白色的“HDR”徽标。开启时为实心徽标、字母镂空，关闭时为描边徽标加一道斜杠。图标在 24×24 的画布上绘制，用 `createElementNS` 拼接路径和 mask（因为 YouTube 页面启用了 Trusted Types），不使用 `<text>` 和字体，也不使用主题色。原生图标的 viewBox 更大时（YouTube 旧版为 36，腾讯视频为 28），把图标居中放置，使其与原生图标一样大。
- 状态取主视频的实际生效状态（`info.eff`，与报告给角标的是同一个值；“只关 HDR”借用全局开关时，视频没有添加滤镜，但按钮同样显示为关闭）：开启时为 `aria-pressed="true"`，关闭时为 `aria-pressed="false"`；DRM 视频为 `aria-disabled="true"`，按钮变暗，提示文字为 `player.drm`，点击无响应。按钮文字取 `player.on`、`player.off` 或 `player.drm` 对应的文案，随界面语言变化。在 `evaluate()` 的末尾同步按钮状态，只有状态或语言发生变化时才写入 DOM。
- 提示：B 站和 YouTube 的提示由网站自身的脚本统一管理，插入的按钮没有提示，所以由扩展自行绘制一个（B 站的提示放在按钮内，YouTube 的提示挂在 `#movie_player` 上，全屏时也位于全屏元素内；样式仿照原生提示，不使用 `backdrop-filter`）；腾讯视频使用网站自身的 `.txp_tooltip`；Twitch 使用 `title` 属性（1.3 版改为自绘提示）。
- 交互：在 `mousedown` 时调用 `preventDefault`（不抢夺焦点，网站快捷键照常可用）；不拦截控制栏中 `click` 事件的冒泡（实测不会导致视频暂停）；按回车键相当于点击（1.3 版改为松开时切换、按住时对比）；空格键留给播放器（`<button>` 在松开空格键时自身触发的那次点击不计入）。
- 稳健性：所有回调都包在 `guard` 中，不向外抛出异常。播放器或锚点尚未出现时，每 500 毫秒重新查找一次，15 秒后放弃，等到下一次导航（`yt-navigate-finish`、`yt-player-updated`、`popstate`、`navigatesuccess`、`pageshow`）或主视频更换时再查找。B 站实测时，控制栏先出现，原生按钮随后才填入：锚点未出现时先等待 3 秒，仍未出现时就把按钮加在最后，锚点出现后再移到锚点前面；每次放置最多移动 3 次。其他扩展把元素插在按钮和锚点之间不算错位，扩展不与它们反复争夺位置。按钮被网站删除时（控制栏重建），在已有的 `document` 观察者中顺带检查 `isConnected`，并在下一帧重新放置按钮；如果网站在 10 秒内从同一个控制栏中删除按钮达到 8 次，就停止尝试。不新增 `document` 级别的观察者，也不在扩展自身插入的节点中扫描视频。每秒一次的定时检查、导航事件和 `fullscreenchange` 事件也会触发重新检查。B 站小窗（`data-screen="mini"`）中的按钮用一条样式规则隐藏。
- 扩展重新加载：按钮、提示和样式都带有 `rtxhdr-player-btn` class 和 `data-rtxhdr-owner=<实例标记>`；失效的旧实例收到 `rtxhdrswitch-takeover` 后，在 `destroy` 中删除自己创建的节点；新实例在放置按钮前，再删除其他实例遗留的节点。执行 `destroy` 时，按钮也一并删除。
- “规则”页签中的“在播放器控制栏显示 HDR 按钮”修改后立即生效：关闭时删除按钮，开启时重新查找并放置。

测试：`node test/lib.test.js`（覆盖 i18n、主题色、建议值、备份、manifest 与 `_locales`、`playerSite`）。service worker 逻辑以及与真实本地组件的端到端流程，在开发时用一次性的无头 Chrome（CDP `Extensions.loadUnpacked`）验证。控制栏按钮在开发时用仿照各网站结构和 CSS 制作的本地页面（通过 `--host-resolver-rules` 把真实域名指向本地）逐项验证（位置、与原生按钮一样大、点击、回车和空格、重建后重新放置、开关设置、切换语言、DRM、扩展重新加载后不重复），然后再以游客身份在真实网站上检查一遍。

## 1.3：播放器面板、观看功能、配置档与诊断（2026-10-22）

### 架构决定

1. 播放器内的设置面板做成扩展 iframe（`panel.html`），不在网页中直接绘制 DOM：它是跨源的扩展页面，网页脚本无法读取其内容，也无法在其中合成可信事件。面板与内容脚本之间通过 `chrome.tabs.connect` 端口通信，不使用 `postMessage`（实验发现 `postMessage` 会把扩展 ID 暴露给网页）。
2. `settings` 和 `profiles` 只由 background 写入：`settingsTxn` 串行地读取、修改、写入，其他页面和内容脚本通过 `settings-patch` 消息提交补丁。结构测试保证 background 以外的 JS 文件不对这两个键调用 `storage.local.set`。
3. 除拖动滑块以外，所有 NVIDIA 写入都经过 background 的 `nvWrite`，包括快捷键、时段、跟随 SDR、配置档、网站预设、撤销、套用预设和全局 HDR 开关。它们共用一个常驻的本地组件端口和一把互斥锁（`nvTxn`），每次写入都进入修改记录。弹窗和面板中拖动滑块时，仍通过各自的本地组件端口写入（以降低延迟），提交后补发 `nv-log`。
4. 在“只关 HDR”借用期间，保存或比较时一律使用借用前的开关值（`nvUnleased`；`hdrLease` 回复中的 `prevEnabled` 存入 `hdrOnlyStatus`）。这同时修复了 1.2 版中借用期间保存的预设会带上 `enabled:false` 的问题。
5. 不新增权限，并去掉 `tabs` 权限。更新检查只对解压安装运行，调用 `chrome.management.getSelf()` 不需要 `management` 权限。
6. 1.3 版不修改本地组件：它仍是 1.2.1 版，协议版本为 1。扩展根据 `hello` 回复中的 `caps` 判断支持的功能（`nvHostCheck`，要求同时支持 `display` 和 `hdrLease`）；如果本地组件是旧版，诊断页会提示重新运行 `install.cmd`。

### 决策优先级（`L.decide`，修订）

| # | reason | 来源 | 作用范围 | 是否保存 |
|---|---|---|---|---|
| 1 | `manual`、`eye` | 本页面的手动切换；护眼 SDR 以 `manual` 的身份传入 | 这个视频 | `rememberManual` 开启时保存到 `v:*`；护眼 SDR 不保存 |
| 2 | `tab` | 本标签页沿用（内容脚本内存中的 `tabSticky`） | 当前文档中的后续视频 | 不保存，刷新或整页导航后失效 |
| 3 | `video` | `v:<key>` | 该 key | 保存 |
| 4 | `site` | `sites[顶层域名]`，没有匹配时再查找 frame 自身的域名；值为 `on`、`off` 或 `fullscreen` | 网站 | 保存在 `settings` 中 |
| 5 | `night` | 夜间时段内为关闭 | | |
| 6 | `auto` | 白底检测命中时为关闭 | 主视频 | |
| 7 | `default`、`fullscreen` | `defaultState` 为 `on` 或 `off` 时，reason 为 `default`；为 `fullscreen` 时，状态取决于“主视频是否全屏”，reason 为 `fullscreen` | | 保存在 `settings` 中 |

- 网站规则为 `fullscreen` 时，状态同样取决于主视频是否全屏，reason 仍为 `site`；它与 `on`、`off` 一样优先于夜间规则。默认级别的“仅全屏”排在夜间规则和白底检测之后：这两条是保护性规则，全屏观看白底视频反而最刺眼。
- reason 为 `default` 或 `fullscreen` 且状态为开启时，进行白底检测采样。
- `reasonText`：中文为“本标签页沿用”和“仅全屏”；英文为“kept for this tab”和“fullscreen only”。

### 按住对比

- 控制栏按钮：主指针按下后在 300 毫秒内松开，即为单击切换（行为不变）；按住满 300 毫秒（`L.PEEK_HOLD_MS`，`L.createHoldGesture`）时，主视频临时变为相反的状态，左上角显示紧凑提示“对比：SDR”或“对比：HDR”（不受 `settings.osd` 控制）。松开、触发 `pointercancel` 或 `lostpointercapture`、页面隐藏、按钮被移除、主视频或 key 发生变化、决策状态发生变化时，都立即恢复；紧跟在按住操作之后的那次 `click` 被拦截并丢弃。安全上限为 30 秒（`PEEK_MAX_MS`）。
- 回车键（按钮拥有键盘焦点时）：`keydown` 只开始计时，在 300 毫秒内松开即为切换，按住满 300 毫秒即为对比，松开后恢复。（修订：1.2 版的“按回车键相当于点击”改为松开时切换。）空格键不参与，仍用于播放器的播放和暂停（YouTube 中按住空格键为 2 倍速播放）。
- 命令 `peek`（不设置建议键）：对比 5 秒（`PEEK_CMD_MS`）；对比期间再按一次，立即恢复；开始后 500 毫秒内重复到达的命令被忽略（防止按键自动重复）。
- 面板中的“按住对比”：按下时立即开始，松开、面板收起或端口断开时结束。
- 不变量：对比期间不调用 `setManual`，不写入 `v:*`，不改变护眼计时；`info.eff` 仍是决策状态，所以报告、角标、“只关 HDR”借用和护眼计时都不受影响。按钮图标随显示状态变化，`aria-pressed` 仍按决策状态设置。
- 拒绝对比、只给出提示的情况：没有视频；DRM 视频；决策为关闭，但页面在争夺样式（`contested`）；决策为关闭，且“只关 HDR”对本 frame 生效（全局 HDR 已被借用，没有 HDR 画面可供对比，提示文字为 `content.peekHdrOnly`）。
- 不会触发网站自身的长按功能：端到端测试中按住 0.8 秒时，`playbackRate` 保持为 1。

### 只在全屏时开启 HDR

- `isFullscreenFor(v)` 只对主视频求值：
  1. 有全屏元素时（沿各级 shadowRoot 找到真正的全屏元素），检查它是否包含该视频（YouTube 的全屏元素是 `<html>`，同样成立）；
  2. 没有全屏元素，但本 frame 不是顶层 frame、收到了 `fs-hint`，并且本 frame 的视口不小于屏幕面积的 1/4 时，算作全屏（1/4 的下限用于防止“退出全屏”的通知丢失时，小尺寸的嵌入播放器一直被当成全屏）；
  3. `settings.fullscreenWeb` 处于开启状态、`PLAYER_BARS[site].webFull` 存在且 `v.closest(webFull)` 命中时，算作全屏（网页全屏）。B 站为 `.bpx-player-container[data-screen="web"]`；B 站直播为 `body.player-full-win`（即“网页模式”，已在顶层直播间实测，`/blanc/` iframe 形态尚未测试）；
  4. 画中画和浏览器的 F11 全屏都不算作全屏。
- 父页面把 iframe 设为全屏时：顶层 frame 的报告中带有 `fsFrame`（条件是：存在全屏元素，它不包含顶层 frame 自身的主视频，并且它本身是 iframe，或其中有占视口一半以上的 iframe）。background 用 `L.fsHintTarget` 选出目标子 frame（如果某个未过期的子 frame 已自行报告了全屏，则不选），目标变化时，用 `tabs.sendMessage(tabId, {type:'fs-hint', on}, {frameId})` 通知旧目标 `off`、通知新目标 `on`；报告的回复中另外带有 `topFs` 作为兜底（心跳间隔为 3 秒）。只从顶层 frame 转发到其直接子 frame，不支持更深层的嵌套。
- 报告中的 `fullscreen` 字段改为表示“本 frame 的全屏元素包含主视频”。
- “只关 HDR”开启时，每次进入或退出全屏，都会借用或归还一次全局开关。`rememberManual` 开启时，手动切换会写入视频记忆，此后它的优先级高于“仅全屏”。

### 本标签页沿用

- `tabSticky = {state, at}` 是内容脚本的模块级变量，生命周期跟随当前文档：单页应用中的连播、分 P 和播放列表都会保留它；刷新、整页导航或关闭标签页后失效。每个 frame 各有一份。
- 入口一是屏幕提示上的提议：当上一次手动切换针对的是另一个 key、切换到的是同一个状态，并且当前没有处于沿用状态时（`L.tabOffer`），这次的提示变为可点击的“本标签页后续视频沿用”，显示 4 秒。此时宿主元素临时设为 `pointer-events:auto`，并对 `pointerdown`、`mousedown`、`mouseup`、`click`、`dblclick`、`contextmenu` 调用 `stopPropagation`；按钮只接受 `isTrusted` 为真的点击。`settings.osd` 关闭时不显示提议。
- 入口二是面板“本视频”页签中的复选框。
- 沿用期间，对主视频的手动切换会同时更新沿用的状态。清除记忆（通过弹窗、快捷键或 `set-state clear`）时，一并取消沿用。由沿用决定状态的新视频，每个 key 显示一次提示。自动沿用不写入 `v:*`。

### 播放器面板

**触发方式（`settings.playerPanel`）**

| 模式 | 打开 | 收起 |
|---|---|---|
| `hover`（默认） | 收到可信的 `pointerenter` 时预载 iframe，悬停 350 毫秒后打开（临时态）；触屏的点按不算 | 指针离开按钮和面板 400 毫秒后收起；拖动滑块或按住对比期间不收起 |
| `right` | 右键：在 `contextmenu` 事件上调用 `preventDefault` 和 `stopPropagation`，网站的右键菜单不会出现，面板以固定态打开 | 见下文 |
| `off` | 不打开，键盘方式也不响应 | |

- 在 `hover` 和 `right` 模式下，按钮拥有键盘焦点时，按 ArrowUp 或 Shift+Enter 会以固定态打开面板，焦点移入面板的第一个控件。面板中发生过可信操作后，也会变为固定态。
- 固定态的面板只在以下情况下收起：按 Esc、点击面板外部（只收起面板，不拦截事件）、用 Tab 键把焦点移出、播放器 `root` 发生变化、全屏后面板不可见、B 站切换到小窗、页面隐藏、面板被遮挡。通过 Esc 或 Tab 收起时，焦点交还给按钮。
- 左键单击和回车键始终用于切换，面板保持打开并即时更新；从按钮开始对比时，面板先收起。
- 收起时只切换 `visibility`，iframe 保留 60 秒后再销毁；预载后没有打开的 iframe 同样在 60 秒后销毁。面板的本地组件端口在收起 20 秒后断开。网站把播放器移动到其他容器、导致 iframe 重新加载时，已打开的面板就地重建（10 秒内最多 3 次）。B 站直播的控制区被删除时，已打开的面板保留，控制区重建后再连接到新按钮上。

**布局**：宽 320 px（播放器宽度小于 336 px 时，取播放器宽度减去 16 px，下限为 260 px）。面板放在按钮正上方并居中，左右各留 8 px（YouTube 嵌入播放器中放在按钮正下方）；高度取面板上报的值，放不下时在面板内部滚动。播放器小于 260×160 px 时不打开面板，按钮只用作开关。面板有三个页签：“本视频”（“开启 HDR”“关闭 HDR”“跟随规则”三段、“本标签页后续视频沿用”、“按住对比”、四段式的本网站规则、白底检测、灵敏度）、“NVIDIA”（全局 HDR 开关、四个滑块、6 段式超分、GPU 优先级、预设标签、“还原到打开时”）、“配置档”（点击列表项即可套用、“保存当前为配置档”、“撤销切换”）。界面遵循“让布局自己说话”的原则：每个控件或分组只设一个短标签，不加说明行。面板中不使用原生 `<select>`（因为下拉列表会绘制在 iframe 外面）。“完整设置”先尝试调用 `action.openPopup()`，如果失败，就在新标签页中打开 `popup.html?tab=<标签页 ID>`，弹窗按那个标签页显示内容。

**挂载与握手**

- 内容脚本在播放器 `root` 中插入一个空白 iframe（YouTube 嵌入播放器的控制层覆盖在播放器上，因此挂载到 `body` 上），然后执行 `contentWindow.location.replace(runtime.getURL('panel.html') + '#f=<本 frame ID>&n=<nonce>')`。地址不写进 `src` 属性：网页能够读取这个属性，读到后就能自行嵌入一份面板；而在跨源导航之后，网页无法读取 iframe 的地址。nonce 是 16 字节的随机数。
- 面板加载后，先向 background 发送 `{type:'panel-claim', nonce}` 认领自己：background 从 `sender` 中得知这个 iframe 的 frameId（扩展页面和内容脚本都无法获取它）。如果同一个 nonce 被两个 frame 认领（说明地址已经泄露），则两者都不予登记；认领在 30 秒内有效。
- 面板用 `tabs.getCurrent()` 获取所在标签页，再用 hash 中的 frame ID 连接回内容脚本（端口名为 `rtxhdr-panel`），第一条消息是带有 nonce 的 `hello`。内容脚本只接受由本扩展的 `/panel.html` 发起的端口，每个面板只接受第一个端口，10 秒内没有收到正确的 `hello` 消息就销毁面板。
- 握手成功后，内容脚本发送 `{type:'panel-frame', op:'add', nonce}`，background 把该 nonce 认领的 frameId 登记为面板（存入 `storage.session` 的 `panelFrames`，每个标签页最多 8 个，不受 service worker 回收的影响）。面板显示时以 `op:'open'` 启用，收起时以 `op:'close'` 停用，销毁时以 `op:'remove'` 注销。`panel-frame` 只接受播放器网站上的内容脚本发来的消息。
- background 的 `fromExtensionPage` 把 `/panel.html` 认定为扩展页面 `panel` 的条件是：`sender.id` 是本扩展，协议是 `chrome-extension:`（在 `use_dynamic_url` 下主机名是动态的），所在的 `tabId` 和 `frameId` 已经登记并处于启用状态，并且文档处于活动状态。其他扩展页面（popup、options、diag）如果带有标签页信息，就必须是顶层 frame。
- 面板只在播放器网页中的 iframe 里工作：在顶层窗口中直接打开，或者 `location.ancestorOrigins[0]` 的域名不在 `PLAYER_HOSTS` 中时，面板不显示任何内容。

**协议**

| 方向 | 消息 | 含义 |
|---|---|---|
| 面板发往内容脚本 | `hello {nonce}` | 握手 |
| 内容脚本发往面板 | `init {state, topHost, site, trigger}` | 握手和登记成功后发送 |
| 内容脚本发往面板 | `state {state}` | `panelSnapshot()` 的结果：`hasVideo`、`drm`、`state`、`reason`、`manual`、`saved`、`tab`、`peek`、`hdrOnly`、`eyeRest`、`pip`、`topHostname`；签名变化时才推送，不轮询 |
| 内容脚本发往面板 | `open {via, focus}`、`close` | 显示和收起；面板在收到 `open` 之前不发送任何写入 |
| 面板发往内容脚本 | `size {h}` | 面板内的 ResizeObserver 报告的高度 |
| 面板发往内容脚本 | `video {op:'on'\|'off'\|'clear'}` | 作用于按钮所在播放器的视频；`clear` 即跟随规则，并清除这个视频的记忆；对 DRM 视频忽略此消息 |
| 面板发往内容脚本 | `tab {on}`、`peek {on}`、`pin`、`hold {on}`、`hover {on}`、`activity {x, y}`、`close {reason}` | 依次表示：沿用、对比、固定、拖动期间不收起、指针位于面板上、唤醒网站控制栏（节流为 500 毫秒，只派发 `mousemove`）、收起 |

- 内容脚本发给面板的消息只有 `init`、`state`、`open`、`close` 四种，面板不会因为收到这些消息而执行任何写入操作。除 `size` 以外的面板消息，只在面板处于显示状态时处理。
- 面板与 background 的通信：设置通过 `settings-patch` 修改（只能修改 `L.contentPatchAllowed` 放行的字段，另外可以修改顶层网站对应的那一条 `nv.sitePresets`）；全局 HDR 开关（`mode:'suppress'`）、套用预设、“还原到打开时”（`mode:'yield'`）通过 `nv-op` 发送；`nv` 桥只开放 `hello` 和 `get`；配置档只开放 `list`、`apply`、`next`、`undo`、`save`；拖动滑块时使用面板自己的本地组件端口，提交后发送 `nv-log`。面板的写入（`list` 除外）与内容脚本的 `settings-patch` 共用每个标签页每秒 10 次的上限。
- 面板的 NVIDIA 页签只在显示时每 2 秒拉取一次状态。“还原到打开时”用 `L.nvRevertPatch` 只写入有差异的字段，比较的两边都使用借用前的开关值。

**安全**

- 按钮的点击、键盘、悬停、右键处理，以及面板中的每个写操作，都检查 `isTrusted`；面板只在处于显示状态时接受操作（收起后焦点仍留在面板中时，按键不生效，界面恢复原状）。
- 面板收起时不保留键盘焦点（否则网站快捷键会被拦截，方向键会误改不可见的控件）。
- 点击劫持：iframe 的内联样式全部带有 `!important`（`all:initial`、不透明，并且没有 `filter`、`transform`、`clip-path`、`transition`），每次求值时都重新写回。面板打开期间检查以下条件：`checkVisibility` 通过；祖先链的透明度乘积不低于 0.9；祖先元素没有 `filter` 和 `mask`；在面板中心和四个角共 5 个点上，`elementFromPoint` 都命中该 iframe。连续两次检查不通过，就收起面板。IntersectionObserver v2 在 Twitch（有整块的透明遮罩）和腾讯视频上会误判，因此在播放器网站本身上不使用它。
- 播放器嵌在第三方网页中时（`ancestorOrigins` 中有不属于播放器网站的源），第三方网页即使把嵌入的播放器改为透明或将其遮盖，内容脚本也无法获知：此时面板用 IntersectionObserver v2（`trackVisibility`）的 `isVisible` 对写入操作进行把关，不可用时一律不写入。
- 网页自行嵌入的面板副本无法获取 nonce，无法连接内容脚本，也无法完成认领，因此不显示任何内容。
- 防探测：使用 `use_dynamic_url`，WAR 只对播放器网站开放，使用静态 ID 的地址会被拒绝；iframe 只在悬停后到销毁前的这段时间内存在。

**overlay 约束**：面板文档和 iframe 元素上都不使用 `backdrop-filter`、`filter`、`opacity` 过渡或 `transform`；显示和隐藏只切换 `visibility`；不修改视频及其祖先元素的样式。屏幕提示、对比提示和按钮提示同样遵守这些约束（由结构测试扫描 `content.js` 和 `panel.css`）。面板覆盖在视频上时 RTX HDR 是否仍然生效，需要在 HDR 显示器上用有界面的浏览器实测（使用 hdrcap，未被遮挡区域中白块的亮度不低于基线的 0.9 倍），无头模式测不出来。

### 新增网站（`PLAYER_BARS` 和 `PLAYER_HOSTS`）

| 网站 | 域名（`playerSite`） | root | 控制栏 | 插在其前面（依次查找） | 说明 |
|---|---|---|---|---|---|
| B 站直播 | `live.bilibili.com` | `#live-player` | `.control-area .right-area` | `.quality-wrap`、`.ext-nodes` | 鼠标移出控制区时控制区即被删除，移入时重建（class 带有 svelte 哈希）：设置 `rebuild: '#web-player-controller-wrap-el'`，在已有的观察者中检测到该元素下有新增节点时，重新放置按钮；10 秒内最多插入 20 次。顶层页面和 `/blanc/` iframe 两种形态都已验证 |
| YouTube 嵌入播放器 | `www.youtube.com`、`youtube.com`、`www.youtube-nocookie.com`、`youtube-nocookie.com` 下的 `/embed/` | `#movie_player` | `#player-controls .player-controls-top-right`（`scope: 'doc'`，因为控制栏不在播放器内） | `.player-settings-icon` | 使用移动版控制栏，提示使用 `title` 属性（与原生的静音、字幕按钮一致）；面板放在按钮下方，挂载在 `body` 上。网站规则按顶层页面的域名匹配 |
| 爱奇艺 | `www.iqiyi.com` | `#container1MainContent` | `[class*="defaultController_playCtrl__"] > #right` | `settingBtn`、`voice`、`mini`（`data-xplayer-control-key` 的值） | class 带有构建哈希，因此只使用前缀和 data 属性；按钮结构在运行时仿照原生按钮复制；自绘提示仿照原生样式，但不使用原生提示中的 `backdrop-filter` |

- `PLAYER_BARS` 的条目新增以下字段：`scope`（为 `'doc'` 时在整个文档中查找控制栏）、`rebuild`、`webFull`、`hideIn`（B 站小窗规则迁移到这里）、`tipGap(btnRect)`、`panelZ`、`panelBelow`。
- Twitch 不再使用 `title` 属性，改为仿照原生提示绘制的自绘提示（`TIP_CSS_TWITCH`，白底黑字，带一个小三角），挂在 `.video-player` 中；React 重新渲染移除提示后，按钮再次获得焦点时重新挂载提示。
- `manifest.json` 中 WAR 的 `matches` 和相关测试都由 `PLAYER_HOSTS` 派生。

### 设置写入方

- `settingsTxn(mutator)`：先读取最新值，交给 `mutator` 修改，再经过 `mergeSettings` 规范化，与原值不同时才写入；各次调用排队执行。使用方包括：`settings-patch` 消息、`initSettings`、配置档的套用和撤销、备份导入、`toggle-auto`。
- `settings-patch {patch}` 或 `{op:'toggle-auto'}`：
  - 扩展页面（popup、options、diag）可以修改任何字段；
  - 播放器 frame 中的内容脚本和已登记的面板只能修改 `autoDetect`、`autoLastMode`、`sensitivity`、`playerButton`、`playerPanel`、`sites[顶层域名]`（值为 `on`、`off`、`fullscreen` 或 `null`），面板另外可以修改 `nv.sitePresets[顶层域名]`；补丁中出现其他字段时，拒绝整个补丁（`L.contentPatchAllowed`）；每个标签页每秒最多 10 次；未登记的 `panel.html` 发来的补丁一律拒绝；
  - 弹窗用 `L.settingsPatchFor(prev, next)` 生成最小补丁，在防抖期间合并补丁（`mergeSettingsPatch`）；收到 `onChanged` 时，用 `applySettingsPatch(新值, 尚未发出的补丁)` 渲染界面，避免刚输入的值被覆盖。
- 在 MV3 中，无法禁止内容脚本直接写入 `storage.local`：白名单保证的是正确性，而不是安全边界。

### NVIDIA 写入服务与修改记录

- `hostCall(msg)`：background 共用一个常驻的本地组件端口，按 ID 把请求与回复对应起来。没有借用、并且 15 秒内也没有请求时，断开端口（这样 service worker 才能休眠）；`connectNative` 抛出异常或连续 3 次退出时，改用每次调用都启动一个进程的 `sendNativeMessage`。
- `nvWrite({source, label, patch | build(st), lease:'yield'|'suppress'})` 的步骤：先执行 `get`；再生成补丁（自动来源的补丁要经过 `nvAutoGuard` 过滤）；用 `nvPatchDelta` 去掉与实时值相同的字段（全部相同时，既不写入也不记录）；用 `nvLeaseAdjust` 处理借用（`suppress`：用户手动拨动 HDR 开关时，只要正处于借用状态，就释放借用，并且不再为这个视频借用；`yield`：如果 `enabled` 等于借用前的值，就从补丁中去掉 `enabled`，否则先释放借用再写入，写完后重新评估）；然后经过 `nvValidatePatch` 校验，执行 `set`，最后记录日志。返回的 Promise 永远不会被拒绝（reject）。
- 来源（`NV_SOURCES`）：popup、panel、hotkey、schedule、follow、profile、site、lease、undo。
- 修改记录：存放在 `storage.session` 的 `nvLog` 中，为容量 100 条的环形缓冲区，记录修改前后的值（`nvStateDiff`，只比较可写字段）、来源、是否成功、是否可以撤销。借用和归还只在开关状态实际改变时才记录，并且不可撤销。弹窗和面板通过自己的端口写入后，由页面补发 `nv-log`；页面关闭时仍在途的提交记为 `unconfirmed`，不可撤销。
- 撤销：`nvUndoTarget` 选取最近一条满足以下条件的记录：成功、可以撤销、未被撤销过、来源不是 undo 或 lease、在 1 小时以内。`nvUndoPatch` 只撤销实时值仍等于当时写入值的字段（之后又被修改过的字段会跳过，并加以说明），`peak` 限制在实时允许的范围内，HDR 出错时去掉补丁中的 HDR 部分。连续执行撤销时，逐条向前撤销。入口有：命令 `nv-undo`；弹窗 NVIDIA 页签中修改后 10 秒内显示的“上一次：……（来源）”提示及其“撤销”按钮；`nv-op undo`。
- 行为变化：跟随 SDR 开启时，自动来源（时段、网站预设）不再写入中间灰；用户来源照常写入，等到白电平下一次变化时，再由跟随功能接管。

**NVIDIA 参数的优先级**（哪个视频开启或关闭 HDR 仍由 `decide` 决定）

| 来源 | 触发条件 | 优先级 | 与“只关 HDR”借用的关系 | 与跟随 SDR 的关系 | 记录与撤销 |
|---|---|---|---|---|---|
| 手动：弹窗、面板、中间灰快捷键、套用预设、下一个预设、撤销 | 用户操作 | 1 | HDR 开关使用 suppress，其余使用 yield | 照常写入中间灰 | 记录，可以撤销 |
| 配置档：套用、命令、撤销 | 用户操作 | 1 | yield | 照常写入 | 记录，可以撤销；另外可以在 10 分钟内整体撤销 |
| 网站绑定的预设 | 焦点窗口活动标签页中的主视频在绑定网站上播放 | 2 | yield | 跟随 SDR 开启时不写入中间灰 | 记录，可以撤销 |
| 时段（夜间或其余时间） | 进入新的时段 | 3 | yield | 跟随 SDR 开启时不写入中间灰 | 记录，可以撤销 |
| 跟随 SDR | Windows SDR 白电平发生变化 | 由事件驱动，只写入中间灰 | 不涉及 | | 记录，可以撤销 |
| “只关 HDR”借用 | 主视频需要关闭 HDR | 不参与排序，只临时修改 `enabled` | | | 记录，不可撤销 |

### 配置档、NVIDIA 预设、备份

| 概念 | 内容 | 用途 |
|---|---|---|
| 配置档 | 一整套观看方案：`PROFILE_BEHAVIOR_KEYS` 中的行为设置（默认状态、网页全屏、记住手动切换、白底检测、灵敏度、夜间、护眼、屏幕提示、按钮、面板方式、只关 HDR），可选包含网站规则（最多 1000 条），可选包含 NVIDIA 参数（HDR 开关和四项参数、超分、指示器） | 一键切换，10 分钟内可以撤销 |
| NVIDIA 预设 | 只包含显卡参数 | 用于时段、网站绑定和快捷键自动切换 |
| 备份 | 整个扩展的数据（设置、预设、配置档、记住的视频） | 用于更换电脑；导入时会覆盖现有数据 |

- 配置档存放在 `storage.local` 的 `profiles` 中（`{v:1, list, activeId}`），最多 20 个，名称最多 24 个字，只由 background 的 `profilesTxn` 写入。`ui`、`nv`（包括网站绑定，因为预设 ID 只在本机有效）和 `updateCheck` 不进入配置档；结构测试保证这两组键的并集正好是 `DEFAULT_SETTINGS` 的全部键。
- `profile` 消息包括：`save`（同名时需要带 `overwrite` 才会覆盖；需要保存 NVIDIA 部分时，在锁内读取一次，并使用借用前的开关值）；`apply`（先写入 `profileUndo`，带有 NVIDIA 部分时预先写入 `nvLastPhase`，然后执行 `settingsTxn(profileApply)`，再执行 `nvWrite(source:'profile')`；HDR 不可用时只写入超分，并给出提示）；`next`（对应命令 `next-profile`）；`undo`（在 10 分钟内有效，设置部分整体写回，NVIDIA 部分只恢复实时值仍等于写入值的字段）；`rename`；`delete`；`import`（`profilesMerge`：全部换用新 ID，重名时改为“名称 (2)”）。
- 配置档文件的格式为 `rtx-hdr-switch-profiles` v1，“复制为文本”也使用同一格式；遇到版本更新的文件时返回 `newer`。
- 弹窗的“规则”页签中有配置档卡片：点击即可套用；当前配置档与实际设置有差异时标注“已修改”；可以复制、删除；保存时可以选择是否包含网站规则和 NVIDIA 参数；可以粘贴导入；10 分钟内可以撤销切换。选项页（“配置档与备份”）支持套用、重命名、导出单个或全部配置档、从文件导入。面板支持套用、保存和撤销。
- 备份格式仍为 `version: 1`，只增加了可选的顶层字段 `profiles`。1.3 版导入不含 `profiles` 的备份时，保留现有配置档；含有 `profiles` 时整体替换。导入时清除 `storage.local` 中的 `nvLastPresetId`、`nvSite`、`nvLastPhase`、`nvLastSdrWhite`，以及 `storage.session` 中的 `profileUndo`。1.2 版导入 1.3 版的备份时，会忽略 `profiles`、`nv.sitePresets` 和 `updateCheck`，`defaultState: 'fullscreen'` 退回为 `on`，网站规则中的 `fullscreen` 会被丢弃，但不会报错。

### 按网站切换 NVIDIA 预设（`nv.sitePresets`）

- 触发条件：标签页激活、窗口焦点变化、收到报告、活动标签页的网址变化、标签页关闭、`nv.sitePresets` 或 `nv.presets` 变化、闹钟 `nv-site` 触发。经过 2 秒防抖后执行 `siteEvaluate()`，同一时间只运行一个实例。
- 目标是焦点窗口活动标签页的最佳 frame；网站按顶层域名匹配，没有匹配时再查找 frame 自身的域名（`sitePresetFor`）。
- `nvSiteDecide`：当绑定网站上的主视频正在播放时，套用预设；同一网站、同一预设时不执行任何操作；切换到另一个绑定网站时，保留第一次进入前的基准值，只补上新预设多写入的字段；仍在绑定网站上但没有视频时，等待 30 秒（使用一次性闹钟，不受 service worker 回收的影响），然后离开；切换到未绑定的网站、浏览器内部页面，或者绑定被删除时，离开。
- 离开时：如果时段已经变化，并且新时段选择了预设，就套用时段预设；否则只恢复实时值仍等于当时写入值的字段（`nvSiteRestorePatch`），记为 `site` 来源，标签（`label`）为 `restore`。
- 网站预设生效期间发生手动修改（任何用户来源）时：记为 `manual`，这个网站不再重新套用预设，离开时只恢复未被手动修改过的字段。生效期间，时段切换让位于网站预设。
- 记录 `nvSite` 存放在 `storage.local` 中，浏览器启动和扩展安装时重新判断，因此离开时能够恢复。同一网站的套用失败只提示一次。
- 界面：弹窗“规则”页签中有“本网站套用”下拉框和已绑定网站的列表（可以取消绑定）。

### 诊断页（`diag.html`）

- 入口：弹窗底栏的“诊断”（带有 `?tab=<当前标签页>`）和选项页的右上角。
- 内容：本地组件（`hello`、版本、`caps`、dll、`nvHostCheck` 的结论和处理办法）、NVIDIA 原始状态、显示器、“只关 HDR”的借用情况、当前标签页各个 frame 的报告、NVIDIA 修改记录（新记录在上，已撤销的记录加删除线）、闹钟、存储用量（local 和 session 的字节数、视频记忆条数及其上限 2000）、更新检查、设置。
- “复制诊断信息”默认用 `L.diagRedact` 脱敏：域名、网址以及 `sites` 和 `sitePresets` 的键替换为 `host#n`；视频 key 和 `v:*` 替换为 `key#n`；显示器 ID 和名称以及 `nv.displayId` 替换为 `display#n`；路径中的 `C:\Users\<用户名>` 替换为 `<user>`；同一个值总是对应同一个编号。勾选“包含网址和设备名”时，显示和复制原文。
- `diag {op:'snapshot', tabId?}` 只接受 popup、options 和 diag 发来的消息。

### 更新检查

- 只对解压安装（`management.getSelf().installType === 'development'`）运行：从商店安装的扩展由浏览器自动更新，其他安装方式不检查更新。设置项为 `updateCheck`（默认开启；对应弹窗“规则”页签中的“检查新版本”，只在解压安装时显示）。
- 闹钟 `update-check`：在扩展安装或浏览器启动 2 分钟后开始，每 180 分钟触发一次；距上次成功检查不满 24 小时（`updateDue`），或者仍处于退避期内时，不发送请求；离线或超时时，等到下一轮闹钟再试。诊断页的“立即检查”不受 24 小时间隔的限制。
- 请求：`GET https://api.github.com/repos/miniso7892-dotcom/rtx-hdr-switch/releases/latest`，参数为 `credentials:'omit'`、`referrerPolicy:'no-referrer'`、`cache:'no-store'`，并带上 `If-None-Match`（ETag），超时时间为 15 秒。不发送任何设置、浏览记录或标识信息；GitHub 能看到 IP 地址和浏览器的 UA。
- 结果处理（`L.updateAfter`）：状态码为 200 时，用 `parseRelease` 校验（排除 `draft` 和 `prerelease`；发布页和 zip 的地址必须位于本仓库的 releases 下），并保存 ETag；状态码为 304 时，只更新检查时间；状态码为 403 或 429 时，按 `X-RateLimit-Reset` 或 `Retry-After` 退避；状态码为 5xx 时，退避时间依次为 3、6、12、24 小时；离线或超时时，不改变检查时间。状态存放在 `storage.local` 的 `updateState` 中，不进入备份。
- 提醒：当存在比当前版本更新（`semverCmp`）、未被跳过，并且不处于 7 天免打扰期内的版本时，在工具栏图标右上角绘制一个小圆点（`icon-draw.js` 的 `dot`，不占用角标文字），在弹窗“规则”页签顶部显示提醒卡片（包括先导出备份、下载 zip、打开发布页、跳过此版本，以及表示 7 天内不再提醒的“×”），“规则”页签的标签上带一个小圆点，底栏的版本号变为主题色。
- 解压安装的更新方法：用新版 zip 中的文件覆盖原文件夹中的文件，再在扩展管理页点击“重新加载”。如果移除扩展后再重新加载，设置会被清空。

### 消息（1.3 版之后的完整列表）

| `type` 与 `op` | 允许的发送方 | 作用 |
|---|---|---|
| `report` | 内容脚本 | 与之前相同；回复中可能带有 `remind`、`topFs`，以及发送方自己的 `tabId` 和 `frameId` |
| `popup-get` | 扩展页面（面板只能查询自己所在的标签页） | 获取最佳 frame |
| `settings-patch` | 扩展页面可修改全部字段；播放器 frame 中的内容脚本和已登记的面板按白名单修改 | 交给 `settingsTxn` 执行 |
| `nv`：`hello`、`get`、`display`、`set` | 扩展页面（面板只能使用 `hello` 和 `get`） | 页面端口不可用时的桥接；`set` 通过 `nvWrite` 写入 |
| `nv-op`：`set {patch, mode}`、`apply-preset {id}`、`undo`、`follow-check` | 扩展页面（面板不能使用 `follow-check`） | 写入服务 |
| `nv-log` | popup、面板 | 记录页面通过自己的端口完成的写入 |
| `profile` | 扩展页面（面板只能使用 `list`、`apply`、`next`、`undo`、`save`） | 配置档服务 |
| `backup`：`import` | popup、options、diag | 由 background 再校验一遍，然后在 `settingsTxn` 和 `profilesTxn` 中导入 |
| `update`：`state`、`check`、`skip`、`snooze` | popup、options、diag | 更新检查 |
| `diag`：`snapshot` | popup、options、diag | 诊断快照 |
| `hdr-only`：`drop` | popup、options、diag | 释放借用 |
| `panel-claim {nonce}` | 未登记的 `panel.html` | 面板认领自己的 frameId |
| `panel-frame`：`add`、`open`、`close`、`remove` | 播放器网站上的内容脚本 | 面板登记 |

background 发往内容脚本的消息有：`command`（`toggle-hdr`、`forget-video`、`peek`）、`osd`、`fs-hint`。

### 测试

`node test/lib.test.js`（同步执行，测试纯函数和源码结构）新增以下内容：`decide` 的 `tab` 和 `fullscreen` 两级、`createHoldGesture`、`tabOffer`、`fsHintTarget`、设置补丁和白名单、`nvUnleased`、`nvLeaseAdjust`、`nvAutoGuard`、`nvPatchDelta`、修改记录与撤销、网站预设的判定与恢复、配置档的全部功能、更新检查的版本比较和退避、`nvHostCheck`、`diagRedact`、`placeAbove`、`placeBelow`、`panelWidth`，以及 `playerSite` 与 `PLAYER_BARS` 和 WAR 的一致性。结构测试覆盖以下内容：面板握手；登记只在显示时启用；`isTrusted` 检查；面板写入门控；只有 background 写入 `settings` 和 `profiles`；覆盖在视频上的 CSS 不使用 `filter`、`backdrop-filter`、`transform` 和透明度过渡；manifest 与 `_locales`；i18n 中英文键一致且占位符相同；界面文字不含“·”和含糊词。service worker 逻辑在开发时使用 `vm` 模块中的模拟 `chrome.*` 接口和模拟本地组件验证；面板、按钮、对比功能和新增网站用一次性的无头 Chrome（CDP `Extensions.loadUnpacked`，使用去掉了 `nativeMessaging` 的副本，并在 service worker 中换成模拟的 `hostCall`）以游客身份在真实网站上验证，YouTube 嵌入播放器和 B 站直播另有本地复刻页面。
