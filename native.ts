/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main-process half of VcPresets: drives niri's Dynamic Cast Target and
// answers Vesktop's screenshare picker for a preset-started stream.

import { execFile } from "child_process";
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";

export type CastTarget = { monitor: string; } | { windowAppId: string; } | { clear: true; };
export type NativeResult = { ok: true; detail: string; } | { ok: false; error: string; };

/** Vesktop's main->renderer command channel and the picker command sent over it (Vesktop 1.6.x, src/shared/IpcEvents.ts). */
const IPC_COMMAND = "VCD_IPC_COMMAND";
const SCREEN_SHARE_PICKER = "screenshare:picker";

function run(bin: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${bin} ${args.join(" ")}: ${(stderr || err.message).trim()}`));
            else resolve(stdout);
        });
    });
}

interface NiriWindow { id: number; app_id?: string | null; title?: string | null; is_focused?: boolean; }

export async function setCastTarget(_: IpcMainInvokeEvent, target: CastTarget, niriBin = "niri"): Promise<NativeResult> {
    try {
        if ("clear" in target) {
            await run(niriBin, ["msg", "action", "clear-dynamic-cast-target"]);
            return { ok: true, detail: "cleared" };
        }
        if ("monitor" in target) {
            await run(niriBin, ["msg", "action", "set-dynamic-cast-monitor", target.monitor]);
            return { ok: true, detail: `monitor ${target.monitor}` };
        }

        let re: RegExp;
        try {
            re = new RegExp(target.windowAppId, "i");
        } catch (e) {
            return { ok: false, error: `Bad window app_id regex ${target.windowAppId}: ${e}` };
        }
        const windows: NiriWindow[] = JSON.parse(await run(niriBin, ["msg", "--json", "windows"]));
        const matches = windows.filter(w => w.app_id && re.test(w.app_id));
        const win = matches.find(w => w.is_focused) ?? matches[0];
        if (!win) return { ok: false, error: `No open window whose app_id matches /${target.windowAppId}/i` };

        await run(niriBin, ["msg", "action", "set-dynamic-cast-window", "--id", String(win.id)]);
        return { ok: true, detail: `window ${win.id} (${win.app_id}: ${win.title ?? ""})` };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
 */
export function captureWithGesture(e: IpcMainInvokeEvent, size: { width: number; height: number; }): Promise<string> {
    const w = Math.round(Number(size.width)), h = Math.round(Number(size.height));
    return e.sender.executeJavaScript(`Vencord.Plugins.plugins.VcPresets._capture(${w}, ${h})`, true);
}
