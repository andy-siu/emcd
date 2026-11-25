// @ts-check
// Strip scaling, slot order and browser-history origins: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import { cellSnapshot } from "../lib/cell-snapshot.js";
import {
  cellVoltageLayout,
  CELL_COUNT,
  PACK_GRID,
  PACK_LAYOUT_NOTE,
  PACK_MODULE_COUNT,
  packModuleCells,
  packModuleLmus,
  packModuleOf,
} from "../lib/cells.js";
import { barStrip } from "../lib/svg.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { sparkline } from "../lib/svg.js";
import * as colors from "../lib/colors.js";

const { button, div, h2, span } = van.tags;

export function CellsView() {
  return div(
    { class: "view cells-view", "data-view": "cells" },
    SubTabs("hypermile"),
    ...(history.state?.menuOrigin
      ? [
          button(
            {
              class: "cells-back",
              onclick: () => history.back(),
            },
            `‹ ${history.state.backName}`
          ),
        ]
      : []),
    CellsContent()
  );
}

// The pack as it sits in the bike: nine battery modules of nine cells, not the BMS's eleven
// LMUs. Each module's cells come from one LMU or more (lib/cells.js PACK_MODULES).
function CellsContent() {
  const positions = new Map(cellVoltageLayout().map(slot => [slot.key, slot.position]));
  return div(
    { class: "cells-content" },
    () => {
      chartTick.val;
      return CellsOverview();
    },
    () => {
      chartTick.val;
      return PackMap();
    },
    SpreadHistory(),
    ...Array.from({ length: PACK_MODULE_COUNT }, (_, index) => {
      const packModule = index + 1;
      return div(
        { class: "tile cell-module", "data-module": packModule },
        h2(`Module ${packModule}`),
        div({ class: "sub" }, () => {
          chartTick.val;
          return `${packModuleLmus(packModule)} · ${moduleSummary(packModule)}`;
        }),
        div(
          { class: "cell-values" },
          ...packModuleCells(packModule).map(cell =>
            CellReading({ ...cell, position: positions.get(cell.key) ?? 0 })
          )
        )
      );
    })
  );
}

/** "avg 3910 · spread 17 mV", from the module's fresh cells. @param {number} packModule */
function moduleSummary(packModule) {
  const values = packModuleCells(packModule).flatMap(cell => {
    const value = freshValue(cell.key, true);
    return value === null ? [] : [value];
  });
  if (values.length === 0) return "no fresh cells";
  const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const spreadMv = Math.max(...values) - Math.min(...values);
  const counted = values.length === 9 ? "" : ` · ${values.length} of 9 fresh`;
  return `avg ${average} · spread ${spreadMv} mV${counted}`;
}

// The nine modules where they sit, looking at the pack, each a 3 x 3 of its cells in series
// order, coloured as the strip is: by the gap below the best cell.
function PackMap() {
  const snapshot = cellSnapshot(peek, key => readingStatus(key, true));
  const byKey = new Map(snapshot.cells.map(cell => [cell.key, cell]));
  return div(
    { class: "tile pack-map" },
    h2("Pack layout"),
    div({ class: "sub" }, "The nine battery modules as they sit in the bike, looking at the pack. Each square is a cell, in series order; colour is the gap below the best cell."),
    div(
      { class: "pack-grid", role: "img", "aria-label": "The battery's nine modules in place, nine cells each." },
      ...PACK_GRID.flat().map(packModule =>
        div(
          { class: "pack-module", "data-pack-module": packModule },
          div({ class: "pack-module-name" }, `M${packModule}`),
          div(
            { class: "pack-cells" },
            ...packModuleCells(packModule).map(slot => {
              const cell = byKey.get(slot.key);
              const value = cell?.value ?? null;
              const color =
                cell?.state === "fault"
                  ? colors.BAD
                  : value === null
                    ? colors.MUTED
                    : colors.spread((snapshot.high ?? 0) - value);
              return div(
                {
                  class: `pack-cell ${cell?.state ?? "missing"}`,
                  style: value === null ? `border-color:${color}` : `background:${color}`,
                  title: `M${packModule} · LMU ${slot.lmu} cell ${slot.cell}${value === null ? "" : ` · ${value} mV`}`,
                },
                value === null ? "–" : String(value % 1000).padStart(3, "0")
              );
            })
          )
        )
      )
    ),
    div({ class: "sub" }, "Squares show the last three digits of each cell's mV. ", PACK_LAYOUT_NOTE)
  );
}

function CellsOverview() {
  const snapshot = cellSnapshot(peek, key => readingStatus(key, true));
  const padding = Math.max(((snapshot.high ?? 0) - (snapshot.low ?? 0)) * 0.25, 5);
  const status = `${snapshot.fresh} of ${CELL_COUNT} fresh${snapshot.fault ? ` · ${snapshot.fault} fault` : ""}${snapshot.stale ? ` · ${snapshot.stale} stale` : ""}${snapshot.missing ? ` · ${snapshot.missing} missing` : ""}`;
  return div(
    { class: "tile cells-overview" },
    h2("Battery cells"),
    div({ class: "sub", "data-cell-count": "" }, status),
    div(
      { role: "img", "aria-label": `${CELL_COUNT} physical cell positions in pack order. ${status}.` },
      barStrip({
        bars: snapshot.cells.map(cell => ({
          key: cell.key,
          state: cell.state,
          value: cell.value,
          color:
            cell.state === "fault"
              ? colors.BAD
              : cell.value === null
                ? colors.MUTED
                : colors.spread((snapshot.high ?? 0) - cell.value),
        })),
        low: (snapshot.low ?? 0) - padding,
        high: (snapshot.high ?? 1) + padding,
      })
    ),
    div(
      { class: "sub", "data-cell-extremes": "" },
      snapshot.low === null
        ? "Cell span unavailable"
        : `${snapshot.low} – ${snapshot.high} mV · observed span ${(snapshot.high ?? 0) - snapshot.low} mV`
    ),
    div(
      { class: "cells-identities" },
      span({ "data-weakest": "" }, `Weakest ${whereIs(snapshot, snapshot.weakest)}`),
      span({ "data-strongest": "" }, `Strongest ${whereIs(snapshot, snapshot.strongest)}`)
    ),
    div(
      { class: "sub" },
      "Positions 1–81 follow pack order, module 1 to 9. Height shows the observed spread; colour is the gap below the best cell. Outlines mark unavailable readings."
    )
  );
}

/**
 * "M3 · LMU 3 cell 5 (position 21)", or "unknown".
 * @param {ReturnType<typeof cellSnapshot>} snapshot
 * @param {number | null} position
 */
function whereIs(snapshot, position) {
  const cell = position === null ? undefined : snapshot.cells.find(slot => slot.position === position);
  if (!cell) return "unknown";
  return `M${packModuleOf(cell.module, cell.cell)} · LMU ${cell.module} cell ${cell.cell} (position ${cell.position})`;
}

/** @param {{ key: string, lmu: number, cell: number, position: number }} cell */
function CellReading(cell) {
  return div(
    {
      class: () => {
        chartTick.val;
        return `cell-reading ${readingStatus(cell.key, true)}`;
      },
      "data-cell-key": cell.key,
    },
    div({ class: "sub" }, `LMU ${cell.lmu} cell ${cell.cell} · #${cell.position}`),
    div(
      {
        class: "cell-number",
        style: () => {
          chartTick.val;
          const state = readingStatus(cell.key, true);
          return `color:${state === "fault" ? colors.BAD : state === "fresh" ? colors.CALM : colors.MUTED}`;
        },
      },
      () => {
        chartTick.val;
        const state = readingStatus(cell.key, true);
        const value = freshValue(cell.key, true);
        return value === null ? statusWord(state) : span(String(value), span({ class: "unit" }, "mV"));
      }
    )
  );
}

function SpreadHistory() {
  return div(
    { class: "tile cell-spread-history" },
    div({ class: "label" }, "Cell spread history"),
    div({ class: "value" }, () => {
      chartTick.val;
      const state = readingStatus("cell_spread_mv", true);
      const value = state === "fresh" ? peek("cell_spread_mv") : null;
      return value === null ? statusWord(state) : `${Math.round(value)} mV`;
    }),
    () => {
      chartTick.val;
      const fresh = readingStatus("cell_spread_mv", true) === "fresh";
      return sparkline({
        values: fresh ? ringFor("cell_spread_mv").since(600_000, monotonicNow()).values : [],
        color: colors.spread(fresh ? peek("cell_spread_mv") : null),
        minSpan: 10,
      });
    },
    div({ class: "sub" }, "last 10 min")
  );
}
