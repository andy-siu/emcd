// @ts-check

import van from "../vendor/van-1.6.1.js";
import { OwnerActionRow } from "./owner-action.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { GOOD, MUTED, WARN } from "../lib/colors.js";
import { request } from "../lib/transport.js";
import { connection } from "../lib/store.js";
import { BLE_MODE } from "../lib/ble-link.js";

// The service sheet's ECU firmware read: what firmware each of the bike's ECUs runs, beside what
// the firmware package revisions Energica's upgrade check knows (42 and 43) carry, and which of
// them it matches. "neither" is older firmware not yet upgraded, or a package the table doesn't cover.
// POST /ecu-firmware (components/emcool_ble_server/include/emcool/ble_server/endpoints.hpp).
//
// ⚠️ It arms like the lifetime read. Unlike the rest of the service sheet's reads it needs no
// service mode, but it does SEND on the bus: it asks the PSU's two micros and the keylock for
// their software ids, and listens for up to 5 s.

/**
 * @typedef {{ name: string; running: string; known: string[]; match: string }} EcuFirmwareRow
 * @typedef {{ revisions: number[]; listenedSeconds: number; rows: EcuFirmwareRow[]; notes: string[] }} EcuFirmwareReading
 */

const { button, div, table, thead, tbody, tr, th, td } = van.tags;

/** This control's arming key, exported as ./lifetime-read.js exports its own. */
export const ARMED_KEY = "ecu-firmware";
const busy = van.state(false);
const message = van.state("");
const reading = van.state(/** @type {EcuFirmwareReading | null} */ (null));
const linkReady = () => connection.val === "live" && BLE_MODE;

/** @param {string} match a revision ("43", "42 and 43"), "neither (…)", "?" or "-" */
function matchColor(match) {
  if (/^[0-9]/.test(match)) return GOOD;
  if (match.startsWith("neither")) return WARN;
  return MUTED;
}

/** @param {string} match */
function matchWords(match) {
  if (/^[0-9]/.test(match)) return `rev ${match}`;
  if (match === "?") return "? · no number to compare";
  if (match === "-") return "–";
  return match;
}

/** The card: the button, the table of the last read, and its notes. */
export function EcuFirmwareRead() {
  return div(
    { class: "settings-card" },
    OwnerActionRow(
      "ECU firmware versions",
      button(
        {
          class: "action",
          // One held Enter must not arm and then fire. See ../lib/arming.js.
          onkeydown: refuseKeyRepeat,
          disabled: () => busy.val || !linkReady(),
          onclick: () => {
            if (armed.val !== ARMED_KEY) {
              arm(ARMED_KEY);
              return;
            }
            if (!armDwellElapsed()) return;
            armed.val = "";
            void performEcuFirmwareRead();
          },
        },
        () => {
          if (busy.val) return "⏳  Listening to the ECUs (up to 5 s)…";
          if (!linkReady()) return "Connect over Bluetooth to read the ECUs";
          if (armed.val === ARMED_KEY) return "⚠  Tap again — this asks the PSU and keylock over the bus";
          return "🔎  Read what firmware each ECU runs";
        }
      ),
      () => (armed.val === ARMED_KEY ? "Confirm read" : "Read")
    ),
    () => (message.val ? div({ class: "action-note" }, message.val) : div()),
    () => {
      const last = reading.val;
      if (last === null) return div();
      return div(
        div(
          { class: "action-note", style: `color:${MUTED}` },
          `Listened ${last.listenedSeconds.toFixed(1)} s. Beside what package revisions ` +
            `${last.revisions.join(" and ")} carry. Neither means older firmware not yet upgraded, ` +
            "or a package the table doesn't cover."
        ),
        table(
          { class: "module-readings ecu-firmware" },
          thead(tr(th("ECU"), th("On the bike"), ...last.revisions.map(rev => th(`Rev ${rev}`)), th("In"))),
          tbody(
            ...last.rows.map(row =>
              tr(
                td(row.name),
                td(row.running),
                ...row.known.map(version => td(version)),
                td({ style: `color:${matchColor(row.match)}` }, matchWords(row.match))
              )
            )
          )
        ),
        ...last.notes.map(note => div({ class: "action-note", style: `color:${MUTED}` }, note))
      );
    },
    div(
      { class: "action-note", style: `color:${MUTED}` },
      "VCU Control and Safety, the PSU's two micros, the dashboard and the keylock. Needs the bike on; the PSU and keylock answer only with OBD_ENABLED."
    )
  );
}

/** Clears the last result, so a table from another motorcycle never shows as this one's. */
export function refreshEcuFirmwareRead() {
  message.val = "";
  reading.val = null;
}

async function performEcuFirmwareRead() {
  busy.val = true;
  message.val = "";
  // A failed read leaves no old table under its error.
  reading.val = null;
  try {
    const response = await request("/ecu-firmware", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Emcool": "ecu-firmware" },
    });
    if (response.status === 404) {
      message.val = "This emcool firmware can't read the ECUs' versions. Update emcool.";
      return;
    }
    // By status, not content type: the Bluetooth tunnel's answer carries no headers. 200, 409
    // and 503 are JSON; the refusals before a read starts are text.
    if (![200, 409, 503].includes(response.status)) {
      message.val = `The bike answered ${response.status}: ${(await response.text()).trim()}`;
      return;
    }
    const payload = /** @type {EcuFirmwareReading | { error: string }} */ (await response.json());
    if ("error" in payload) {
      message.val = `Not read: ${payload.error}.`;
      return;
    }
    reading.val = payload;
  } catch (error) {
    console.warn("ecu-firmware: request failed", error);
    message.val = `Could not reach emcool — ${error instanceof Error ? error.message : String(error)}.`;
  } finally {
    busy.val = false;
  }
}
