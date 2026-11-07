/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main-process half of VcPresets: drives niri's Dynamic Cast Target (through the
// share-cast-target helper while the portal dialog is up, plain `niri msg` mid-stream)
// and answers Vesktop's screenshare picker for a preset-started stream.

import { ChildProcess, execFile, spawn } from "child_process";
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";

export type VideoTarget = { monitor: string; } | { window: string; };
export type NativeResult<T = string> = { ok: true; value: T; } | { ok: false; error: string; };

/** Vesktop's main->renderer command channel and the picker command sent over it (Vesktop 1.6.x, src/shared/IpcEvents.ts). */
const IPC_COMMAND = "VCD_IPC_COMMAND";
const SCREEN_SHARE_PICKER = "screenshare:picker";

function errorText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
}

function run(bin: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${bin} ${args.join(" ")}: ${(stderr || err.message).trim()}`));
            else resolve(stdout);
        });
    });
}

interface NiriWindow { id: number; app_id?: string | null; title?: string | null; is_focused?: boolean; }

/** The `niri msg action` arguments that make the preset's video the dynamic cast target. */
export async function castAction(_: IpcMainInvokeEvent, target: VideoTarget, niriBin = "niri"): Promise<NativeResult<string[]>> {
    try {
        if ("monitor" in target) return { ok: true, value: ["set-dynamic-cast-monitor", target.monitor] };

        let re: RegExp;
        try {
            re = new RegExp(target.window, "i");
        } catch (e) {
            return { ok: false, error: `Bad window app_id regex ${target.window}: ${errorText(e)}` };
        }
        const windows: NiriWindow[] = JSON.parse(await run(niriBin, ["msg", "--json", "windows"]));
        const matches = windows.filter(w => w.app_id && re.test(w.app_id));
        const win = matches.find(w => w.is_focused) ?? matches[0];
        if (!win) return { ok: false, error: `No open window whose app_id matches /${target.window}/i` };
        return { ok: true, value: ["set-dynamic-cast-window", "--id", String(win.id)] };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
}

/** Mid-stream retarget: the cast is already running, so plain `niri msg action` is enough. */
export async function niriAction(_: IpcMainInvokeEvent, args: string[], niriBin = "niri"): Promise<NativeResult> {
    try {
        await run(niriBin, ["msg", "action", ...args]);
        return { ok: true, value: args.join(" ") };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
}

// --- share-cast-target -----------------------------------------------------
//
// niri holds back the stream, and so the portal's reply, until a dynamic target
// is set, so the target can only be set after the GNOME "Share Screen" dialog.
// share-cast-target (from the NixOS config) waits for that dialog, picks "niri
// Dynamic Cast Target" by keystrokes, presses Share, then runs
// `niri msg action <args>`. Exit 0 = shared; otherwise the reason is on stderr.
// It is spawned just before the capture and not awaited, since the capture is
// what opens the dialog.

export interface ShareStatus { running: boolean; code: number | null; error: string; }

let share: { child: ChildProcess | null; status: ShareStatus; } | null = null;

export function spawnShare(_: IpcMainInvokeEvent, bin: string, args: string[]): ShareStatus {
    killShare();
    const status: ShareStatus = { running: true, code: null, error: "" };
    const entry = { child: null as ChildProcess | null, status };
    share = entry;
    try {
        const child = spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
        entry.child = child;
        child.stderr?.on("data", d => { status.error = (status.error + d).slice(-2000); });
        child.on("error", e => { status.running = false; status.error ||= `${bin}: ${e.message}`; });
        child.on("exit", (code, signal) => {
            status.running = false;
            status.code = code;
            if (code !== 0 && !status.error) status.error = `${bin} exited with ${signal ?? code}`;
            entry.child = null;
        });
    } catch (e) {
        status.running = false;
        status.error = `${bin}: ${errorText(e)}`;
    }
    return { ...status };
}

export function shareStatus(): ShareStatus | null {
    return share && { ...share.status, error: share.status.error.trim() };
}

export function killShare() {
    if (share?.child && share.status.running) share.child.kill();
}

// --- Vesktop picker interception -------------------------------------------
//
// On Wayland, Vesktop's display-media handler sends the renderer
// `screenshare:picker` over IPC_COMMAND and waits for the reply; the renderer
// opens the quality/audio modal and starts venmic on submit. While armed, we
// swallow that one command and reply ok ourselves, so the modal never opens.
// The renderer has already started venmic with the preset's sources.

interface PickerCommand { nonce: string; message: string; data?: { screens?: { id: string; }[]; skipPicker?: boolean; }; }
interface Reply { contentHint: string; }

let armed: { reply: Reply; until: number; } | null = null;
let lastHandled = 0;
let installed = false;

function installHook(sender: WebContents) {
    if (installed) return;
    const proto = Object.getPrototypeOf(sender) as WebContents;
    const original = proto.send;
    proto.send = function (this: WebContents, channel: string, ...args: any[]) {
        const cmd = args[0] as PickerCommand | undefined;
        if (channel === IPC_COMMAND && cmd?.message === SCREEN_SHARE_PICKER && armed && Date.now() < armed.until
            && cmd.data?.skipPicker && cmd.data.screens?.[0]) {
            const { reply } = armed;
            armed = null;
            lastHandled = Date.now();
            const pick = { id: cmd.data.screens[0].id, audio: true, contentHint: reply.contentHint, includeSources: "None" };
            // Deliver the reply as if the renderer had sent it back.
            setImmediate(() => ipcMain.emit(IPC_COMMAND, { sender: this }, { nonce: cmd.nonce, ok: true, data: pick }));
            return;
        }
        return original.call(this, channel, ...args);
    };
    installed = true;
}

/** Skip Vesktop's picker modal for the next screenshare request within `timeoutMs`. */
export function armPicker(e: IpcMainInvokeEvent, reply: Reply, timeoutMs: number) {
    installHook(e.sender);
    armed = { reply, until: Date.now() + timeoutMs };
    return true;
}

export function disarmPicker() {
    armed = null;
}

/** Epoch ms of the last picker request we answered, so the renderer can tell whether the skip worked. */
export function lastPickerHandled() {
    return lastHandled;
}

/**
 * Runs the renderer's capture call as a user gesture, so getDisplayMedia works
 * from a global hotkey or timer too, not only from a click in the window.
 * Rejections are serialized in the page: executeJavaScript would otherwise
 * turn a DOMException or plain object into "[object Object]".
 */
export async function captureWithGesture(e: IpcMainInvokeEvent, size: { width: number; height: number; }): Promise<NativeResult> {
    const w = Math.round(Number(size.width)), h = Math.round(Number(size.height));
    const code = `Promise.resolve().then(() => Vencord.Plugins.plugins.VcPresets._capture(${w}, ${h})).then(
        value => ({ ok: true, value: String(value) }),
        e => {
            let text;
            if (e instanceof Error || (e && typeof e === "object" && "message" in e)) text = [e.name, e.message].filter(Boolean).join(": ") + (e.stack ? "\\n" + e.stack : "");
            else if (e && typeof e === "object") { try { text = JSON.stringify(e); } catch { text = String(e); } }
            else text = String(e);
            return { ok: false, error: text };
        })`;
    try {
        return await e.sender.executeJavaScript(code, true);
    } catch (err) {
        return { ok: false, error: `executeJavaScript: ${errorText(err)}` };
    }
}
