/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main-process half of VcPresets: tells the xdg-desktop-portal-wlr chooser which
// output to cast, and answers Vesktop's screenshare picker for a preset-started stream.

import { execFile } from "child_process";
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { rename, rm, writeFile } from "fs/promises";
import { join } from "path";

export type VideoTarget = { monitor: string; } | { monitorOfWindow: string; };
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

interface NiriWindow { id: number; app_id?: string | null; workspace_id?: number | null; is_focused?: boolean; }
interface NiriWorkspace { id: number; output?: string | null; }

/** Output name for a preset's video: the monitor itself, or the output showing the matching window's workspace. */
export async function resolveMonitor(_: IpcMainInvokeEvent, target: VideoTarget, niriBin = "niri"): Promise<NativeResult> {
    try {
        if ("monitor" in target) return { ok: true, value: target.monitor };

        let re: RegExp;
        try {
            re = new RegExp(target.monitorOfWindow, "i");
        } catch (e) {
            return { ok: false, error: `Bad window app_id regex ${target.monitorOfWindow}: ${errorText(e)}` };
        }
        const windows: NiriWindow[] = JSON.parse(await run(niriBin, ["msg", "--json", "windows"]));
        const matches = windows.filter(w => w.app_id && re.test(w.app_id));
        const win = matches.find(w => w.is_focused) ?? matches[0];
        if (!win) return { ok: false, error: `No open window whose app_id matches /${target.monitorOfWindow}/i` };

        const workspaces: NiriWorkspace[] = JSON.parse(await run(niriBin, ["msg", "--json", "workspaces"]));
        const output = workspaces.find(ws => ws.id === win.workspace_id)?.output;
        if (!output) return { ok: false, error: `Window ${win.app_id} is not on a workspace with an output` };
        return { ok: true, value: output };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
}

// --- xdpw chooser hand-off -------------------------------------------------
//
// The NixOS-side chooser for xdg-desktop-portal-wlr (chooser_type=simple) reads
// this file if it is under 30 s old, deletes it, and prints `Monitor: <name>`,
// so no menu appears. Otherwise it shows a menu of outputs.

function castTargetFile() {
    const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
    return join(dir, "xdpw-cast-target");
}

export async function writeCastTarget(_: IpcMainInvokeEvent, output: string): Promise<NativeResult> {
    const file = castTargetFile();
    try {
        // Write then rename, so the chooser never reads a half-written name.
        await writeFile(`${file}.tmp`, output, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        return { ok: true, value: file };
    } catch (e) {
        return { ok: false, error: `Writing ${file}: ${errorText(e)}` };
    }
}

/** Removes a target the chooser didn't consume, so it can't hijack a later manual share. */
export async function clearCastTarget() {
    await rm(castTargetFile(), { force: true }).catch(() => { });
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
