# vc-presets — Vencord userplugin `VcPresets`

Save screenshare presets and start a stream from one with no audio dialog.

## Context
- Vesktop 1.6.8 on NixOS, **niri** (Wayland), PipeWire. Monitors: DP-1 left, **DP-3 right**.
- Unpacked Vesktop source: `../.vesktop-1.6.8-src/dist/js/{main,renderer,preload}.js` (minified). On Wayland the flow is:
  `setDisplayMediaRequestHandler` (main) → `desktopCapturer.getSources` (opens the xdg portal picker) →
  IPC `screenshare:picker` to the renderer with `skipPicker: true` → Vesktop's own modal (quality, content hint,
  audio sources; `includeSources` defaults to `"None"` every time) → `VesktopNative.virtmic.start(includeSources)`
  or `.startSystem(excludeSources)` (venmic).
  Quality lives in Vesktop's `screenshareQuality` store `{resolution, frameRate}`.
- Screen casting goes through the **GNOME portal** with niri's **Dynamic Cast Target**
  (`niri msg action set-dynamic-cast-monitor DP-3`, `set-dynamic-cast-window --id <id>`, ids from `niri msg --json windows`).
  niri holds back the stream, and with it the portal's reply, until a dynamic target is set ("delaying dynamic cast until
  target is set"), so the target must be set *after* the dialog. The NixOS tool `share-cast-target <niri action args...>`
  does that: it waits up to 15 s (`SHARE_TIMEOUT`) for the GNOME "Share Screen" dialog, picks "niri Dynamic Cast Target"
  with wtype keystrokes (checking focus before each key), presses Share, then runs `niri msg action <args>`.
  Exit 0 = shared; non-zero = failed, with the reason on stderr.
  (xdg-desktop-portal-wlr was tried and reverted: it can only cast whole monitors on niri.)
  osu's app_id is exactly `osu!`. osu plays through ALSA, so its PipeWire stream is application.name
  `PipeWire ALSA [osu!]`, node.name `alsa_playback.osu!`.
  A plugin can shell out from a `native.ts` (Vencord plugin native module, main process).

## Wanted
1. Preset = `{ name, video: {monitor: "DP-3"} | {window: app_id regex → niri window id, focused match wins} | null (user picks in the dialog), audio: "Entire System" | "None" | app-name list (case-insensitive substrings of application.name / node.name, turned into venmic includeSources), excludeSources?, resolution, frameRate, contentHint }`.
2. Seed presets: `screen` (DP-3, Entire System audio) and `osu` (window `^osu!$`, audio `PipeWire ALSA [osu!]`). Users add/edit/delete presets in the plugin's settings UI.
3. Starting a preset: spawn `share-cast-target <set-dynamic-cast-* args>` (path is a plugin setting) from native.ts, detached and unawaited, just before the capture (not for null video); its exit status and stderr feed the error if the capture fails. Then start a Go Live in the current voice channel, and skip Vesktop's audio modal, using the preset's audio instead.
   The hook choice (main-process interception of Vesktop's `screenshare:picker` IPC) and why are in README.md; keep it.
4. **Public API, which `VcActions` (sibling plugin) calls at runtime through `Vencord.Plugins.plugins.VcPresets`. Keep these names stable:**
   - `listPresets(): Preset[]`
   - `startPreset(name: string): Promise<void>`: throws a readable Error if not in a voice channel or the name is unknown
   - `stopStream(): void`
   - `retarget(name: string): Promise<void>`: mid-stream, only `niri msg action set-dynamic-cast-*` for the preset's video; throws if not streaming or the preset has no video

## Rules
- Build host: the combined tree `../vencord` (both plugins symlinked into `src/userplugins/`). `tsconfig.json` extends
  `../vencord/tsconfig.json` so Vencord's path aliases resolve through the symlink (no symlink to the tree in this repo:
  it loops, and stylelint runs out of memory). Verify with
  `pnpm build && pnpm test` there. Don't edit Vencord.
- Don't touch the running Vesktop, its settings, or `~/.config/vesktop`. Don't push, don't add remotes. The user live-tests.
- Small commits to `main` here. README.md: what it does, how to install (Vencord Location → built `dist`), limits.
