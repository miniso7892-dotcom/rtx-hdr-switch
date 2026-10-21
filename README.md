# RTX HDR Switch

English | [简体中文](README.zh-CN.md)

A Chrome / Edge extension (Manifest V3) that turns NVIDIA **RTX Video HDR** on or off **per video**. Keep HDR for videos where you want the extra brightness; switch white-background slides, screen recordings and long viewing sessions back to SDR. Comes with a keyboard shortcut, per-video memory, automatic detection of white-background videos, a night window and a continuous-viewing reminder.

> **Turning HDR off for a video also turns off RTX Video Super Resolution (VSR) for that video.** This is a Chrome limitation; a web page cannot disable one without the other.
>
> **The per-video switch can only turn RTX Video HDR *off*, it cannot turn it on.** RTX Video HDR must be enabled globally, in the NVIDIA App or, with the optional native host installed, in the popup's [NVIDIA settings panel](#nvidia-settings-panel); the per-video switch blocks it for the videos you don't want it on.

The user interface (popup, on-screen messages) is in Simplified Chinese. The tables below give English translations of the labels.

## Features

- **Per-video toggle**: `Alt+H` switches RTX Video HDR for the video you are watching. Works in windowed and fullscreen playback and takes effect immediately, without reloading the page.
- **Remembers your choice** per video (up to 2000 videos; the oldest are pruned). Videos are recognized by ID on YouTube, Bilibili, Tencent Video, iQIYI and Twitch, and by a cleaned-up URL (tracking parameters removed) everywhere else.
- **Per-site rules**: always on / always off / follow the other rules.
- **Automatic white-background detection** (`Alt+Shift+H` toggles it): samples the playing video every 1.5 s and turns HDR off after about 3 s of bright frames. Choose "off only" (recommended) or "on and off", and low / medium / high sensitivity.
- **Night window**: HDR off by default during a time range you choose (e.g. 23:00–07:00, crossing midnight is fine).
- **Continuous-viewing reminder**: counts the time spent watching with HDR on (across videos, autoplay and tabs) and reminds you to take a break; optionally switches to SDR when the time is up.
- **Toolbar badge**: green **HDR** / grey **SDR** / dark-yellow **DRM** for the main video of the current tab.
- **NVIDIA settings panel** (optional, needs a small local helper): change NVIDIA's global RTX Video settings from the popup, save presets, switch presets by time of day. See [NVIDIA settings panel](#nvidia-settings-panel).
- **No network access, no data collection** (see [Privacy](#privacy)).

## How it works

Chrome only sends a video through the NVIDIA video processor (which applies RTX Video HDR and VSR) when the video is promoted to a DirectComposition overlay. Any CSS `filter` on the `<video>` element makes Blink create a separate render surface, and a video inside a non-root render pass is not promoted to an overlay.

So to turn HDR off, the extension sets an inline `filter: brightness(0.9999) !important` on that `<video>` element (appended after the page's own inline filter, if it has one). The filter is invisible on 8-bit content. To turn HDR back on, it restores the page's original inline `filter`.

Measured on Chrome 155 with NVIDIA driver 617.42, using an FP16 desktop capture: with RTX Video HDR active, white in the video reached about 1000 nits; with the filter applied, it dropped to the Windows SDR white level (set by the "SDR content brightness" slider). Removing the filter restored HDR immediately. This held in both windowed and `video.requestFullscreen()` playback.

The design notes and the Chromium source references are in [SPEC.md](SPEC.md) (Chinese).

## Requirements

- An NVIDIA RTX GPU with **RTX Video HDR enabled globally**: NVIDIA App → **System** → **Video** → **RTX Video Enhancement** → HDR (Super Resolution is optional), or the HDR switch in the popup's [NVIDIA settings panel](#nvidia-settings-panel).
- Windows HDR turned on: Settings → System → Display → **Use HDR**.
- Hardware acceleration enabled in the browser (restart the browser after changing it):
  - Chrome: `chrome://settings/system` → **Use graphics acceleration when available**
  - Edge: `edge://settings/system` → **Use graphics acceleration when available**
- Chrome or Edge 116 or newer.

## Installation

The extension is not on the Chrome Web Store or Edge Add-ons yet, so you load it unpacked.

1. Get the code: `git clone` this repository, or click **Code → Download ZIP** on GitHub and extract it. Put it somewhere you won't move it.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on developer mode:
   - Chrome: **Developer mode** toggle, top right
   - Edge: **Developer mode** toggle, left sidebar
4. Load the extension:
   - Chrome: click **Load unpacked**
   - Edge: click **Load unpacked**

   Select the `rtx-hdr-switch` folder, the one that directly contains `manifest.json`. (A ZIP download may extract to a nested folder of the same name.)
5. Pin the extension to the toolbar (puzzle-piece icon → pin) so you can see the badge.

Notes:

- **Don't move, rename or delete the folder after installing.** The browser loads the extension from it on every start. To move it, remove the extension first, move the folder, then load it again.
- Google Chrome stable ignores the `--load-extension` command-line flag, so the steps above are the only way to install it there.
- On install, update or reload, the extension injects itself into tabs that are already open. If a page doesn't respond (for example a tab that was asleep), reload that page.
- For local files (`file://`), turn on **Allow access to file URLs** on the extension's details page, then reload the page.

## Check that it works

The badge only tells you whether the extension is blocking RTX Video HDR; it can't tell whether NVIDIA is actually processing the video. Check once like this:

1. Open NVIDIA App → **System** → **Video** and put it next to the browser. (NVIDIA App doesn't refresh this page by itself: if you change settings in the popup's NVIDIA section meanwhile, leave and re-enter the Video page before you read or move anything there. See [Good to know](#good-to-know).)
2. Play an ordinary (not DRM-protected) video, e.g. on YouTube or Bilibili. Windowed playback is fine.
3. Under RTX Video Enhancement, the HDR **Status** should be active while the extension shows **HDR**.
4. Press `Alt+H` (or click 切换 / *Toggle* in the popup). Within a few seconds the status should go inactive and whites in the video should get visibly dimmer.
5. Press `Alt+H` again: the status goes back to active.

If the status is inactive from the start, RTX Video HDR itself isn't working and the extension isn't involved. Check the [requirements](#requirements) (especially hardware acceleration and the NVIDIA App setting), or try another video.

## Usage

### Badge

| Badge | Meaning |
|---|---|
| green **HDR** | The extension is not blocking RTX Video HDR (whether it is actually active is shown in the NVIDIA App) |
| grey **SDR** | The extension has turned RTX Video HDR off for this video |
| dark-yellow **DRM** | DRM-protected video; the extension can't control it |
| none | No video found on this tab |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+H` | Toggle RTX Video HDR for the current video (counts as a manual choice; remembered by default) |
| `Alt+Shift+H` | Turn white-background detection on/off |
| not set | Forget the current video's remembered choice |
| not set | Apply the next NVIDIA preset (needs the [native host](#install-the-native-host)) |

Shortcuts only work while a browser window has focus. Change them from the popup (修改快捷键 / *Change shortcuts*) or at `chrome://extensions/shortcuts` (`edge://extensions/shortcuts` in Edge). If another extension already uses a key, the browser may not assign it; set it there by hand.

When the state changes, a small label appears in the top-left corner of the video, e.g. `RTX HDR：开（手动）` (*on, manual*) or `RTX HDR：关（自动检测·白底）` (*off, auto-detected white background*).

### Popup

| Section | What it does |
|---|---|
| 当前视频 *Current video* | HDR on/off and the reason, 切换 *Toggle* and 清除此视频记忆 *Forget this video* buttons, the video's key, and the last measured brightness / white ratio |
| NVIDIA 视频设置（全局） *NVIDIA video settings (global)* | NVIDIA's global RTX Video settings and presets, see [NVIDIA settings panel](#nvidia-settings-panel) |
| 本网站 *This site* | 跟随规则 *Follow rules* / 总是开 HDR *Always on* / 总是关 HDR *Always off* |
| 自动检测白底/高亮视频 *Auto-detect white/bright videos* | 关闭 *Off* / 只自动关闭 *Turn off only* (recommended) / 自动开关 *Turn off and on*; sensitivity 低 / 中 / 高 *low / medium / high* |
| 夜间护眼 *Night mode* | HDR off by default within a time range; NVIDIA presets to apply in and outside that range |
| 连续观看提醒 *Viewing reminder* | Minutes of HDR viewing before a break reminder (0 = off); 到时自动切回 SDR *switch to SDR when time is up* |
| 默认 *Default* | On or off when no rule applies |
| 其他 *Other* | Remember manual choices per video; show on-screen labels |
| 快捷键 *Shortcuts* | Current key bindings |

### Decision order

For each video, the first matching rule wins (the popup shows which one as the reason):

1. **Manual** (手动): you toggled this video since the page was opened. The reminder's automatic switch to SDR also sits at this level but is not remembered.
2. **Remembered video** (已记住此视频): a choice you saved earlier.
3. **Site rule** (网站规则): the 本网站 setting. For an embedded player, the site of the tab's top-level page counts.
4. **Night mode** (夜间护眼): within the night window → off.
5. **Auto-detect** (自动检测(白底)): the picture is judged white/bright → off.
6. **Default** (默认).

On YouTube (mini player) and Twitch (mini player), a video that keeps playing after you navigate to the home page or a directory page keeps its identity, so its remembered and manual choices still apply.

### White-background detection

The main video is sampled as soon as it starts playing and then every 1.5 s, scaled down to 64×36 to measure average brightness and the share of white pixels. Three bright frames in a row (about 3 s) turn HDR off.

- **Turn off only** (只自动关闭): once a video is judged bright, it stays off while the page is open, so mid-roll ads, quality changes and sensitivity changes don't flash it back to HDR.
- **Turn off and on** (自动开关): six clearly dark frames in a row turn HDR back on; after any automatic switch the state is held for at least 10 s.
- All-black frames (transitions, loading) are ignored.
- Detection runs only when no manual, remembered, site or night rule applies, and pauses while the video is paused or the tab is hidden.

### Viewing reminder

- Counts time spent watching with HDR not blocked. **Changing video, autoplay and opening new tabs keep counting**; time paused, in the background or in SDR doesn't count.
- The count resets only after **more than 5 minutes without watching** (paused or page closed).
- When time is up, a message on the video suggests a break, and the count restarts.
- With *switch to SDR when time is up* checked, the current video and every following video (next video, other tabs) stay in SDR until you stop watching for over 5 minutes, switch HDR back on manually (`Alt+H` or the popup), or turn the option off.

## NVIDIA settings panel

[简体中文说明](README.zh-CN.md#nvidia-参数面板)

Version 1.1.0 adds a section 「NVIDIA 视频设置（全局）」 (*NVIDIA video settings (global)*) to the popup. It reads and changes the same global settings that NVIDIA App shows under **System** → **Video** → **RTX Video Enhancement**, so changes apply to every video, in every browser and app, not only the current tab:

- **HDR** on/off with NVIDIA's active/inactive status, **peak brightness**, **middle grey**, **contrast** and **saturation**.
- **Super Resolution**: off / auto / manual quality (very low to high), **GPU priority** in auto mode, and the on-video status indicator.
- **Presets**: save the current values under a name, apply them later, delete them (deleting asks for a second click).
- **Day/night presets**: under 夜间护眼 (*Night mode*), choose a preset for the night window (夜间套用 NVIDIA 预设) and one for the rest of the day (其余时间套用). They follow the night window's times whether or not Night mode itself is on, and are applied once when the period starts; changes you make afterwards are kept until the next period.
- **Shortcut** 切换到下一个 NVIDIA 预设 (*apply the next NVIDIA preset*). No key is assigned by default; set one on the shortcuts page.

Unlike the per-video switch, which can only block HDR for one video, this panel switches NVIDIA's global RTX Video HDR on and off.

### Install the native host

A browser extension can't call NVIDIA's settings interface directly, so the panel talks to a small helper program (a native messaging host) in the `native-host` folder. Without it the panel shows 未安装本地组件 (*native host not installed*) and the rest of the extension works as before.

1. Install the extension from this folder (see [Installation](#installation)). Load the folder as it is: the `key` in `manifest.json` fixes the extension ID to `omgekmljdifpghaimigdbbbcmnjddmdd`, and the helper only accepts that ID.
2. Double-click `native-host\install.cmd`. It builds `rtx_hdr_host.exe` with the C# compiler that comes with Windows (.NET Framework 4.x) and registers it for Chrome, Edge and Chromium for the current user (`HKCU`). No admin rights are needed.
3. Close and reopen the popup. The NVIDIA section should now show the current values.

Requirements: Windows 10/11 (x64) and NVIDIA App, whose `nvcpl.dll` the helper uses. Keep the folder on a path without `&`, `^` or `%`: the browser starts the helper through `cmd.exe`, which breaks on these characters.

To uninstall, double-click `native-host\uninstall.cmd` (it removes the registry entries), then delete the folder. If you move the folder, run `install.cmd` again.

### Good to know

- **NVIDIA App shows the old values until you leave its Video page and open it again.** While that page shows old values, don't move its sliders: NVIDIA App writes back everything it has on screen and undoes the popup's changes.
- The helper uses NVIDIA App's own `nvcpl.dll` through an undocumented interface. It was tested with NVIDIA App 11.0.9 and driver 617.42; a later NVIDIA App update may break it. The popup then shows an error and the rest of the extension keeps working.
- Peak brightness above about 1000 nits made no difference in testing: driver 617.42 capped the output at about 1000 nits. The popup shows a hint when you go above 1000.
- The helper runs only while the popup is open, or for a moment when a preset is applied. It runs locally and makes no network connections.

## Limitations

- **Turning HDR off also turns off VSR** for that video (Chrome limitation, see above).
- **The per-video switch can only turn RTX Video HDR off.** If RTX Video HDR is not enabled globally (in the NVIDIA App or the popup's [NVIDIA settings panel](#nvidia-settings-panel)), or hardware acceleration is off, there is no HDR to switch, even when the badge says **HDR**.
- **DRM-protected videos can't be controlled.** They are presented through a Media Foundation overlay that CSS doesn't affect, and their frames can't be read for detection. The badge shows **DRM**. They still count towards the viewing reminder.
- **Picture-in-Picture**: the browser sends the video straight to the PiP window, so the switch may not apply there. It works again once the video is back in the page.
- **Cross-origin videos without CORS** can't be sampled, so auto-detection doesn't work for them. Manual toggling, memory and site rules still work.
- Some pages keep rewriting the video's style. The extension backs off, shows *页面不断改写视频样式，无法关闭* (the page keeps rewriting the video style) as the reason, and retries later, or immediately when you toggle manually.
- If a page already puts a `filter` on the video (e.g. a player's picture-adjustment feature), the video isn't on an overlay to begin with, so RTX Video HDR isn't active anyway. The extension keeps the page's filter and appends its own.
- In element fullscreen (`video.requestFullscreen()`), the on-screen label is hidden behind the browser's fullscreen layer. Site players' own fullscreen modes are fine.
- Browser-internal pages (`chrome://`, the extension stores) are not supported.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says 还没有连接到此页面 (*not connected to this page yet*) | Reload the page. Tabs that were open or asleep before install may not have been injected. |
| Popup says no video detected / video not in view | Make sure the video is on the page (some sites create it only after you press play) and scrolled into view. |
| Green **HDR** badge but the picture isn't bright / NVIDIA App shows inactive | RTX Video HDR itself isn't working. Check the [requirements](#requirements). |
| Brightness doesn't change after switching off | First confirm RTX Video HDR works (see [Check that it works](#check-that-it-works)). DRM and PiP videos can't be controlled. |
| Shortcut does nothing | Check that a key is assigned on the shortcuts page and doesn't clash with another extension, and that the browser window has focus. |
| A white-background video isn't switched off | Make sure detection isn't set to *Off* and no higher-priority rule applies; try a higher sensitivity. Cross-origin videos can't be detected. |
| Extension stops working / "could not load" | Check that the `rtx-hdr-switch` folder hasn't been moved or deleted. |
| NVIDIA section says 未安装本地组件 (*native host not installed*) | Run `native-host\install.cmd` (see [Install the native host](#install-the-native-host)), then reopen the popup. Run it again after moving the folder. |
| NVIDIA section says 本地组件只接受仓库里这份扩展 (*the helper only accepts this repository's extension*) | The extension ID doesn't match. Load this folder unpacked as it is; a copy without the `key` in `manifest.json`, or a repacked copy, gets a different ID. Running `install.cmd` again doesn't help. |
| NVIDIA section says 未找到 NVIDIA App（nvcpl.dll） (*NVIDIA App not found*) | Install NVIDIA App. |
| NVIDIA section says 本地组件版本不匹配 (*helper version mismatch*) | After updating the extension, run `native-host\install.cmd` again. |
| NVIDIA App still shows the old values | Leave NVIDIA App's Video page and open it again (see [Good to know](#good-to-know)). |

## Development

No build step and no dependencies. The tests use only Node's built-in `node:assert`.

```sh
node test/lib.test.js        # unit tests: decisions, video keys, auto-detection, filter stacking, viewing timer, settings, manifest
python tools/make_icons.py   # regenerate icons/ (needs Pillow)
native-host\build.cmd                      # build rtx_hdr_host.exe (in-box C# 5 compiler)
node native-host/test/host.test.mjs        # native host tests (read-only)
node native-host/test/host.test.mjs --live # plus one reversible write (middle grey +1, then restored)
```

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: badge, shortcuts, viewing timer, injection into open tabs on install |
| `lib.js` | Pure logic shared by the content script, popup, service worker and tests |
| `content.js` | Content script: finds videos, applies the filter, samples frames, on-screen labels |
| `popup.html` / `popup.css` / `popup.js` | Popup |
| `native-host/` | Native messaging host for the NVIDIA settings panel: `RtxHdrHost.cs`, build / install / uninstall scripts, host manifest, tests |
| `SPEC.md` | Design spec and measurements (Chinese) |

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, remembered videos and per-tab state |
| `scripting` | Inject the content script into tabs that were already open when the extension was installed or updated |
| `tabs` | Look up open tabs and their URLs (injection on install, shortcuts, popup, badge) |
| `nativeMessaging` | Talk to the optional local helper that reads and writes NVIDIA's RTX Video settings |
| `alarms` | Check once a minute whether a day/night NVIDIA preset is due (only while one is selected) |
| `<all_urls>` | Videos can be on any site, including embedded players in iframes |

## Privacy

The extension makes no network requests and collects no data. Settings and remembered videos are stored locally in `chrome.storage.local`; per-tab state and the viewing timer live in `chrome.storage.session` and are cleared when the browser restarts. Auto-detection scales the video frame down to 64×36 in memory to measure brightness; frames are never stored or sent anywhere. The optional native host runs only on your PC, talks only to the extension and to NVIDIA App's `nvcpl.dll`, and makes no network connections.

## License

[MIT](LICENSE)

## Disclaimer

This is an independent open-source project. It is not affiliated with, endorsed by or sponsored by NVIDIA Corporation. NVIDIA, RTX and GeForce are trademarks of NVIDIA Corporation. Chrome is a trademark of Google LLC; Microsoft Edge is a trademark of Microsoft Corporation. These names are used only to describe compatibility.
