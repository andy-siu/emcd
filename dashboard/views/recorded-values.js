// @ts-check

import van from "../vendor/van-1.6.1.js";
import { infokeyFault } from "../lib/infokey-bounds.js";
import { ageInWords, groupedReading } from "../lib/format.js";
import * as colors from "../lib/colors.js";
import { request } from "../lib/transport.js";

const { div, span } = van.tags;

// What the VCU recorded when one code set — the values, under the code that set them.
//
// ⚠️ IT NEVER SAYS "FREEZE FRAME", and that is not squeamishness. The Faults tab already
// uses that phrase, correctly, for OBD mode 01 PID 02's freeze-frame DTC — the code the
// bike captured when it lit the lamp — with its own tag and its own three-state caption.
// This is the KWP `0x17` per-component record, a different thing read a different way, and
// two things called "freeze frame" on one screen is how a reader stops trusting either.
// The wire, the store and the docs keep the protocol's name; the copy on the phone does not.
//
// ⚠️ Values are gated through lib/bounds.js and a rejected one is drawn as a FAULT, never
// clamped and never dropped. Real data contains sentinels, and a plausible-looking number
// invented from an implausible one is the failure that file exists to prevent.

/** @typedef {import("../../src/http/freeze-frames.ts").FreezeFramesResponse} FreezeFramesResponse */
/** @typedef {import("../../src/vcu/freeze-frame-store.ts").StoredFreezeFrameReading} StoredFreezeFrameReading */
/** @typedef {import("../../src/vcu/freeze-frame-store.ts").FreezeFrameRecord} FreezeFrameRecord */
/** @typedef {import("../../src/diagnostics/freeze-frame.ts").FreezeFrameValue} FreezeFrameValue */

/**
 * The last reading, from /freeze-frames. Null until the fetch lands; a failure leaves it
 * null and every code says "nothing has been read on this bike", which is the honest reading
 * of what the PAGE knows.
 */
const reading = van.state(/** @type {FreezeFramesResponse | null} */ (null));

let inFlight = false;

/**
 * Set when a load was asked for while one was already in flight. ⚠️ Not dropped: a load asked
 * for right after a read finishes must see THAT read, and the one already in flight may have
 * left before the read was stored. One more fetch is queued instead.
 */
let askedAgain = false;

/**
 * Set when the fetch itself failed, so the page can tell "nothing has been read" from "we
 * could not ask". ⚠️ They are different claims and only one is about the motorcycle —
 * `console.warn` already kept them apart in the journal; this is what keeps them apart on
 * screen.
 */
const fetchFailed = van.state("");

/**
 * Fetches the reading.
 *
 * Re-fetched on every entry to the Faults tab rather than cached for the session: a read is
 * taken from the service sheet, so coming back to Faults after taking one has to show it.
 * Cheap — one record per stored code, not the 39-row list.
 */
export async function loadRecordedValues() {
  if (inFlight) {
    askedAgain = true;
    return;
  }
  inFlight = true;
  askedAgain = false;
  try {
    const response = await request("/freeze-frames", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    reading.val = /** @type {FreezeFramesResponse} */ (await response.json());
    fetchFailed.val = "";
  } catch (error) {
    fetchFailed.val = error instanceof Error ? error.message : String(error);
    // Never swallowed. The page renders "nothing has been read on this bike", which is true
    // of what it knows; this line is what separates that from emcool genuinely never
    // having read the bike.
    console.warn("faults: could not load /freeze-frames — recorded values will not show:", error);
  } finally {
    inFlight = false;
  }
  if (askedAgain) {
    await loadRecordedValues();
  }
}

/**
 * How to take a reading, in this page's words rather than the server's `howToRead`. That
 * one names the button by its old caption ("Read the stored freeze frames") and has to stay
 * as the reference implementation writes it, so the page no longer shows it.
 */
const HOW_TO_READ = "Tap “Read the stored fault records”, parked, with the drive down or plugged in";

/**
 * The block under one opened code line, by `"component/symptom"` key.
 * @param {string} key
 */
export function RecordedValues(key) {
  const [component, symptom] = key.split("/").map(Number);
  return () => Values(key, component, symptom);
}

/**
 * Whether a decoded record for this code is on screen.
 *
 * Used by the caller to decide whether Energica's field-NAME list still earns its place: it
 * answers "what should I go and measure", and under a reading it repeats the same names
 * with a unit added. Reads `reading.val` rather than peeking, so the names come back by
 * themselves if the reading is ever cleared.
 * @param {string} key
 */
export function hasRecordedValues(key) {
  return recordedFrame(key) !== null;
}

/**
 * The decoded record for this code, or null.
 *
 * ⚠️ ONE definition of "there is a reading for this code". `Values` below and
 * `hasRecordedValues` above both need it — the first to render, the second to decide
 * whether Energica's name list still earns its place — and as two spellings of
 * "found ∧ no failure ∧ decoded to a frame ∧ symptom matches" they had to agree or the
 * hiding rule would diverge from what is on screen.
 * @param {string} key
 * @returns {import("../../src/diagnostics/freeze-frame.ts").FreezeFrame | null}
 */
function recordedFrame(key) {
  const [component, symptom] = key.split("/").map(Number);
  const record = reading.val?.reading?.records.find(candidate => candidate.component === component);
  if (record?.failure !== null || record.response.kind !== "frame" || record.response.frame.symptom !== symptom) {
    return null;
  }
  return record.response.frame;
}

/**
 * The block itself.
 *
 * Four states, kept apart because they are four different claims and only one of them is
 * about the motorcycle being fine:
 *
 *   1. no reading on this bike — nothing has been read, which says nothing about the bike
 *   2. read, but the VCU's list did not name this component
 *   3. read, the VCU listed it and answered `57 00` — it has no record to give
 *   4. read, and here is what it recorded
 *
 * @param {string} key `"component/symptom"`
 * @param {number} component
 * @param {number} symptom
 */
function Values(key, component, symptom) {
  // ⚠️ Read from the module signal rather than taken as a parameter named `reading`, which
  // shadowed it — a half-pure function that still reached for `fetchFailed.val` bought
  // nothing and made `reading.val` inside here silently `undefined`.
  const payload = reading.val;
  const stored = payload?.reading ?? null;
  if (!stored) {
    // ⚠️ Two different sentences, because they are two different claims. "Nothing has been
    // read on this bike" is about the motorcycle; a failed fetch is about this page, and
    // saying the first from the second is the screen inventing an answer the bike never
    // gave — the distinction src/diagnostics/stored-codes.ts exists to protect.
    return fetchFailed.val
      ? Note(`Could not ask emcool what it has recorded (${fetchFailed.val}). This says nothing about the bike.`)
      : Note(`No values have been read on this bike. ${HOW_TO_READ}.`);
  }
  const record = stored.records.find(candidate => candidate.component === component);
  if (!record) {
    if (!stored.components.includes(component)) {
      return Note("The VCU's list of stored records did not include this component when it was last read.");
    }
    // On the list and not among the records: the read ended before it got here. ⚠️ WHY it
    // ended is in `completion` and is not guessed — a gate-closed abort and a budget
    // overrun are different things and only one of them is about how long the read takes.
    return Note(
      stored.completion === "budget-spent"
        ? "The VCU lists a record for this component, but the last read ran out of time before reaching it."
        : `The VCU lists a record for this component, but the last read ended (${stored.completion}) before reaching it.`
    );
  }
  if (record.failure !== null) {
    return Note(`The VCU did not answer for this component: ${record.failure}.`);
  }
  if (record.response.kind !== "frame") {
    // `57 00` lands here — two bytes, shorter than the header, so the decoder files it
    // `unrecognised` and carries no failure. That combination IS the bike saying it has
    // nothing stored for this component.
    return Note("The VCU listed this component but had no record to give.");
  }
  const { frame } = record.response;
  if (recordedFrame(key) === null) {
    // The record is real and is about another symptom of the same component. Said rather
    // than shown under the wrong code: `0x17` takes no symptom, so this is the ordinary
    // way a component with two faults answers.
    return Note(
      `The VCU's record for this component is symptom ${frame.symptom}${frame.obdCode ? ` (${frame.obdCode})` : ""}, not this one.`
    );
  }
  return FrameValues(frame);
}

/**
 * What one record holds: its fields, whether the reply ran short, and how long ago it was
 * stored. ⚠️ ONE renderer, used under an opened code here and per component on the Stored
 * fault records card (./freeze-frame-read.js), so the bounds check and the raw-only rule
 * cannot differ between the two places the same record is drawn.
 * @param {import("../../src/diagnostics/freeze-frame.ts").FreezeFrame} frame
 */
function FrameValues(frame) {
  return div(
    { class: "code-fields" },
    div({ style: `color:${colors.MUTED}` }, "Recorded when this code set:"),
    ...frame.values.map(Field),
    frame.values.length === 0
      ? div({ style: `color:${colors.MUTED}` }, "Energica records no fields for this code.")
      : null,
    frame.truncated
      ? div({ style: `color:${colors.WARN}` }, "⚠ the reply ended before the field list did — later fields are missing")
      : null,
    div({ style: `color:${colors.MUTED}` }, describeAge(frame.cyclesSinceStored))
  );
}

/**
 * Every record the last read stored, one entry per component the VCU listed — the list the
 * Stored fault records card shows under its button.
 *
 * ⚠️ Same four-way honesty as `Values` above: not read, read-but-unreachable, read-and-empty
 * and a real record are four different claims, and a failed FETCH is a fifth that is about
 * this page rather than the bike.
 */
export function StoredRecords() {
  return () => {
    const payload = reading.val;
    const stored = payload?.reading ?? null;
    if (!stored) {
      if (fetchFailed.val) {
        return Note(`Could not ask emcool what it has recorded (${fetchFailed.val}). This says nothing about the bike.`);
      }
      if (payload === null) {
        return Note("Asking emcool what it has recorded…");
      }
      return Note(`Nothing read yet on this bike. ${HOW_TO_READ}.`);
    }
    const heading = div(
      { class: "code-fields", style: `color:${colors.MUTED}` },
      `Read ${ageInWords(stored.readAt)}`,
      stored.completion === "complete"
        ? null
        : span({ style: `color:${colors.WARN}` }, ` · the read did not finish (${stored.completion})`),
      fetchFailed.val ? span(` · could not refresh (${fetchFailed.val}), showing the last answer`) : null
    );
    // Listed components first, in the VCU's order; then any record for a component the list
    // did not name, which should not happen and is shown rather than hidden if it does.
    const components = [
      ...stored.components,
      ...stored.records.map(record => record.component).filter(component => !stored.components.includes(component)),
    ];
    if (components.length === 0) {
      return div(
        heading,
        Note(stored.completion === "no-list" ? "The VCU's list of stored records could not be read." : "No records stored.")
      );
    }
    return div(heading, ...components.map(component => RecordEntry(stored, component)));
  };
}

/**
 * One component's entry on the card.
 * @param {StoredFreezeFrameReading} stored
 * @param {number} component
 */
function RecordEntry(stored, component) {
  const record = stored.records.find(candidate => candidate.component === component);
  const frame = record?.failure === null && record.response.kind === "frame" ? record.response.frame : null;
  const title = frame
    ? frame.obdCode
      ? `${frame.obdCode} · ${frame.description ?? `component ${component}`}`
      : (frame.description ?? `component ${component}`)
    : `component ${component}`;
  return div(
    { class: "code-fields", style: "margin-left:0" },
    div({ style: `color:${colors.CALM}` }, title),
    frame ? div({ style: `color:${colors.MUTED}` }, `component ${component} · symptom ${frame.symptom}`) : null,
    frame ? FrameValues(frame) : div({ style: `color:${colors.MUTED}` }, recordNote(stored, record))
  );
}

/**
 * Why a listed component has no record on screen.
 * @param {StoredFreezeFrameReading} stored
 * @param {FreezeFrameRecord | undefined} record
 */
function recordNote(stored, record) {
  if (!record) {
    return stored.completion === "budget-spent"
      ? "Listed by the VCU, but the read ran out of time before reaching it."
      : `Listed by the VCU, but the read ended (${stored.completion}) before reaching it.`;
  }
  if (record.failure !== null) {
    return `The VCU did not answer for this component: ${record.failure}.`;
  }
  const response = record.response;
  if (response.kind === "refused") {
    return `The VCU refused to give this record: ${response.description}.`;
  }
  if (response.kind === "component-mismatch") {
    return `The VCU answered about component ${response.received} instead.`;
  }
  // `57 00`: see `Values` above — the VCU listed it and had nothing to give.
  return "The VCU listed this component but had no record to give.";
}

/**
 * One field: the name, the number, and the fault if the number is impossible.
 * @param {FreezeFrameValue} value
 */
function Field(value) {
  const fault = infokeyFault(value);
  // ⚠️ The null test rather than `fault.kind`, only so TypeScript narrows `value.value`
  // below — the two are the same condition by construction, and `infokeyFault` is still
  // what decides whether the number is out of range.
  if (value.value === null) {
    // Energica states a scaling this repo will not apply. The raw number is still true, so
    // it is shown — with the reason, and with no unit, because putting one on it would be
    // the claim we are declining to make. NOT bounds-checked: gating a deliberately
    // unscaled number against the scaled unit's range is a second, wrong complaint.
    return div(
      { class: "code-field" },
      span({ style: `color:${colors.MUTED}` }, value.name),
      span({ style: `color:${colors.WARN}` }, ` ${groupedReading(value.raw)} raw`),
      span({ style: `color:${colors.MUTED}` }, ` · ${value.scalingNote ?? "scaling not applied"}`)
    );
  }
  const impossible = fault?.kind === "out-of-range";
  // ⚠️ lib/format.js's rule, not a third one. `V_ODOMETER` and `TotalExchangedAh` are six
  // and seven digits here, and public/lib/lifetime.js already renders the SAME
  // FreezeFrameValue rows through `groupedReading` a tab away — two numbers disagreeing
  // about what "precise" means is what you notice first.
  const shown = groupedReading(value.value);
  return div(
    { class: "code-field" },
    span({ style: `color:${colors.MUTED}` }, value.name),
    span({ style: `color:${impossible ? colors.BAD : colors.CALM}` }, ` ${shown}${value.unit ? ` ${value.unit}` : ""}`),
    impossible && fault.kind === "out-of-range"
      ? span({ style: `color:${colors.BAD}` }, ` · impossible, outside ${fault.bounds[0]}…${fault.bounds[1]}`)
      : null
  );
}

/**
 * ⚠️ "Cycles", not "key cycles". The read that settled this counter spanned both a VCU
 * reset and a key-off/key-on and moved by +1, not +2, so which of the two it counts is
 * unresolved — docs/freeze-frame.md. Saying "key cycles" here would be the screen claiming
 * a thing nobody has measured.
 * @param {number | null} cycles
 */
function describeAge(cycles) {
  if (cycles === null) {
    return "The VCU sent no usable “cycles since stored” byte with this record.";
  }
  if (cycles === 0) {
    return "Stored this cycle — no key cycle or VCU reset since.";
  }
  const plural = cycles === 1 ? "cycle" : "cycles";
  return `Stored ${cycles} ${plural} ago — a cycle is a key-off/key-on or a VCU reset.`;
}

/** @param {string} text */
function Note(text) {
  return div({ class: "code-fields", style: `color:${colors.MUTED}` }, text);
}
