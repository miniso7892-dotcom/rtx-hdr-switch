# RTX HDR Switch native host

`rtx_hdr_host.exe` is the Chrome / Edge [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host `io.github.rtx_hdr_switch`. It does three things:

- It reads and writes the **global** NVIDIA RTX Video settings: RTX Video HDR and RTX Video Super Resolution (VSR). These are the settings shown in NVIDIA App → System → Video. The host calls NVIDIA App's own `nvcpl.dll`, which is an undocumented API and may break when NVIDIA App updates.
- It reads Windows display information: the SDR content brightness and whether HDR is on. This is read-only.
- It holds an **HDR lease**, which turns RTX Video HDR off while VSR keeps running, then puts it back.

It needs no admin rights and makes no network access.

## Build, install, uninstall

| Script | What it does |
|---|---|
| `build.cmd` | Compiles `RtxHdrHost.cs` with the C# compiler that ships with Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, C# 5, x64). |
| `install.cmd` | Builds the exe if it is missing or out of date. Registers `io.github.rtx_hdr_switch.json` under `HKCU\Software\{Google\Chrome, Microsoft\Edge, Chromium}\NativeMessagingHosts`, then runs a `hello` self-test. |
| `uninstall.cmd` | Removes those HKCU keys. It leaves the files and your NVIDIA settings unchanged. |

Close the extension popup before rebuilding. A running host keeps the exe locked.

## Framing

- Each message is a 4-byte little-endian length followed by UTF-8 JSON with no BOM. Requests are answered one at a time, in order.
- If a request has an `id`, the reply echoes it unchanged.
- stdout carries only protocol frames. Logs go to stderr.
- The host exits with code 0 when stdin reaches EOF. A bad length header or a truncated frame makes it exit with a non-zero code.

## Commands

### `hello`

```json
{"cmd":"hello"}
→ {"ok":true,"host":"rtx_hdr_host","version":"1.2.0","protocol":1,"dll":"C:\\…\\nvcpl.dll","caps":["display","hdrLease"]}
```

- `dll` is `null` if `nvcpl.dll` was not found.
- `protocol` stays `1`, because every 1.1 request and reply is unchanged.
- Use `caps` to feature-detect the 1.2 commands. 1.1 hosts send no `caps`.

### `get`

```json
{"cmd":"get"} → {"ok":true,"state":State}
```

```json
State = {
  "hdr": {"supported":true,"enabled":true,"active":false,"error":0,"peak":1000,"peakMin":400,"peakMax":1970,
          "middleGrey":65,"contrast":25,"saturation":0},
  "vsr": {"supported":true,"mode":5,"level":0,"priority":2},
  "indicator": false,
  "flags": 0
}
```

| Field | Source | Meaning |
|---|---|---|
| `hdr.*` | `0x318` | `contrast` and `saturation` are UI values from −100 to 100. |
| `hdr.active` | `0x319` | HDR is processing a video right now. |
| `hdr.error` | `0x318` | `0` OK, `1` no HDR display, `2` HDR is off in Windows, `3` Surround is on. |
| `vsr.mode` | `0x315` | `0` off, `1`–`4` manual quality, `5` auto. |
| `vsr.level` | `0x316` | VSR level in effect right now. |
| `vsr.priority` | `0x32F` | `0`–`2`. |
| `flags` | `0x330` | Raw flags value. |
| `indicator` | `0x330` | `(flags & 0x101) != 0`. |

Optional values the driver does not provide are `null`.

### `set`

```json
{"cmd":"set","hdr":{"enabled":bool,"peak":int,"middleGrey":int,"contrast":int,"saturation":int},
 "vsr":{"mode":0..5,"priority":0..2},"indicator":bool,"commit":bool}
→ {"ok":true,"state":State}
```

- Every field is optional.
- **Validation:** all fields are checked before anything is written. One bad value rejects the whole request with `range`. Values must be integers. `peak` must be within the live `peakMin..peakMax`, `middleGrey` within 10–100, and `contrast` and `saturation` within −100..100.
- **How `0x318` is written:** read-modify-write. Unknown fields are kept, and `errorCode` and `status` are written as 0, the same way NVIDIA App does it.
- **Write order:** `0x318` → `0x317` (VSR mode) → `0x32F` → `0x330`. For `0x330`, only bits `0x101` change.
- **Commit:** a plain `SetSetting` already persists, so `commit` is accepted but does nothing.
- **Partial failures:** if a write fails, the error has `written`, a list of the setting ids already written.

### `display` (1.2, read-only)

```json
{"cmd":"display"}
→ {"ok":true,"displays":[{"id":"\\\\?\\DISPLAY#HEC1142#…","name":"27G7S-Ultra","hdrSupported":true,"hdrEnabled":true,
                          "sdrWhiteNits":480,"sdrSlider":100,"bitsPerColor":10}]}
```

The host lists the active displays with user32 `QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS)` and `DisplayConfigGetDeviceInfo`. It does not change any Windows setting, and it does not load `nvcpl.dll`. The primary display comes first.

| Field | Source |
|---|---|
| `id` | `monitorDevicePath` (stable per monitor and port). |
| `name` | `monitorFriendlyDeviceName` from EDID. `""` if the monitor has none. |
| `hdrSupported`, `hdrEnabled` | `GET_ADVANCED_COLOR_INFO` (type 9). `hdrSupported` is bit 0. `hdrEnabled` is bit 1 when neither bit 2 (wide colour enforced, i.e. Auto Color Management on an SDR panel) nor bit 3 (force-disabled) is set. |
| `sdrWhiteNits` | `GET_SDR_WHITE_LEVEL` (type 11): `SDRWhiteLevel / 1000 × 80`, rounded to 0.1. |
| `sdrSlider` | The Windows "SDR content brightness" slider: `round((nits − 80) / 4)`, clamped to 0–100. |
| `bitsPerColor` | `bitsPerColorChannel` from type 9. |

If Windows cannot report type 9 or type 11 for a display (for example a virtual display), the fields from that call are `null`. Enumeration failures, and target-name failures (type 2), return `api` with `rc`, the Win32 error code.

### `hdrLease` (1.2): HDR off, VSR keeps running

```json
{"cmd":"hdrLease","on":true}
→ {"ok":true,"lease":true,"prevEnabled":true,"changed":true,"state":State}

{"cmd":"hdrLease","on":false}                  // restore (default)
{"cmd":"hdrLease","on":false,"restore":false}  // just drop the lease
→ {"ok":true,"lease":false,"changed":true,"state":State}
```

**`on:true`**
- Reads `0x318`.
- If HDR is unsupported, it replies `unsupported`. If `hdr.error ≠ 0`, it replies `hdr-error`.
- When the lease starts, the host records `prevEnabled`, the enabled bit at that moment. Repeated `on:true` calls while the lease is held keep the original value.
- If the enabled bit is 1, the host writes **only** that bit as 0, using read-modify-write like `set`. VSR and every other field and setting stay as they are. The change takes effect on playing video within about 0.1–0.3 s.
- `changed` says whether this call wrote anything.

**`on:false`**
- With `restore` true or omitted: if the lease is held, `prevEnabled` was true, and the enabled bit is now 0, the host writes it back to 1. Then the lease is cleared.
- With `restore:false`: the lease is cleared and the enabled bit is not touched. Use this when the user deliberately changed the global HDR switch while the lease was held, so their choice wins.
- Releasing without a lease is a successful no-op. In that case `state` is `null` if the NVIDIA settings cannot be read.

**Validation:** `on` is required and must be a boolean. `restore` is optional, must be a boolean, and only matters with `on:false`. A bad value gives `range` with `field` set to `on` or `restore`. Validation happens before any NVIDIA call, so a bad request never writes.

**Errors after validation** carry `lease` (boolean), which says whether this process still holds a lease. A failed restore keeps the lease, so it is retried on the next `on:false` or at exit.

**Exit-restore guarantee:** if a lease is still held when the host exits, the host restores it exactly as `on:false` (with `restore:true`) would, **before** it exits. This covers:
- stdin EOF: the port disconnected, the browser exited or crashed, or the extension or its service worker reloaded or stopped. Chrome closes the pipe first, and the restore takes a few milliseconds.
- A framing error.
- A normal process exit.
- Ctrl+C, Ctrl+Break, or the console closing.
- Logoff or shutdown, through `SystemEvents.SessionEnded`. This is registered only once a lease has been taken.

After an exit-path restore, the process accepts no new lease. A hard kill (`TerminateProcess`, Task Manager) or a power loss cannot be handled, and in that case HDR stays off until something turns it back on.

**Scope:**
- A lease belongs to one host process, so hold it on a long-lived `chrome.runtime.connectNative` port. `chrome.runtime.sendNativeMessage` starts a new host for every message, so a lease taken that way is restored as soon as the reply has been sent.
- Leases in different host processes do not know about each other.
- While a lease is held, `get` reports `hdr.enabled:false` and `set` keeps working. A `set` that rewrites other HDR fields keeps the enabled bit at 0.

## Errors

```json
{"ok":false,"error":{"code":"…","message":"…", …extra}}
```

| `code` | When | Extra fields |
|---|---|---|
| `no-dll` | `nvcpl.dll` was not found (NVIDIA App is missing). | |
| `init` | `NvCplApiInit` failed. | `rc` |
| `api` | An NVIDIA call returned non-zero, or a Windows DisplayConfig call failed. | `rc`; `id` (setting, hex) for NVIDIA calls |
| `bad-request` | Invalid JSON, a non-object request, or a missing or unknown `cmd`. | |
| `range` | A field has the wrong type or is out of range. | `field`; `min` and `max` for integers |
| `unsupported` | HDR, VSR, priority or flags are not supported on this GPU or driver. | `field` |
| `hdr-error` | HDR cannot be changed now (`hdr.error ≠ 0`). | `errorCode` |
| `internal` | An unexpected exception, or a lease was requested while the host is shutting down. | |

## Tests

```
node native-host\test\host.test.mjs          read-only: never writes NVIDIA or Windows settings
node native-host\test\host.test.mjs --live   also runs reversible write tests
```

The read-only run checks the following:
- framing
- the shapes of `hello`, `get` and `display`
- every `range` rejection, for both `set` and `hdrLease`
- that releasing without a lease does nothing
- 300 pipelined `get` calls
- that nothing was written, by reading the state back and checking NVIDIA's debug log for `SetSetting` calls

The `--live` run has two tests. Each one saves the full state at the start and restores and verifies it at the end, even when a step fails:
- **Middle grey:** moves middle grey by 1, then puts it back.
- **`hdrLease`:** checks three cases.
  - Taking a lease turns HDR off. Another host process sees `enabled:false` with the VSR mode unchanged. Closing the leasing process's stdin restores HDR.
  - `on:false` restores HDR.
  - `restore:false` leaves HDR off, and the test then restores it itself.
