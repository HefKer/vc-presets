/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelStore, FluxDispatcher, MediaEngineStore, SelectedChannelStore, showToast, UserStore } from "@webpack/common";

import { PresetEditor } from "./PresetEditor";
import { clonePresets, Preset, resolveAudioNodes, SEED_PRESETS, VenmicNode } from "./presets";

export type { Preset } from "./presets";

const Native = VencordNative.pluginHelpers.VcPresets as PluginNative<typeof import("./native")>;
const logger = new Logger("VcPresets");

// Discord's own Go Live actions (web build). Each string occurs once in Discord's bundle.
const startStreamAction: (guildId: string | null, channelId: string, opts: Record<string, any>) => void = findByCodeLazy('type:"STREAM_START"');
const stopStreamAction: (streamKey: string) => void = findByCodeLazy('type:"STREAM_STOP"');

/** How long to keep the picker skip armed: covers the time spent in the portal dialog. */
const ARM_MS = 120_000;

export const settings = definePluginSettings({
    presets: {
        type: OptionType.CUSTOM,
        default: clonePresets(SEED_PRESETS) as Preset[],
    },
    editor: {
        type: OptionType.COMPONENT,
        component: () => <Editor />
    },
    niriPath: {
        type: OptionType.STRING,
        description: "niri binary used for `niri msg` (a full path if Vesktop's PATH lacks it)",
        default: "niri"
    },
    shareCastTargetPath: {
        type: OptionType.STRING,
        description: "Helper that picks \"niri Dynamic Cast Target\" in the GNOME Share Screen dialog, then sets the target",
        default: "share-cast-target"
    }
});

const toastError = (e: unknown) => showToast({ text: String(e instanceof Error ? e.message : e), variant: "critical" });

function Editor() {
    const { presets } = settings.use(["presets"]);
    return (
        <PresetEditor
            presets={presets}
            setPresets={p => settings.store.presets = p}
            onStart={name => plugin.startPreset(name).then(
                () => showToast({ text: `Live with preset "${name}"`, variant: "success" }),
                toastError
            )}
            onRetarget={name => plugin.retarget(name).then(
                () => showToast({ text: `Cast target set from preset "${name}"`, variant: "success" }),
                toastError
            )}
        />
    );
}

/** Preset being started or streamed: drives the quality patch and the getDisplayMedia post-processing. */
let active: Preset | null = null;
let starting = false;
let originalGetDisplayMedia: MediaDevices["getDisplayMedia"] | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function me() {
    return UserStore.getCurrentUser().id;
}

function ownStreamKey(): string | null {
    const s = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (!s) return null;
    return s.streamType === "call" || !s.guildId
        ? `call:${s.channelId}:${s.ownerId}`
        : `guild:${s.guildId}:${s.channelId}:${s.ownerId}`;
}

function size(p: Preset) {
    const height = p.resolution;
    return { width: Math.round(height * 16 / 9), height };
}

function findPreset(name: string): Preset {
    const p = settings.store.presets.find(x => x.name === name);
    if (!p) {
        const known = settings.store.presets.map(x => x.name).join(", ") || "none";
        throw new Error(`Unknown preset "${name}" (known: ${known})`);
    }
    return p;
}

const niriBin = () => settings.store.niriPath || "niri";

/** The `niri msg action` args for the preset's video, or null to leave the pick to the user in the portal dialog. */
async function castArgs(p: Preset): Promise<string[] | null> {
    if (!p.video) return null;
    const target = "monitor" in p.video ? { monitor: p.video.monitor } : { window: p.video.window };
    const res = await Native.castAction(target, niriBin());
    if (!res.ok) throw new Error(`niri: ${res.error}`);
    return res.value;
}

/**
 * Stored presets from earlier designs: `{ windowAppId }` (first niri version) and
 * `{ monitorOfWindow }` (xdg-desktop-portal-wlr) both become `{ window }`.
 */
function migratePresets() {
    const presets = settings.store.presets as any[];
    const old = (v: any) => v && ("windowAppId" in v || "monitorOfWindow" in v);
    if (!presets.some(p => old(p.video))) return;
    settings.store.presets = presets.map(p => old(p.video)
        ? { ...p, video: { window: p.video.windowAppId ?? p.video.monitorOfWindow } }
        : p);
}

/** Toasts as soon as share-cast-target fails, since the capture keeps waiting on the dialog. */
function watchShare(): () => void {
    const timer = setInterval(async () => {
        const st = await Native.shareStatus();
        if (!st || st.running) return;
        clearInterval(timer);
        if (st.code !== 0)
            showToast({ text: `VcPresets: ${st.error || "share-cast-target failed"}. Pick "niri Dynamic Cast Target" in the dialog yourself.`, variant: "critical", duration: 8000 });
    }, 500);
    return () => clearInterval(timer);
}

async function startAudio(p: Preset) {
    if (p.audio === "None") return;
    if (!IS_VESKTOP || !VesktopNative?.virtmic) {
        showToast({ text: "VcPresets: not running in Vesktop, so no stream audio", variant: "critical" });
        return;
    }

    const listed = await VesktopNative.virtmic.list();
    const live: VenmicNode[] = listed?.ok ? listed.targets : [];

    if (p.audio === "Entire System") {
        const { nodes } = resolveAudioNodes(p.excludeSources ?? [], live);
        await VesktopNative.virtmic.startSystem(nodes);
        return;
    }

    const { nodes, unmatched } = resolveAudioNodes(p.audio, live);
    if (unmatched.length)
        showToast({ text: `VcPresets: no audio source playing for ${unmatched.join(", ")} yet; it is linked once it starts`, variant: "default" });
    await VesktopNative.virtmic.start(nodes);
}

/** Outer getDisplayMedia wrapper: runs after Vesktop's, so the preset's content hint and constraints win. */
function wrapGetDisplayMedia() {
    if (originalGetDisplayMedia) return;
    const md = navigator.mediaDevices;
    originalGetDisplayMedia = md.getDisplayMedia;
    const orig = originalGetDisplayMedia;
    md.getDisplayMedia = async function (this: MediaDevices, opts?: DisplayMediaStreamOptions) {
        const stream = await orig.call(this, opts);
        const p = active;
        const track = stream.getVideoTracks()[0];
        if (p && track) {
            track.contentHint = p.contentHint;
            const { width, height } = size(p);
            track.applyConstraints({
                ...track.getConstraints(),
                frameRate: { min: p.frameRate, ideal: p.frameRate },
                width: { min: 640, ideal: width, max: width },
                height: { min: 480, ideal: height, max: height },
                advanced: [{ width, height }],
                // @ts-expect-error not in lib.dom yet
                resizeMode: "none"
            }).catch(e => logger.error("applyConstraints failed", e));
        }
        return stream;
    };
}

function unwrapGetDisplayMedia() {
    if (originalGetDisplayMedia) navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
    originalGetDisplayMedia = null;
}

/** Same as Vesktop's modal does on Go Live: cap the outgoing stream's parameters. */
function applyStreamParameters(p: Preset) {
    const { width, height } = size(p);
    const conn: any = [...MediaEngineStore.getMediaEngine().connections].find(c => c.streamUserId === me());
    const param = conn?.videoStreamParameters?.[0];
    if (!param) return;
    param.maxFrameRate = p.frameRate;
    param.maxResolution ??= { width: 0, height: 0 };
    param.maxResolution.width = width;
    param.maxResolution.height = height;
}

function onStreamClose({ streamKey }: { streamKey: string; }) {
    if (streamKey?.split(":").at(-1) === me()) active = null;
}

const plugin = definePlugin({
    name: "VcPresets",
    description: "Screenshare presets: one call sets niri's dynamic cast target, venmic audio and quality, and goes live without Vesktop's audio dialog.",
    authors: [{ name: "HefKer", id: 0n }],
    settings,

    patches: [
        {
            // Vesktop wraps the same call with its own quality; match either form so ours ends up outermost.
            find: "this.getDefaultGoliveQuality()",
            replacement: {
                match: /VesktopPatchGlobals\.patchStreamQuality\(this\.getDefaultGoliveQuality\(\)\)|this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.patchQuality($&)"
            }
        }
    ],

    patchQuality(opts: any) {
        const p = active;
        if (!p || !opts) return opts;
        const { width, height } = size(p);
        const q = { framerate: p.frameRate, width, height, pixelCount: width * height };
        if (opts.encode) Object.assign(opts.encode, q);
        if (opts.capture) Object.assign(opts.capture, q);
        return opts;
    },

    start() {
        migratePresets();
        wrapGetDisplayMedia();
        FluxDispatcher.subscribe("STREAM_CLOSE", onStreamClose);
    },

    stop() {
        unwrapGetDisplayMedia();
        FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamClose);
        Native.disarmPicker();
        active = null;
    },

    // --- public API (QuickActions, formerly VcActions, calls these through Vencord.Plugins.plugins.VcPresets) ---

    listPresets(): Preset[] {
        return clonePresets(settings.store.presets);
    },

    async startPreset(name: string): Promise<void> {
        const p = clonePresets([findPreset(name)])[0];
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) throw new Error("Not in a voice channel");
        if (starting) throw new Error("A preset is already starting");
        const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;

        starting = true;
        try {
            if (ownStreamKey()) {
                this.stopStream();
                await sleep(750);
            }

            const args = await castArgs(p);
            active = p;
            await startAudio(p);
            const armedAt = Date.now();
            await Native.armPicker({ contentHint: p.contentHint }, ARM_MS);

            // Discord's web Go Live path: getDisplayMedia via the media engine, then STREAM_START with the track id.
            // Run inside a native executeJavaScript(userGesture) so Chromium's transient-activation rule can't block it.
            // The helper waits for the portal dialog the capture is about to open, so spawn it first, unawaited.
            let stopWatching = () => { };
            if (args) {
                await Native.spawnShare(settings.store.shareCastTargetPath || "share-cast-target", args);
                stopWatching = watchShare();
            }
            const capture = await Native.captureWithGesture(size(p));
            stopWatching();
            if (!capture.ok) {
                logger.error("Capture failed:", capture.error);
                const st = args && await Native.shareStatus();
                const helper = st && !st.running && st.code !== 0 ? ` (share-cast-target: ${st.error})` : "";
                throw new Error(`Screen capture was cancelled or failed: ${capture.error.split("\n")[0]}${helper}`);
            }
            const sourceId = capture.value;

            startStreamAction(guildId, channelId, {
                pid: null,
                sourceId,
                sourceName: null,
                audioSourceId: null,
                sound: true,
                previewDisabled: false
            });
            applyStreamParameters(p);
            setTimeout(() => applyStreamParameters(p), 500);

            if (await Native.lastPickerHandled() < armedAt)
                logger.warn("Vesktop's picker was not intercepted; its modal may have been shown");
        } catch (e) {
            active = null;
            Native.disarmPicker();
            Native.killShare();
            if (!ownStreamKey()) VesktopNative?.virtmic?.stop();
            throw e;
        } finally {
            starting = false;
        }
    },

    stopStream(): void {
        const key = ownStreamKey();
        if (key) stopStreamAction(key);
        active = null;
    },

    async retarget(name: string): Promise<void> {
        const p = findPreset(name);
        if (!ownStreamKey()) throw new Error("Not streaming");
        const args = await castArgs(p);
        if (!args) throw new Error(`Preset "${name}" has no video target`);
        const res = await Native.niriAction(args, niriBin());
        if (!res.ok) throw new Error(`niri: ${res.error}`);
    },

    /** Called by native captureWithGesture inside executeJavaScript; returns the desktop source id. */
    _capture(width: number, height: number): Promise<string> {
        return (MediaEngineStore.getMediaEngine() as any).getDesktopSource({ width, height }, true);
    }
});

export default plugin;
