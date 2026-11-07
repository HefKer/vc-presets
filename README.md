# VcPresets

Vencord userplugin for Vesktop on niri (Wayland). A preset is a saved screenshare: niri cast target,
venmic audio sources, resolution, frame rate and content hint. Starting one sets niri's Dynamic Cast
Target, links the audio, and goes live in your current voice channel without Vesktop's
quality/audio dialog.

Seed presets:

| name | video | audio |
|---|---|---|
| `screen` | monitor `DP-3` | Entire System |
| `osu` | window whose app_id matches `/^osu/i` | only `osu!` |

Edit, add and delete presets in Settings → Plugins → VcPresets. Each preset has a "Go live" button for
testing. App names are matched case-insensitively against venmic's `application.name` / `node.name`,
exact match first, then prefix. A name with no live audio node becomes a literal `application.name`
rule, which venmic applies once that app starts playing.

## API

`VcActions` calls these at runtime through `Vencord.Plugins.plugins.VcPresets`:

- `listPresets(): Preset[]`: returns a copy.
- `startPreset(name): Promise<void>`: throws a readable `Error` if you're not in a voice channel, the
  name is unknown, niri can't find the window, or the capture is cancelled. If you're already
  streaming, it stops that stream first.
- `stopStream(): void`
- `retarget(name): Promise<void>`: only changes niri's cast target to the preset's video, mid-stream.

## How the hook works, and why

Vesktop's Wayland flow: Discord calls `getDisplayMedia` → Vesktop's main-process display-media handler
→ `desktopCapturer.getSources` (xdg portal dialog) → `screenshare:picker` sent over the
`VCD_IPC_COMMAND` channel to the renderer → Vesktop's modal → on submit, venmic is started and the
reply goes back. On Wayland, main only checks that the reply succeeded; it ignores what the reply
contains.

`startPreset` does this:

1. `niri msg action set-dynamic-cast-monitor|set-dynamic-cast-window` (from `native.ts`).
2. Starts venmic itself with `VesktopNative.virtmic.start(include)` / `.startSystem(exclude)`, the same
   calls Vesktop's modal makes. This happens before capture starts, so Vesktop's `getDisplayMedia`
   wrapper finds the `vencord-screen-share` device and attaches it as usual.
3. Arms a one-shot hook in the main process (`native.ts`), which wraps `WebContents.prototype.send`.
   The next `screenshare:picker` command is swallowed and answered with an ok reply on `ipcMain`, so
   the modal never opens. Every other message passes through untouched. The hook disarms after one
   use or after 2 minutes.
4. Runs Discord's own web Go Live path: `MediaEngine.getDesktopSource()` (→ `getDisplayMedia`), then the
   `STREAM_START` action with the resulting source id. Both run inside
   `webContents.executeJavaScript(..., userGesture=true)`, so a global hotkey works without a click.
5. Applies quality the way Vesktop's modal does: an outer `getDisplayMedia` wrapper sets
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

The repo is symlinked into a Vencord tree as `src/userplugins/vcPresets`. `tsconfig.json` extends
`.host/tsconfig.json`, so esbuild and tsc can resolve Vencord's `@api/*` and `@utils/*` aliases for files
reached through the symlink. `.host` is a gitignored symlink to the Vencord tree doing the build:

```sh
ln -sfn ../.vencord-vc-presets .host   # this plugin's own worktree
ln -sfn ../vencord .host               # the combined tree with vc-actions
```

Then run `pnpm build` in that tree. In Vesktop, go to Settings → Vesktop → "Vencord Location", choose
its `dist`, restart Vesktop, and enable VcPresets.

`niri` must be on Vesktop's `PATH` with `NIRI_SOCKET` set, which it is when Vesktop is launched from
the niri session. Otherwise set the plugin's "niri binary" option to a full path.

## Limits

- The xdg portal dialog still appears on every Go Live (Electron doesn't keep a portal restore token).
  Pick "Dynamic Cast Target" in it. After that the preset controls what's shown, and `retarget`
  switches it live.
- Window presets need the window open; with several matches, the focused one is used, otherwise the
  first.
- `video: null` leaves the cast target as it is.
- Only tested against Vesktop 1.6.8 and the Discord web build of 2026-11. Two lookups depend on Discord
  internals: `STREAM_START`/`STREAM_STOP` (via `findByCode`) and `getDefaultGoliveQuality`.
- Restarting while already live stops the old stream and waits 750 ms. Vesktop's own `STREAM_CLOSE`
  handler unlinks venmic, and the wait keeps that from racing the new link.
- Linux/Vesktop only. On other clients, audio is skipped and a toast is shown.
