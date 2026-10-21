# RTX HDR Switch

English | [简体中文](README.zh-CN.md)

<p align="center"><img src="docs/media/banner-en.png" alt="RTX HDR Switch: per-video HDR control in your browser" width="100%"></p>

<p align="center"><img src="docs/media/demo.gif" alt="One click turns HDR off for a white lecture video while the movie next to it stays HDR" width="100%"><br><sub>Tokyo photo in the demo by <a href="https://www.freepik.com/free-photo/aerial-view-tokyo-cityscape-with-fuji-mountain-japan_10824379.htm">tawatchai07 on Freepik</a></sub></p>

<p align="center"><b><a href="https://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/latest">Download the latest release</a></b></p>

A Chrome / Edge extension (Manifest V3) that turns NVIDIA **RTX Video HDR** on or off **per video**. Keep HDR for videos where you want the extra brightness; switch white-background slides, screen recordings and long viewing sessions back to SDR. Comes with keyboard shortcuts, per-video memory, automatic detection of white-background videos, a night window and a continuous-viewing reminder. With the optional local helper you can also tune NVIDIA's RTX Video settings from the popup, match them to your Windows SDR brightness in one click, and turn off HDR only while keeping Super Resolution. The interface is in English and Chinese, with a selectable theme color.

> **Switching HDR off for one video also switches off RTX Video Super Resolution (VSR) for that video** (a Chrome limitation). To keep VSR, turn on [Turn off HDR only, keep super resolution](#turn-off-hdr-only-keep-super-resolution) in the Rules tab (needs the local helper; it switches NVIDIA's global HDR).
>
> **The per-video switch can only turn RTX Video HDR *off*, it cannot turn it on.** RTX Video HDR must be enabled globally, in the NVIDIA App or, with the local helper installed, in the popup's NVIDIA tab (see [NVIDIA settings panel](#nvidia-settings-panel)).

## Features

- **Per-video toggle**: `Alt+H` switches RTX Video HDR for the video you are watching. Works in windowed and fullscreen playback and takes effect immediately, without reloading the page.
- **HDR button in the player's control bar** on Bilibili, YouTube, Twitch and Tencent Video: one click does what `Alt+H` does, and the button shows whether HDR is on (see [Player button](#player-button)).
- **Remembers your choice** per video (up to 2000 videos; the oldest are pruned). Videos are recognized by ID on YouTube, Bilibili, Tencent Video, iQIYI and Twitch, and by a cleaned-up URL (tracking parameters removed) everywhere else.
- **Per-site rules**: always on / always off / follow the other rules.
- **Automatic white-background detection** (`Alt+Shift+H` toggles it): samples the playing video every 1.5 s and turns HDR off after about 3 s of bright frames.
- **Night window** and a **continuous-viewing reminder** that can switch to SDR when the time is up.
- **Toolbar badge**: **HDR** in the theme color / black **SDR** / grey **DRM** for the main video of the current tab.
- **English / Chinese interface** (follows the browser by default) and **6 theme colors** plus a custom one; the toolbar icon follows the theme.
- **NVIDIA settings panel** (optional local helper): peak brightness, middle grey, contrast, saturation, Super Resolution, presets and day/night presets; **Windows SDR brightness sync**; middle grey shortcuts `Alt+Shift+↑/↓`; **turn off HDR only, keep VSR**.
- **Backup**: export and import settings, presets, site rules and remembered videos.
- **No network access, no data collection** (see [Privacy](#privacy)).

## How it works

Chrome only sends a video through the NVIDIA video processor (which applies RTX Video HDR and VSR) when the video is promoted to a DirectComposition overlay. Any CSS `filter` on the `<video>` element makes Blink create a separate render surface, and a video inside a non-root render pass is not promoted to an overlay.

So to turn HDR off, the extension sets an inline `filter: brightness(0.9999) !important` on that `<video>` element (appended after the page's own inline filter, if it has one). The filter is invisible on 8-bit content and hardware decoding is not affected. To turn HDR back on, it restores the page's original inline `filter`.

Measured on Chrome 155 with NVIDIA driver 617.42, using an FP16 desktop capture: with RTX Video HDR active, white in the video reached about 1000 nits; with the filter applied, it dropped to the Windows SDR white level (set by the "SDR content brightness" slider). Removing the filter restored HDR immediately, in both windowed and `video.requestFullscreen()` playback.

The design notes and the Chromium source references are in [SPEC.md](SPEC.md) (Chinese).

## Requirements

- An NVIDIA RTX GPU with **RTX Video HDR enabled globally**: NVIDIA App → **System** → **Video** → **RTX Video Enhancement** → HDR (Super Resolution is optional), or the HDR switch in the popup's NVIDIA tab.
- Windows HDR turned on: Settings → System → Display → **Use HDR**.
- Hardware acceleration enabled in the browser (restart the browser after changing it):
  - Chrome: `chrome://settings/system` → **Use graphics acceleration when available**
  - Edge: `edge://settings/system` → **Use graphics acceleration when available**
- Chrome or Edge 120 or newer.

## Installation

The extension is not on the Chrome Web Store or Edge Add-ons yet, so you load it unpacked.

1. Get the code: `git clone` this repository, or click **Code → Download ZIP** on GitHub and extract it. Put it somewhere you won't move it.
2. Open the extensions page: `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Turn on **Developer mode** (top right in Chrome, left sidebar in Edge).
4. Click **Load unpacked** and select the `rtx-hdr-switch` folder, the one that directly contains `manifest.json`. (A ZIP download may extract to a nested folder of the same name.)
5. Pin the extension to the toolbar (puzzle-piece icon → pin) so you can see the badge.

Notes:

- **Don't move, rename or delete the folder after installing.** The browser loads the extension from it on every start. To move it, remove the extension first, move the folder, then load it again.
- Google Chrome stable ignores the `--load-extension` command-line flag, so the steps above are the only way to install it there.
- On install, update or reload, the extension injects itself into tabs that are already open. If a page doesn't respond (for example a tab that was asleep), reload that page.
- For local files (`file://`), turn on **Allow access to file URLs** on the extension's details page, then reload the page.
- Upgrading from 1.0: since 1.1 the `key` in `manifest.json` fixes the extension ID, so the browser treats it as a new extension and 1.0's settings don't carry over. From 1.2 on you can export and import a backup in the Rules tab.

## Check that it works

The badge only tells you whether the extension is blocking RTX Video HDR; it can't tell whether NVIDIA is actually processing the video. Check once like this:

1. Open NVIDIA App → **System** → **Video** and put it next to the browser. (NVIDIA App doesn't refresh this page by itself, see [Good to know](#good-to-know).)
2. Play an ordinary (not DRM-protected) video, e.g. on YouTube or Bilibili. Windowed playback is fine.
3. Under RTX Video Enhancement, the HDR **Status** should be active while the extension shows **HDR**.
4. Press `Alt+H` (or click **Switch to SDR** in the popup). Within a few seconds the status should go inactive and whites in the video should get visibly dimmer.
5. Press `Alt+H` again: the status goes back to active.

If the status is inactive from the start, RTX Video HDR itself isn't working and the extension isn't involved. Check the [requirements](#requirements), or try another video.

## Usage

### Badge

| Badge | Meaning |
|---|---|
| **HDR** in the theme color (lavender by default) | The extension is not blocking RTX Video HDR (whether it is actually active is shown in the NVIDIA App) |
| black **SDR** | The extension has turned RTX Video HDR off for this video |
| grey **DRM** | DRM-protected video; the extension can't control it |
| none | No video found on this tab |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+H` | Toggle RTX Video HDR for the current video (counts as a manual choice; remembered by default) |
| `Alt+Shift+H` | Turn white-background detection on/off |
| `Alt+Shift+↑` / `Alt+Shift+↓` | NVIDIA middle grey +5 / −5 (needs the [local helper](#install-the-local-helper)) |
| not set | Forget the current video's remembered choice |
| not set | Switch to the next NVIDIA preset (needs the local helper) |

Shortcuts only work while a browser window has focus. Change them from the Rules tab (**Change**) or at `chrome://extensions/shortcuts` (`edge://extensions/shortcuts` in Edge). If another extension already uses a key, the browser may not assign it; set it there by hand.

When the state changes, a small label appears in the top-left corner of the video, e.g. *RTX HDR: on (manual)*, *RTX HDR: off (auto · white)* or *Middle grey 70 nits (+5)*.

### Player button

On these sites an **HDR** button sits among the player's own buttons on the right of its control bar:

- **Bilibili**: video, bangumi, list and festival pages, and Bilibili players embedded in other sites
- **YouTube**: the watch page
- **Twitch** and **Tencent Video**

| Button | Meaning |
|---|---|
| solid **HDR** badge | The extension is not blocking RTX Video HDR for this video |
| outlined badge with a slash | Switched to SDR |
| dimmed | DRM-protected video; the extension can't control it, and clicking does nothing |

- Clicking it, or pressing Enter while it has keyboard focus, does exactly what `Alt+H` does for that video (it counts as a manual choice and is remembered by default). Space stays the player's play/pause key.
- It uses the site's own button styles, so it looks like the other buttons and grows with them in fullscreen. Hover it to see the state in the interface language.
- With [Turn off HDR only](#turn-off-hdr-only-keep-super-resolution) on, it shows the video's chosen state, like the toolbar badge.
- It isn't shown on Bilibili Live, in YouTube embeds and Shorts, on iQIYI or on other sites (use `Alt+H` or the popup there), nor in Bilibili's small floating player. If a site redesigns its player, the button may be missing until the extension is updated; `Alt+H` and the popup keep working.
- To hide it, uncheck **Show an HDR button in player control bars** in the Rules tab. The change applies to open pages right away.

### Popup

Switch the language at the top right: 中 / EN / Auto (follows the browser). The popup has three tabs:

- **Video**: the current video's state (big HDR / SDR, the reason, the shortcut), **Switch to SDR / Back to HDR**, **Forget**, the last measured brightness, plus everyday settings: this site (follow rules / always on / always off), white-video detection (turn off only / turn off and on / off) and sensitivity, night mode, and the viewing reminder in minutes (0 = off). If NVIDIA's global HDR is off, a notice with a **Turn on** button appears at the top.
- **NVIDIA**: NVIDIA's global RTX Video settings, Windows SDR brightness sync and presets, see [NVIDIA settings panel](#nvidia-settings-panel).
- **Rules**: theme color, HDR on or off when no rule applies, turn off HDR only, the night time range and day/night presets, switch to SDR when the reminder is due, remember manual choices, on-screen labels, the player button, shortcuts, and backup export / import.

### Theme color

The Rules tab offers six presets (lime, yellow, signal orange, neon pink, electric cyan, lavender; lavender is the default) and a custom color picker. The popup, the divider in the toolbar icon, the HDR badge and the on-screen labels all follow it; text on the theme color switches between black and white automatically.

### Decision order

For each video, the first matching rule wins (the popup shows which one as the reason):

1. **Manual**: you toggled this video since the page was opened. The reminder's automatic switch to SDR also sits at this level but is not remembered.
2. **Remembered for this video**: a choice you saved earlier.
3. **Site rule**: the *This site* setting. For an embedded player, the site of the tab's top-level page counts.
4. **Night mode**: within the night window → off.
5. **Auto-detected (white)**: the picture is judged white/bright → off.
6. **Default**.

On YouTube (mini player) and Twitch (mini player), a video that keeps playing after you navigate to the home page or a directory page keeps its identity, so its remembered and manual choices still apply.

### White-background detection

The main video is sampled as soon as it starts playing and then every 1.5 s, scaled down to 64×36 to measure average brightness and the share of white pixels. Three bright frames in a row (about 3 s) turn HDR off.

- **Turn off only**: once a video is judged bright, it stays off while the page is open, so mid-roll ads, quality changes and sensitivity changes don't flash it back to HDR.
- **Turn off and on**: six clearly dark frames in a row turn HDR back on; after any automatic switch the state is held for at least 10 s.
- All-black frames (transitions, loading) are ignored.
- Detection runs only when no manual, remembered, site or night rule applies, and pauses while the video is paused or the tab is hidden.

### Viewing reminder

- Counts time spent watching with HDR not blocked. **Changing video, autoplay and opening new tabs keep counting**; time paused, in the background or in SDR doesn't count.
- The count resets only after **more than 5 minutes without watching** (paused or page closed).
- When time is up, a message on the video suggests a break, and the count restarts.
- With *Switch to SDR when the viewing reminder is due* checked, the current video and every following video stay in SDR until you stop watching for over 5 minutes, switch HDR back on manually, or turn the option off.

### Backup

**Export backup** and **Import backup** at the bottom of the Rules tab open the extension's options page (a file picker would close the popup). A backup is one JSON file with settings, NVIDIA presets, site rules and remembered videos. Before importing, the page shows a summary (remembered videos, presets, site rules); confirming replaces the current settings and remembered videos.

## NVIDIA settings panel

[简体中文说明](README.zh-CN.md#nvidia-参数面板)

The popup's NVIDIA tab reads and changes the same global settings that NVIDIA App shows under **System** → **Video** → **RTX Video Enhancement**, so changes apply to every video, in every browser and app, not only the current tab:

- **RTX Video HDR** on/off with NVIDIA's active/inactive status, **peak**, **middle grey**, **contrast** and **saturation**.
- **VSR** (Super Resolution): off / auto / manual quality (very low to high), **GPU priority** in auto mode, and the on-video NVIDIA status indicator.
- **Presets** (bottom of the tab): **Save as…** the current values, **Apply** them later, **Delete** them (deleting asks for a second click).
- **Day/night presets**: in the Rules tab, choose a preset for the night time range and one for the rest of the day. They follow the night window's times whether or not Night mode itself is on, and are applied once when the period starts; changes you make afterwards are kept until the next period.
- **Shortcuts**: middle grey ±5 (`Alt+Shift+↑/↓`) and *Switch to the next NVIDIA preset* (no key assigned by default).

### Windows SDR brightness sync

The black block in the middle of the tab reads the current display's Windows "SDR content brightness" (in nits and as the slider position) and suggests three values; **Sync** writes the checked ones:

- **Middle grey** = SDR white × 0.2158 (the linear brightness of sRGB 50% grey), clamped to 10–100, so the mid-tones of RTX HDR video are as bright as 50% grey on the desktop.
- **Peak** = min(GPU maximum, 1000): with driver 617.42 the output stops getting brighter at about 1000 nits.
- **Contrast** +25: measured gamma ≈ 2.2, close to the curve Windows uses for SDR content.

Saturation is left alone. With **Follow SDR brightness** on, middle grey follows the formula whenever the Windows SDR brightness changes (checked every 2 s while the popup is open, every 30 s otherwise); while the SDR brightness stays the same, a middle grey you set by hand is kept. With several displays you can choose which one to use.

### Turn off HDR only, keep super resolution

With this on (Rules tab), videos that should be SDR no longer get the filter (they stay on the overlay, so VSR keeps working). Instead the extension uses the local helper to switch NVIDIA's **global** RTX Video HDR off for a while:

- Global HDR goes off while the main video of the active tab in the focused window should be SDR, and comes back when it should be HDR, when you switch tabs, or when the video is gone.
- In testing the switch took effect within 0.1–0.3 s, VSR stayed on, and white dropped exactly to the Windows SDR white.
- Because it is the global switch, other videos playing at the same time (in another window or another app) turn SDR too.
- Only the video in front is switched this way. A video in another browser window that should be SDR still gets the per-video filter, so it stays SDR while global HDR is on (and its VSR is off).
- If the browser quits, crashes or the extension reloads, the local helper switches global HDR back on by itself.
- If you switch global HDR yourself in the popup meanwhile, your choice wins and that video no longer borrows the switch.
- Without the local helper (or with a 1.1 helper) the mode doesn't apply and the extension falls back to the per-video filter; the Rules tab says why.

### Install the local helper

A browser extension can't call NVIDIA's settings interface directly, so these features talk to a small helper program (a native messaging host) in the `native-host` folder. Without it the NVIDIA tab says the local helper isn't installed and the rest of the extension works as before.

1. Install the extension: load this folder as it is (see [Installation](#installation)), or install it from the Chrome Web Store. The helper accepts these two extension IDs: `omgekmljdifpghaimigdbbbcmnjddmdd` for the loaded folder (fixed by the `key` in `manifest.json`) and `ngpglblkbhffcikcbkodlmgbaaojgmpp` for the Chrome Web Store version. A copy without the `key` or a repacked build gets a different ID, and the helper rejects it.
2. Double-click `native-host\install.cmd`. It builds `rtx_hdr_host.exe` with the C# compiler that comes with Windows (.NET Framework 4.x) and registers it for Chrome, Edge and Chromium for the current user (`HKCU`). No admin rights are needed. The Chrome Web Store version doesn't include the helper: download the ZIP from the [latest release](https://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/latest), extract it to a folder you'll keep, and run `native-host\install.cmd` from there.
3. Close and reopen the popup. The NVIDIA tab should now show the current values.

Requirements: Windows 10/11 (x64) and NVIDIA App, whose `nvcpl.dll` the helper uses. Keep the folder on a path without `&`, `^` or `%`: the browser starts the helper through `cmd.exe`, which breaks on these characters. After updating from 1.1 to 1.2, run `install.cmd` again: SDR sync and *Turn off HDR only* need the 1.2 helper. The Chrome Web Store version needs the 1.2.1 helper or newer. The protocol is documented in [native-host/README.md](native-host/README.md).

To uninstall, double-click `native-host\uninstall.cmd` (it removes the registry entries), then delete the folder. If you move the folder, run `install.cmd` again.

### Good to know

- **NVIDIA App shows the old values until you leave its Video page and open it again.** While that page shows old values, don't move its sliders: NVIDIA App writes back everything it has on screen and undoes the popup's changes.
- The helper uses NVIDIA App's own `nvcpl.dll` through an undocumented interface. It was tested with NVIDIA App 11.0.9 and driver 617.42; a later NVIDIA App update may break it. The popup then shows an error and the rest of the extension keeps working.
- Peak above about 1000 nits made no difference in testing: driver 617.42 capped the output at about 1000 nits. The popup shows a hint when you go above 1000.
- The helper runs only while the popup is open, briefly for presets and SDR follow-up, and continuously while *Turn off HDR only* is borrowing the switch. It runs locally and makes no network connections. Reading the SDR brightness only reads Windows' display settings; it never changes them.

## Limitations

- **The per-video switch can only turn RTX Video HDR off.** If RTX Video HDR is not enabled globally, or hardware acceleration is off, there is no HDR to switch, even when the badge says **HDR**.
- **Switching HDR off per video also switches off VSR** for that video (Chrome limitation). *Turn off HDR only* uses the global switch instead, so other videos playing at the same time turn SDR too.
- **DRM-protected videos can't be controlled.** They are presented through a Media Foundation overlay that CSS doesn't affect, and their frames can't be read for detection. The badge shows **DRM**. They still count towards the viewing reminder.
- **Picture-in-Picture**: the browser sends the video straight to the PiP window, so the switch may not apply there. It works again once the video is back in the page.
- **Cross-origin videos without CORS** can't be sampled, so auto-detection doesn't work for them. Manual toggling, memory and site rules still work.
- Some pages keep rewriting the video's style. The extension backs off, shows *the page keeps rewriting the video style* as the reason, and retries later, or immediately when you toggle manually.
- If a page already puts a `filter` on the video (e.g. a player's picture-adjustment feature), the video isn't on an overlay to begin with, so RTX Video HDR isn't active anyway.
- In element fullscreen (`video.requestFullscreen()`), the on-screen label is hidden behind the browser's fullscreen layer. Site players' own fullscreen modes are fine.
- Browser-internal pages (`chrome://`, the extension stores) are not supported.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says *Not connected to this page yet* | Reload the page. Tabs that were open or asleep before install may not have been injected. |
| Popup says no video / no video showing / out of view | Make sure the video is on the page (some sites create it only after you press play) and scrolled into view. |
| **HDR** badge but the picture isn't bright / NVIDIA App shows inactive | RTX Video HDR itself isn't working. Check the [requirements](#requirements). |
| Brightness doesn't change after switching to SDR | First confirm RTX Video HDR works (see [Check that it works](#check-that-it-works)). DRM and PiP videos can't be controlled. |
| Shortcut does nothing | Check that a key is assigned on the shortcuts page and doesn't clash with another extension, and that the browser window has focus. |
| A white-background video isn't switched off | Make sure detection isn't set to *Off* and no higher-priority rule applies; try a higher sensitivity. Cross-origin videos can't be detected. |
| Extension stops working / "could not load" | Check that the `rtx-hdr-switch` folder hasn't been moved or deleted. |
| NVIDIA tab says the local helper isn't installed | Run `native-host\install.cmd` (see [Install the local helper](#install-the-local-helper)), then reopen the popup. Run it again after moving the folder. |
| NVIDIA tab says the local helper is out of date, or *Turn off HDR only* doesn't apply | Run `native-host\install.cmd` again to update to 1.2. |
| NVIDIA tab says the local helper doesn't accept this extension's ID | Chrome Web Store version: the installed helper is older than 1.2.1. Run `native-host\install.cmd` from the [latest release](https://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/latest). Loaded folder: load this folder unpacked as it is, without removing the `key`; running `install.cmd` again doesn't help. |
| NVIDIA tab says NVIDIA App (nvcpl.dll) wasn't found | Install NVIDIA App. |
| NVIDIA App still shows the old values | Leave NVIDIA App's Video page and open it again (see [Good to know](#good-to-know)). |

## Development

No build step and no dependencies. The tests use only Node's built-in `node:assert`.

```sh
node test/lib.test.js        # unit tests: decisions, video keys, auto-detection, filter, viewing timer, settings, i18n, theme, SDR suggestions, backup, manifest
python tools/make_icons.py   # regenerate icons/ (needs Pillow; --accent "#RRGGBB" for another color)
native-host\build.cmd                      # build rtx_hdr_host.exe (in-box C# 5 compiler)
node native-host/test/host.test.mjs        # local helper tests (read-only)
node native-host/test/host.test.mjs --live # plus reversible writes (middle grey +1, the HDR lease), then restored
```

| File | Purpose |
|---|---|
| `manifest.json`, `_locales/` | MV3 manifest; English / Chinese name, description and shortcut names |
| `background.js` | Service worker: badge, shortcuts, viewing timer, injection on install, day/night presets, SDR follow-up, the HDR lease |
| `i18n.js` | Interface strings (Chinese / English) |
| `lib.js` | Pure logic shared by the content script, popup, options page, service worker and tests |
| `content.js` | Content script: finds videos, applies the filter, samples frames, on-screen labels, the player button |
| `popup.*` | Popup |
| `options.*` | Options page (backup) |
| `icon-draw.js`, `icons/`, `tools/make_icons.py` | Icon: redrawn in the theme color at runtime / static PNGs / generator |
| `fonts/` | Anton and Archivo (OFL, Latin subset) |
| `native-host/` | Local helper: `RtxHdrHost.cs`, build / install / uninstall scripts, host manifest, tests, protocol |
| `SPEC.md` | Design spec and measurements (Chinese) |

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, remembered videos and per-tab state |
| `scripting` | Inject the content script into tabs that were already open when the extension was installed or updated |
| `tabs` | Look up open tabs and their URLs (injection on install, shortcuts, popup, badge) |
| `nativeMessaging` | Talk to the optional local helper that reads and writes NVIDIA's RTX Video settings |
| `alarms` | Check whether a day/night preset is due (once a minute) and follow the SDR brightness (every 30 s), only while those are turned on |
| `<all_urls>` | Videos can be on any site, including embedded players in iframes |

## Privacy

The extension makes no network requests and collects no data. Settings and remembered videos are stored locally in `chrome.storage.local`; per-tab state and the viewing timer live in `chrome.storage.session` and are cleared when the browser restarts. Auto-detection scales the video frame down to 64×36 in memory to measure brightness; frames are never stored or sent anywhere. Backup files are saved only where you choose. The optional local helper runs only on your PC, talks only to the extension, NVIDIA App's `nvcpl.dll` and Windows' display configuration API, and makes no network connections.

## License

[MIT](LICENSE). The Anton and Archivo fonts in `fonts/` are under the SIL Open Font License (see `fonts/OFL-*.txt`).

## Disclaimer

This is an independent open-source project. It is not affiliated with, endorsed by or sponsored by NVIDIA Corporation. NVIDIA, RTX and GeForce are trademarks of NVIDIA Corporation. Chrome is a trademark of Google LLC; Microsoft Edge is a trademark of Microsoft Corporation. These names are used only to describe compatibility.
