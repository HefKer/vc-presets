# vc-presets — Vencord userplugin `VcPresets`

Screenshare presets that go live with no Vesktop dialog. README.md is the source of truth for the preset shape,
the API, the hook and why it was chosen, install and limits; keep it in sync.

## Context
- Vesktop 1.6.8 on NixOS, **niri** (Wayland), PipeWire, GNOME portal with niri's Dynamic Cast Target.
  Unpacked Vesktop source (minified): `../.vesktop-1.6.8-src/dist/js/{main,renderer,preload}.js`.
- xdg-desktop-portal-wlr was tried and reverted: on niri it can only cast whole monitors.
- `share-cast-target` comes from the user's NixOS config: exit 0 = shared, non-zero = failed with the reason on stderr.

## Rules
- **The API is a contract**: sibling plugin `VcActions` (`../vc-actions`) calls `listPresets`, `startPreset`,
  `stopStream` and `retarget` at runtime. Keep names and behaviour stable.
- Build host: the combined tree `../vencord` (both plugins symlinked into `src/userplugins/`). Verify with
  `pnpm build && pnpm test` there. Fix alias trouble from this repo (see `tsconfig.json`), never by editing Vencord.
- Hands off the running Vesktop, its settings, and `~/.config/vesktop`. The user live-tests.
- Public repo (GitHub HefKer/vc-presets): small commits to `main`; push only when the user asks.
