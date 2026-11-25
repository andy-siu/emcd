// @ts-check
// The complete parked report and preserved diagnostic rationale: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, valueOf } from "../lib/store.js";
import { monotonicNow } from "../lib/clock.js";
import { Fact, SectionLabel } from "../lib/tiles.js";
import * as colors from "../lib/colors.js";
import { FreezeFrameReadButton, refreshFreezeFrameRead } from "./freeze-frame-read.js";
import { ClearCodesPanel, pollClearCodes, refreshClearCodes } from "./vcu-write.js";
import { request } from "../lib/transport.js";
import { destination } from "../lib/destination.js";
import { ExpectedToggle, isExpected } from "../lib/expected-faults.js";
import { peekView, showView } from "../lib/router.js";
import { StoredCodes } from "./stored-faults.js";
import {
  loadFaultData,
  collectFaults,
  headlineValue,
  headlineColor,
  headlineCaption,
  tableError,
} from "../lib/fault-data.js";
import { historyOf, describeLastSeen, rawLabel, componentOf, symptomOf } from "../lib/fault-history.js";
/** @typedef {import("../lib/fault-data.js").FaultRow} FaultRow */
/** @typedef {import("../../src/http/vcu-read.ts").VcuReadResponse} VcuReadResponse */
const { button, div, span } = van.tags;

/**
 * This page's own /vcu-read state, for the Stored fault records button: the gate and the
 * service-mode switch it shares with the sheet. Null until emcool answers, and the button
 * stays disabled until then. It is not the sheet's state, because that one is polled only
 * while the sheet is open.
 */
const readState = van.state(/** @type {VcuReadResponse | null} */ (null));

export function FaultReportView() {
  loadFaultData();
  // Also re-fetches the recorded values, which the opened codes below draw from.
  refreshFreezeFrameRead();
  void refreshClearCodes();
  void refreshReadState();
  startPolling();
  return div(
    { class: "view fault-report-view" },
    div(
      { class: "fault-report-heading" },
      button({ class: "settings-button", onclick: returnFromReport }, () => `‹ ${history.state?.backName ?? "Faults"}`),
      div("Fault report · read when parked")
    ),
    Headline(),
    () => {
      const faults = collectFaults();
      if (faults.length === 0) {
        return div();
      }
      // .tile-group, not .view and not a bare div: .view would double the 0.5 rem
      // horizontal padding and inset this group relative to the hero and Counters
      // either side of it, while a bare div drops the cards out of any grid and
      // loses the gap between them entirely.
      return div({ class: "tile-group" }, SectionLabel("Codes"), ...faults.map(FaultCard));
    },
    SectionLabel("Counters"),
    Counters(),
    StoredCodes(),
    // ⚠️ The SAME two controls the service sheet carries, mounted here rather than copied:
    // one gate, one arming key, one busy state and one outcome each. See ./freeze-frame-read.js
    // and ClearCodesAction in ./vcu-write.js.
    div(
      { class: "tile-group" },
      SectionLabel("Read and clear"),
      FreezeFrameReadButton(() => readState.val),
      ClearCodesPanel()
    ),
    Footnote()
  );
}

/** The one-glance answer: is anything wrong right now, or was it recently. */
function Headline() {
  return div(
    { class: "hero" },
    div({ class: "label" }, "Faults"),
    div({ class: "hero-value", style: () => `color:${headlineColor()}` }, () => headlineValue()),
    div({ class: "sub" }, () => headlineCaption())
  );
}

/**
 * One code. Leads with the OBD code because that is what you would search for or
 * read out to a dealer.
 * @param {FaultRow} fault
 */
function FaultCard(fault) {
  const accent = fault.active ? colors.BAD : colors.MUTED;
  const row = fault.row;
  const key = fault.codeKey;
  return div(
    { class: "tile span2", style: `border-left:3px solid ${accent}` },
    div(
      { class: "label" },
      span({ style: `color:${accent}` }, row ? row.obdCode : rawLabel(fault.key)),
      // ⚠️ Its own binding, and the ONLY thing on this card that reads the tick. The card
      // itself must stay put — see collectFaults.
      span({ style: `color:${colors.MUTED}` }, () => {
        void chartTick.val;
        return fault.active ? " · active" : ` · ${describeLastSeen(historyOf(fault.key, monotonicNow()).lastSeenMs)}`;
      }),
      () => (isExpected(key) ? span({ style: `color:${colors.MUTED}` }, " · expected") : span())
    ),
    div(
      { class: "sub", style: `color:${colors.CALM};font-size:0.95rem;margin-top:0.25rem` },
      row ? row.description : "Not in Energica's code table — a code the type-approval document does not list."
    ),
    row ? div({ class: "sub" }, row.name) : null,
    div(
      { class: "sub", style: `color:${colors.MUTED}` },
      `component ${componentOf(fault.key)} · symptom ${symptomOf(fault.key)}` +
        (row ? ` · warning lamp: ${milText(row.illuminatesMil)}` : "") +
        (fault.firings > 1 ? ` · ${fault.firings}× this session` : "")
    ),
    // A plain button here, unlike on a stored code line: a card is not itself a control,
    // so there is nothing to nest inside.
    ExpectedToggle(key)
  );
}

/**
 * Three-way, not a boolean: the six codes that reach us from the manufacturer
 * data alone have no MIL column in any source, and "no" would be an answer we
 * do not have. Same distinction `rank()` sorts on below.
 * @param {boolean | null} illuminatesMil
 */
function milText(illuminatesMil) {
  if (illuminatesMil === null) {
    return "unknown";
  }
  return illuminatesMil ? "yes" : "no";
}

/**
 * The two counts, kept apart on purpose.
 *
 * They measure different things and always disagree: `dtc_count` is OBD-II PID
 * 0x01's STORED history (39 on this bike as of 2026-08-04, and only ever
 * climbing), while `dtc_list_count` is the Connectivity Hub's ACTIVE list (0 or
 * 1). That was a suspicion until 2026-08-03, when the active list was seen
 * flipping 0↔1 on a stationary bike across two boots — stored history cannot
 * flicker. Confirmed again on 2026-08-04 under load: 11 of 47 polls carried a
 * code while PID 0x01 sat at 39, riding and DC charging alike. Merging them into
 * one number would be wrong; showing either alone would hide the other.
 */
function Counters() {
  return div(
    { class: "tile span2" },
    Fact("Active list", () => count("dtc_list_count")),
    Fact("Stored (OBD)", () => count("dtc_count")),
    Fact("Unrecognised", () => count("dtc_unrecognised_count")),
    Fact("Warning lamp", () => {
      const milOn = valueOf("mil_on");
      return milOn == null ? "—" : milOn > 0 ? "ON" : "off";
    })
  );
}

/** @param {string} key */
function count(key) {
  const value = valueOf(key);
  return value == null ? "—" : String(Math.round(value));
}

function Footnote() {
  return div({ class: "missing", style: `color:${colors.MUTED}` }, () => {
    if (tableError.val) {
      return `Code names unavailable (${tableError.val}) — showing raw component/symptom numbers.`;
    }
    return (
      "“Active list” is what the bike reports as wrong right now; “stored” is OBD-II's fault " +
      "history and is normally much larger. A code can be set with the warning lamp off. " +
      "History starts when this page is opened — the ride log is write-only and cannot be read back. " +
      "Nothing on this screen can clear a code: the bike is only ever asked, never told."
    );
  });
}

function returnFromReport() {
  if (history.state?.coolEvaSubview) {
    history.back();
  } else {
    showView("faults");
  }
}

/** GETs /vcu-read, which changes nothing on the bike. A failure keeps the last answer. */
async function refreshReadState() {
  try {
    const response = await request("/vcu-read", { cache: "no-store", headers: { "X-Emcool": "service-mode" } });
    readState.val = /** @type {VcuReadResponse} */ (await response.json());
  } catch (error) {
    console.warn("fault report: /vcu-read unavailable — the read button keeps its last gate", error);
  }
}

/**
 * Four seconds: the gate moves when the bike is parked or keyed, and the buttons have to follow
 * it without a reload. Two cheap GETs that only sample the gate.
 */
const POLL_INTERVAL_MS = 4000;
let polling = false;

function isShown() {
  return peekView() === "fault-report" && !destination.rawVal;
}

/**
 * Keeps both gates fresh while this page is on screen. It stops by not rescheduling, the
 * sheet's pattern in ./service-mode.js, and it pauses while the page is hidden.
 */
function startPolling() {
  if (polling) {
    return;
  }
  polling = true;
  const step = async () => {
    if (!isShown()) {
      polling = false;
      return;
    }
    if (!document.hidden) {
      await Promise.all([refreshReadState(), pollClearCodes()]);
    }
    setTimeout(() => void step(), POLL_INTERVAL_MS);
  };
  setTimeout(() => void step(), POLL_INTERVAL_MS);
}
