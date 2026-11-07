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

/** How long to keep the picker skip armed: covers the time spent in the xdg portal dialog. */
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
        description: "niri binary used for `niri msg` to find a window's monitor (a full path if Vesktop's PATH lacks it)",
        default: "niri"
    }
});

function Editor() {
    const { presets } = settings.use(["presets"]);
    return (
        <PresetEditor
            presets={presets}
            setPresets={p => settings.store.presets = p}
            onStart={name => plugin.startPreset(name).then(
                () => showToast({ text: `Live with preset "${name}"`, variant: "success" }),
                e => showToast({ text: String(e instanceof Error ? e.message : e), variant: "critical" })
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

/** Hands the preset's output to the xdpw chooser; with no video, clears any stale target so the menu shows. */
async function applyVideoTarget(p: Preset) {
    if (!p.video) {
        await Native.clearCastTarget();
        return;
    }
    const target = "monitor" in p.video ? { monitor: p.video.monitor } : { monitorOfWindow: p.video.monitorOfWindow };
    const output = await Native.resolveMonitor(target, settings.store.niriPath || "niri");
    if (!output.ok) throw new Error(output.error);
    const written = await Native.writeCastTarget(output.value);
    if (!written.ok) throw new Error(written.error);
    logger.info("Cast target ->", output.value);
}

/** Presets saved before the xdpw switch used `{ windowAppId }` (niri dynamic cast); cast the window's monitor instead. */
function migratePresets() {
    const presets = settings.store.presets as any[];
    if (!presets.some(p => p.video && "windowAppId" in p.video)) return;
    settings.store.presets = presets.map(p => p.video && "windowAppId" in p.video
        ? { ...p, video: { monitorOfWindow: p.video.windowAppId } }
        : p);
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
    description: "Screenshare presets: one call picks the monitor for xdg-desktop-portal-wlr, sets venmic audio and quality, and goes live without Vesktop's audio dialog.",
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

    // --- public API (VcActions calls these through Vencord.Plugins.plugins.VcPresets) ---

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

            await applyVideoTarget(p);
            active = p;
            await startAudio(p);
            const armedAt = Date.now();
            await Native.armPicker({ contentHint: p.contentHint }, ARM_MS);

            // Discord's web Go Live path: getDisplayMedia via the media engine, then STREAM_START with the track id.
            // Run inside a native executeJavaScript(userGesture) so Chromium's transient-activation rule can't block it.
            const capture = await Native.captureWithGesture(size(p));
            if (!capture.ok) {
                logger.error("Capture failed:", capture.error);
                throw new Error(`Screen capture was cancelled or failed: ${capture.error.split("\n")[0]}`);
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
            Native.clearCastTarget();
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

    /** Called by native captureWithGesture inside executeJavaScript; returns the desktop source id. */
    _capture(width: number, height: number): Promise<string> {
        return (MediaEngineStore.getMediaEngine() as any).getDesktopSource({ width, height }, true);
    }
});

export default plugin;
