/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RESOLUTIONS = [480, 720, 1080, 1440, 2160] as const;
export const FRAME_RATES = [15, 30, 60] as const;
export const CONTENT_HINTS = ["motion", "detail"] as const;

export type VideoTarget = { monitor: string; } | { windowAppId: string; } | null;
/** "None", "Entire System", or app names (matched against venmic's application.name / node.name). */
export type AudioSelection = "None" | "Entire System" | string[];

export interface Preset {
    name: string;
    video: VideoTarget;
    audio: AudioSelection;
    /** Only used with audio "Entire System". */
    excludeSources?: string[];
    resolution: number;
    frameRate: number;
    contentHint: "motion" | "detail";
}

export const SEED_PRESETS: Preset[] = [
    {
        name: "screen",
        video: { monitor: "DP-3" },
        audio: "Entire System",
        excludeSources: [],
        resolution: 1080,
        frameRate: 60,
        contentHint: "motion"
    },
    {
        name: "osu",
        video: { windowAppId: "^osu" },
        audio: ["osu!"],
        resolution: 1080,
        frameRate: 60,
        contentHint: "motion"
    }
];

export function clonePresets(presets: Preset[]): Preset[] {
    return JSON.parse(JSON.stringify(presets));
}

/** Splits a comma separated list, dropping blanks. */
export function splitList(s: string): string[] {
    return s.split(",").map(x => x.trim()).filter(Boolean);
}

export type VenmicNode = Record<string, string>;

const NAME_PROPS = ["application.name", "node.name", "application.process.binary"] as const;

/**
 * Turns app names into venmic include/exclude nodes, using the live node list:
 * case-insensitive exact match first, then prefix. Names with no live node fall
 * back to a literal `application.name` rule, which venmic still applies if the
 * app starts playing later. Returns the names that matched nothing.
 */
export function resolveAudioNodes(names: string[], live: VenmicNode[]): { nodes: VenmicNode[]; unmatched: string[]; } {
    const nodes: VenmicNode[] = [];
    const unmatched: string[] = [];
    const seen = new Set<string>();
    const push = (n: VenmicNode) => {
        const key = JSON.stringify(n);
        if (!seen.has(key)) { seen.add(key); nodes.push(n); }
    };

    for (const name of names) {
        const want = name.toLowerCase();
        const exact = live.filter(n => NAME_PROPS.some(p => n[p]?.toLowerCase() === want));
        const found = exact.length ? exact : live.filter(n => NAME_PROPS.some(p => n[p]?.toLowerCase().startsWith(want)));
        if (!found.length) {
            unmatched.push(name);
            push({ "application.name": name });
            continue;
        }
        for (const n of found) {
            const prop = NAME_PROPS.find(p => n[p]);
            if (prop) push({ [prop]: n[prop] });
        }
    }
    return { nodes, unmatched };
}
