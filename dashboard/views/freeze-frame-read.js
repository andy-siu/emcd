// @ts-check

import van from "../vendor/van-1.6.1.js";
import { OwnerActionRow } from "./owner-action.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { MUTED } from "../lib/colors.js";
import { serviceRefusal, serviceRefused } from "../lib/service-gate-caption.js";
import { request } from "../lib/transport.js";
import { StoredRecords, loadRecordedValues } from "./recorded-values.js";

// The service sheet's third read: every stored freeze frame — the `0x18` list of components
// that have a record, then `0x17` for each one.
//
// ⚠️ ONE control, mounted in two places — the service sheet and the fault report — and
// never copied: every control that puts a frame on the bike's bus is behind one gate, one
// arming convention and one refusal caption, and a second COPY of a bus read would be a
// second place to forget one of the three. Both mounts share this module's busy/message
// state and the one arming key; they are never on screen together (the sheet is a
// destination page that replaces the view), and every navigation disarms.
//
// The records themselves are drawn by ./recorded-values.js — the same renderer, and the
// same fetched reading, the opened codes on the Faults tab use — so the list under this
// button and the values under a code cannot disagree.
//
// ⚠️ It arms like an irreversible action even though it only READS, and with more reason
// than the lifetime read has: this parks the 2 Hz OBD poller for up to twelve seconds — the
// speed, the rpm and the temperatures leave the dashboard AND the ride log for that long —
// and it is the one read whose length the bike decides. src/vcu/freeze-frame-read.ts.

/** @typedef {import("../../src/http/freeze-frame-read.ts").FreezeFrameReadResponse} FreezeFrameReadResponse */

const { button, div } = van.tags;

/** This control's arming key. Exported so scripts/check-arming.ts can resolve the site. */
export const ARMED_KEY = "freeze-frame-read";
const busy = van.state(false);
const message = van.state("");

/**
 * The button, and whatever the last read said.
 *
 * @param {() => { enabled: boolean; gate: { safe: boolean } } | null} readState the /vcu-read
 *   state of whichever page mounts it, which carries the gate and the switch this shares.
 *   Null until that page has heard from emcool, and the button stays disabled until then:
 *   a live-looking button before the gate is known would be a claim nobody has checked.
 */
export function FreezeFrameReadButton(readState) {
  return div(
    { class: "settings-card" },
    OwnerActionRow(
      "Stored fault records",
      button(
        {
          class: "action",
          // One held Enter must not arm and then fire. See ../lib/arming.js.
          onkeydown: refuseKeyRepeat,
          disabled: () => busy.val || readState() === null || serviceRefused(readState()),
          onclick: () => {
            if (armed.val !== ARMED_KEY) {
              arm(ARMED_KEY);
              return;
            }
            // Ignored inside the dwell, not disarmed — the rule every other second tap on
            // this dashboard follows.
            if (!armDwellElapsed()) {
              return;
            }
            armed.val = "";
            void performFreezeFrameRead();
          },
        },
        () => {
          if (busy.val) {
            return "⏳  Reading every stored fault record…";
          }
          const state = readState();
          if (state === null) {
            return "…  Asking emcool whether the bike can be read";
          }
          const refusal = serviceRefusal(state);
          if (refusal !== null) {
            return refusal;
          }
          if (armed.val === ARMED_KEY) {
            return "⚠  Tap again — this parks the OBD poller for up to 12 s";
          }
          return "🔎  Read the stored fault records";
        }
      ),
      () => (armed.val === ARMED_KEY ? "Confirm read" : "Read")
    ),
    () => (message.val ? div({ class: "action-note" }, message.val) : div()),
    div(
      { class: "action-note", style: `color:${MUTED}` },
      "What the VCU recorded when each stored code set, listed below — and under each code in the fault report."
    ),
    StoredRecords()
  );
}

/**
 * Clears the last result and re-fetches what is stored. Called when the sheet or the fault
 * report opens, alongside everything else they disarm.
 */
export function refreshFreezeFrameRead() {
  message.val = "";
  void loadRecordedValues();
}

async function performFreezeFrameRead() {
  busy.val = true;
  message.val = "";
  try {
    const response = await request("/freeze-frame-read", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Emcool": "service-mode" },
    });
    const payload = /** @type {FreezeFrameReadResponse} */ (await response.json());
    // ⚠️ The summary AND the message, never one instead of the other: a read that was
    // correctly refused storage still happened, and what it found is the thing worth
    // seeing. src/vcu/freeze-frame-store.ts decides; this only reports what it decided.
    message.val = [payload.summary, payload.message].filter(Boolean).join(" · ");
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frames go
    // out before the response — and the reading may well be stored. Says so rather than
    // implying nothing happened.
    console.warn("freeze-frame-read: request failed", error);
    message.val =
      `Could not reach emcool — ${error instanceof Error ? error.message : String(error)}. ` +
      "The read may have completed anyway; the list below shows the age of what is stored.";
  } finally {
    busy.val = false;
    // ⚠️ After EVERY ending, the failed request included: a request that did not come back
    // may still have stored a reading, and the list is the way to find out. This is also the
    // Faults tab's copy — one fetched reading — so the opened codes are current too.
    void loadRecordedValues();
  }
}
