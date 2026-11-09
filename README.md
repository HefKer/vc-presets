# VcPresets

Vencord userplugin for Vesktop on niri (Wayland) with the GNOME portal. A preset is a saved
screenshare: niri dynamic cast target (a monitor or a window), venmic audio sources, resolution, frame
rate and content hint. Starting one goes live in your current voice channel with no Vesktop
quality/audio dialog. The `share-cast-target` helper picks "niri Dynamic Cast Target" in the portal's
Share Screen dialog and then sets the target.

Seed presets:

| name | video | audio |
|---|---|---|
| `screen` | monitor `DP-3` | Entire System |
| `osu` | window whose app_id matches `/^osu!$/i` | only `PipeWire ALSA [osu!]` |

Edit, add and delete presets in Settings → Plugins → VcPresets. Each preset has "Go live" and "Retarget"
buttons for testing. Video is `{ monitor: "DP-3" }`, `{ window: "<app_id regex>" }` (resolved to a niri
window id from `niri msg --json windows`; the focused match wins, otherwise the first), or none, which
means you pick in the dialog yourself. Audio names match any venmic node whose `application.name` or `node.name` contains
them, case-insensitively. osu plays through ALSA, so its stream is `PipeWire ALSA [osu!]`. A name with no
live audio node becomes a literal `application.name` rule, which venmic applies once an app with exactly
that name starts playing.

## API

[`QuickActions`](https://github.com/HefKer/vc-actions) (formerly VcActions) calls these at runtime through `Vencord.Plugins.plugins.VcPresets`:

- `listPresets(): Preset[]`: returns a copy.
- `startPreset(name): Promise<void>`: throws a readable `Error` if you're not in a voice channel, the
  name is unknown, niri can't find the window, or the capture is cancelled. If you're already
  streaming, it stops that stream first.
- `stopStream(): void`
- `retarget(name): Promise<void>`: mid-stream, runs only `niri msg action set-dynamic-cast-*` for the
  preset's video. It throws if you're not streaming or the preset has no video.

## How the hook works, and why

Vesktop's Wayland flow: Discord calls `getDisplayMedia` → Vesktop's main-process display-media handler
→ `desktopCapturer.getSources` (xdg portal dialog) → `screenshare:picker` sent over the
`VCD_IPC_COMMAND` channel to the renderer → Vesktop's modal → on submit, venmic is started and the
reply goes back. On Wayland, main only checks that the reply succeeded; it ignores what the reply
contains.

`startPreset` does this:

1. Resolves the preset's video to `niri msg action` arguments (`set-dynamic-cast-monitor DP-3` or
   `set-dynamic-cast-window --id N`). The target is set later, in step 4.
2. Starts venmic itself with `VesktopNative.virtmic.start(include)` / `.startSystem(exclude)`, the same
   calls Vesktop's modal makes. This happens before capture starts, so Vesktop's `getDisplayMedia`
   wrapper finds the `vencord-screen-share` device and attaches it as usual.
3. Arms a one-shot hook in the main process (`native.ts`), which wraps `WebContents.prototype.send`.
   The next `screenshare:picker` command is swallowed and answered with an ok reply on `ipcMain`, so
   the modal never opens. Every other message passes through untouched. The hook disarms after one
   use or after 2 minutes.
4. Just before the capture, spawns `share-cast-target <those args>` from `native.ts`, detached and not
   awaited. niri holds back the stream, and with it the portal's reply, until a dynamic target is set,
   so the target can only be set after the dialog. The helper (from the NixOS config) waits up to 15 s
   for the GNOME Share Screen dialog, picks "niri Dynamic Cast Target" with keystrokes, presses Share,
   then runs the niri action. If it exits non-zero, a toast shows its stderr, and its stderr is also
   added to the capture error. With no video, nothing is spawned and you pick in the dialog.
5. Runs Discord's own web Go Live path: `MediaEngine.getDesktopSource()` (→ `getDisplayMedia`), then the
   `STREAM_START` action with the resulting source id. Both run inside
   `webContents.executeJavaScript(..., userGesture=true)`, so a global hotkey works without a click.
   Rejections are serialized in the page (name, message, stack), so failures stay readable instead of
   becoming `[object Object]`.
6. Applies quality the way Vesktop's modal does: an outer `getDisplayMedia` wrapper sets
   `contentHint` and `applyConstraints`, the stream connection's `videoStreamParameters` are capped,
   and a patch on `getDefaultGoliveQuality()` overrides the encoder settings. The patch wraps
   Vesktop's own patch of the same call, whichever is applied first.

Why this hook and not the alternatives:

- **Driving Vesktop's modal** (finding it in the DOM, setting its React state, clicking Go Live) breaks
  on any markup or class change. Its settings live in a module-private variable, and its quality store
  is a closure that the plugin can't reach.
- **Replacing the renderer's IPC handler** isn't possible: `VesktopNative` comes through
  `contextBridge`, so it's frozen, and the handler map is private.
- **Replacing `setDisplayMediaRequestHandler`** would mean re-implementing Vesktop's handler for the
  non-preset case, and the original can't be restored afterwards.
- **Intercepting the IPC message in main** depends only on two strings from Vesktop's
  `shared/IpcEvents.ts` (`VCD_IPC_COMMAND`, `screenshare:picker`) and on the `{nonce, ok, data}` reply
  shape. Unless it's armed, it does nothing. If Vesktop changes either one, the hook stops matching and
  Vesktop's modal simply appears again; nothing breaks (a warning is logged).

## Install

The repo is symlinked into the combined Vencord tree `../vencord` as `src/userplugins/vcPresets`.
`tsconfig.json` extends `../vencord/tsconfig.json`, so esbuild and tsc can resolve Vencord's `@api/*`
and `@utils/*` aliases for files reached through the symlink. Point it at a different tree to build
there. Don't put a symlink to the tree inside this repo: the tree already links here, so the loop sends
stylelint's glob into endless recursion, which ends in an out-of-memory crash.

Then run `pnpm build` in that tree. In Vesktop, go to Settings → Vesktop → "Vencord Location", choose
its `dist`, restart Vesktop, and enable VcPresets.

`niri` must be on Vesktop's `PATH` with `NIRI_SOCKET` set, which it is when Vesktop is launched from
the niri session. Otherwise set the plugin's "niri binary" option to a full path. `share-cast-target`
comes from the NixOS config; its path is a plugin setting too.

## Limits

- The GNOME Share Screen dialog still flashes up for each Go Live; `share-cast-target` drives it with
  wtype keystrokes, so don't type while it's up. If the helper fails, pick "niri Dynamic Cast Target"
  in the dialog yourself. niri won't start the stream until a target is set, so then run
  `niri msg action set-dynamic-cast-*` by hand. `retarget` can't help here: it needs a running stream.
- With several matching windows, the focused one is used, otherwise the first.
- Only tested against Vesktop 1.6.8 and the Discord web build of 2026-11. Two lookups depend on Discord
  internals: `STREAM_START`/`STREAM_STOP` (via `findByCode`) and `getDefaultGoliveQuality`.
- Restarting while already live stops the old stream and waits 750 ms. Vesktop's own `STREAM_CLOSE`
  handler unlinks venmic, and the wait keeps that from racing the new link.
- Presets saved with older video shapes (`{ windowAppId }`, `{ monitorOfWindow }`) are migrated to
  `{ window }` on startup.
- Linux/Vesktop only. On other clients, audio is skipped and a toast is shown.
