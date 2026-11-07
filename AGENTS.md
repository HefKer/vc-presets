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
- niri "Dynamic Cast Target": picked once in the portal dialog, then retargeted with
  `niri msg action set-dynamic-cast-monitor DP-3`, `set-dynamic-cast-window --id <id>`
  (ids from `niri msg --json windows`; osu's app_id matches `/^osu/i`), `clear-dynamic-cast-target`.
  A plugin can shell out from a `native.ts` (Vencord plugin native module, main process).

## Wanted
1. Preset = `{ name, video: {monitor: "DP-3"} | {windowAppId: regex} | null, audio: "Entire System" | "None" | app-name list (venmic includeSources, e.g. osu's), excludeSources?, resolution, frameRate, contentHint }`.
2. Seed presets: `screen` (DP-3, Entire System audio) and `osu` (osu window, osu audio only). Users add/edit/delete presets in the plugin's settings UI.
3. Starting a preset: set the niri cast target, start a Go Live in the current voice channel, and skip/auto-fill Vesktop's audio modal with the preset's audio. The portal dialog is outside Vesktop; it may still appear, and that's acceptable (the user picks the Dynamic Cast Target).
   Find the least fragile hook: Vencord patch on Discord's webpack, wrapping `getDisplayMedia`, or driving Vesktop's modal. Write down the choice and why in README.md.
4. **Public API, which `VcActions` (sibling plugin) calls at runtime through `Vencord.Plugins.plugins.VcPresets`. Keep these names stable:**
   - `listPresets(): Preset[]`
   - `startPreset(name: string): Promise<void>`: throws a readable Error if not in a voice channel or the name is unknown
   - `stopStream(): void`
   - `retarget(name: string): Promise<void>`: change the niri cast target to the preset's video only, mid-stream

## Rules
- Build host: `../.vencord-vc-presets` (Vencord worktree; `src/userplugins/vcPresets` → this repo). Verify with
  `pnpm build` and `pnpm test` there. If tsconfig path aliases (`@api/*`, `@utils/*`) don't resolve through the symlink, fix it from this repo (e.g. a tsconfig.json extending the host's), not by editing Vencord.
- Don't touch the running Vesktop, its settings, or `~/.config/vesktop`. Don't push, don't add remotes. The user live-tests.
- Small commits to `main` here. README.md: what it does, how to install (Vencord Location → built `dist`), limits.
