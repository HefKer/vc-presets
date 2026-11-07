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
- Screen casting goes through **xdg-desktop-portal-wlr** (0.8.4), not the GNOME portal. niri has wlr-screencopy but
  not ext-image-copy-capture, so it can cast **whole monitors only**: no window capture, no niri dynamic cast target.
  xdpw uses `chooser_type=simple` with a chooser script from the NixOS config. The contract:
  before Go Live, `native.ts` writes the output name (e.g. `DP-3`) to `$XDG_RUNTIME_DIR/xdpw-cast-target`
  (fallback `/run/user/$UID`). The chooser reads it if it is under 30 s old, deletes it, and prints `Monitor: <name>`,
  so no menu appears; otherwise it shows a fuzzel menu of outputs. VcPresets deletes the file itself when Go Live fails,
  so a stale target can't hijack a later manual share.
- `niri msg --json windows` gives a window's `workspace_id`; `niri msg --json workspaces` gives that workspace's `output`.
  osu's app_id is exactly `osu!`. osu plays through ALSA, so its PipeWire stream is application.name
  `PipeWire ALSA [osu!]`, node.name `alsa_playback.osu!`.
  A plugin can shell out from a `native.ts` (Vencord plugin native module, main process).

## Wanted
1. Preset = `{ name, video: {monitor: "DP-3"} | {monitorOfWindow: app_id regex} | null (pick in the menu), audio: "Entire System" | "None" | app-name list (case-insensitive substrings of application.name / node.name, turned into venmic includeSources), excludeSources?, resolution, frameRate, contentHint }`.
2. Seed presets: `screen` (DP-3, Entire System audio) and `osu` (monitor of `^osu!$`, osu audio only). Users add/edit/delete presets in the plugin's settings UI.
3. Starting a preset: write the cast-target file, start a Go Live in the current voice channel, and skip Vesktop's audio modal, using the preset's audio instead.
   The hook choice (main-process interception of Vesktop's `screenshare:picker` IPC) and why are in README.md; keep it.
4. **Public API, which `VcActions` (sibling plugin) calls at runtime through `Vencord.Plugins.plugins.VcPresets`. Keep these names stable:**
   - `listPresets(): Preset[]`
   - `startPreset(name: string): Promise<void>`: throws a readable Error if not in a voice channel or the name is unknown
   - `stopStream(): void`
   (`retarget` was removed with the switch to xdpw; there is no mid-stream retargeting.)

## Rules
- Build host: the combined tree `../vencord` (both plugins symlinked into `src/userplugins/`). `tsconfig.json` extends
  `../vencord/tsconfig.json` so Vencord's path aliases resolve through the symlink (no symlink to the tree in this repo:
  it loops, and stylelint runs out of memory). Verify with
  `pnpm build && pnpm test` there. Don't edit Vencord.
- Don't touch the running Vesktop, its settings, or `~/.config/vesktop`. Don't push, don't add remotes. The user live-tests.
- Small commits to `main` here. README.md: what it does, how to install (Vencord Location → built `dist`), limits.
