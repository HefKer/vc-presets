/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { TextInput, useState } from "@webpack/common";

import { AudioSelection, CONTENT_HINTS, FRAME_RATES, Preset, RESOLUTIONS, SEED_PRESETS, splitList, VideoTarget } from "./presets";

const cl = classNameFactory("vc-presets-");

type VideoKind = "none" | "monitor" | "window";
type AudioKind = "None" | "Entire System" | "apps";

const videoKind = (v: VideoTarget): VideoKind => v == null ? "none" : "monitor" in v ? "monitor" : "window";
const videoValue = (v: VideoTarget) => v == null ? "" : "monitor" in v ? v.monitor : v.window;
const audioKind = (a: AudioSelection): AudioKind => Array.isArray(a) ? "apps" : a;

function makeVideo(kind: VideoKind, value: string): VideoTarget {
    if (kind === "monitor") return { monitor: value || "DP-3" };
    if (kind === "window") return { window: value || "^osu!$" };
    return null;
}

/** Text field that commits on blur, so typing doesn't rewrite settings on every key. */
function Field({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit(v: string): void; }) {
    const [draft, setDraft] = useState(value);
    return (
        <TextInput
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            onChange={setDraft}
            onBlur={() => draft !== value && onCommit(draft)}
        />
    );
}

function Choice<T extends string | number>({ value, options, labels, onChange }: {
    value: T; options: readonly T[]; labels?: string[]; onChange(v: T): void;
}) {
    return (
        <select
            className={cl("select")}
            value={String(value)}
            onChange={e => onChange(options.find(o => String(o) === e.currentTarget.value)!)}
        >
            {options.map((o, i) => <option key={String(o)} value={String(o)}>{labels?.[i] ?? String(o)}</option>)}
        </select>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode; }) {
    return (
        <label className={cl("row")}>
            <span className={cl("label")}>{label}</span>
            <div className={cl("control")}>{children}</div>
        </label>
    );
}

function PresetCard({ preset, onChange, onDelete, onStart, onRetarget }: {
    preset: Preset;
    onChange(p: Preset): void;
    onDelete(): void;
    onStart(): void;
    onRetarget(): void;
}) {
    const set = (patch: Partial<Preset>) => onChange({ ...preset, ...patch });
    const vk = videoKind(preset.video);
    const ak = audioKind(preset.audio);

    return (
        <div className={cl("card")}>
            <Row label="Name">
                <Field value={preset.name} onCommit={name => name.trim() && set({ name: name.trim() })} />
            </Row>
            <Row label="Video">
                <div className={cl("pair")}>
                    <Choice<VideoKind>
                        value={vk}
                        options={["none", "monitor", "window"]}
                        labels={["Pick in dialog", "Monitor", "Window (app_id regex)"]}
                        onChange={k => set({ video: makeVideo(k, k === vk ? videoValue(preset.video) : "") })}
                    />
                    {vk !== "none" && (
                        <Field
                            key={vk}
                            value={videoValue(preset.video)}
                            placeholder={vk === "monitor" ? "DP-3" : "^osu!$"}
                            onCommit={v => set({ video: makeVideo(vk, v.trim()) })}
                        />
                    )}
                </div>
            </Row>
            <Row label="Audio">
                <div className={cl("pair")}>
                    <Choice<AudioKind>
                        value={ak}
                        options={["None", "Entire System", "apps"]}
                        labels={["None", "Entire System", "Only these apps"]}
                        onChange={k => set({ audio: k === "apps" ? (Array.isArray(preset.audio) ? preset.audio : []) : k })}
                    />
                    {ak === "apps" && (
                        <Field
                            value={(preset.audio as string[]).join(", ")}
                            placeholder="osu!, firefox"
                            onCommit={v => set({ audio: splitList(v) })}
                        />
                    )}
                    {ak === "Entire System" && (
                        <Field
                            value={(preset.excludeSources ?? []).join(", ")}
                            placeholder="Exclude: spotify, ..."
                            onCommit={v => set({ excludeSources: splitList(v) })}
                        />
                    )}
                </div>
            </Row>
            <Row label="Quality">
                <div className={cl("pair")}>
                    <Choice value={preset.resolution} options={RESOLUTIONS} labels={RESOLUTIONS.map(r => `${r}p`)} onChange={resolution => set({ resolution })} />
                    <Choice value={preset.frameRate} options={FRAME_RATES} labels={FRAME_RATES.map(f => `${f} fps`)} onChange={frameRate => set({ frameRate })} />
                    <Choice value={preset.contentHint} options={CONTENT_HINTS} labels={["Prefer smoothness", "Prefer clarity"]} onChange={contentHint => set({ contentHint })} />
                </div>
            </Row>
            <div className={cl("buttons")}>
                <Button size="small" variant="positive" onClick={onStart}>Go live</Button>
                <Button size="small" variant="secondary" disabled={!preset.video} onClick={onRetarget}>Retarget</Button>
                <Button size="small" variant="dangerSecondary" onClick={onDelete}>Delete</Button>
            </div>
        </div>
    );
}

export function PresetEditor({ presets, setPresets, onStart, onRetarget }: {
    presets: Preset[];
    setPresets(p: Preset[]): void;
    onStart(name: string): void;
    onRetarget(name: string): void;
}) {
    const update = (i: number, p: Preset) => {
        if (presets.some((x, j) => j !== i && x.name === p.name)) return;
        setPresets(presets.map((x, j) => j === i ? p : x));
    };

    const add = () => {
        let n = presets.length + 1;
        while (presets.some(p => p.name === `preset${n}`)) n++;
        setPresets([...presets, { ...SEED_PRESETS[0], name: `preset${n}`, video: null, audio: "None" }]);
    };

    return (
        <div className={cl("editor")}>
            <Heading>Presets</Heading>
            <Paragraph>
                Names must be unique; VcActions and the API refer to presets by name. Video is niri's dynamic
                cast target, a monitor or the focused window matching an app_id regex; share-cast-target picks
                it in the Share Screen dialog. "Pick in dialog" leaves the choice to you. App names match any
                audio stream whose application or node name contains them, case-insensitively.
            </Paragraph>
            {presets.map((p, i) => (
                <PresetCard
                    key={i + JSON.stringify(p)}
                    preset={p}
                    onChange={np => update(i, np)}
                    onDelete={() => setPresets(presets.filter((_, j) => j !== i))}
                    onStart={() => onStart(p.name)}
                    onRetarget={() => onRetarget(p.name)}
                />
            ))}
            <div className={cl("buttons")}>
                <Button size="small" onClick={add}>Add preset</Button>
                <Button size="small" variant="secondary" onClick={() => setPresets(JSON.parse(JSON.stringify(SEED_PRESETS)))}>Reset to seeds</Button>
            </div>
        </div>
    );
}
