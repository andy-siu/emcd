// @ts-check

// How the per-cell voltage signals are named, and how to enumerate them.
//
// One module owns this so that nothing else in public/ has to know the shape of a
// cell key. The strip used to build its own — `cell_v_lmu3_c5` against the
// decoder's `lmu3_cell5_mv` — and reported "0 of 81" for a whole ride while the
// ALL view, which renders whatever arrives, showed all 81. Fixing the string in
// two places would have left the same trap set; there is now one copy, imported by
// both the strip and the plausibility gate.
//
// The pattern must stay in step with `cellVoltageKey()` in src/can/decode-bms.ts.
// That is the only cross-file agreement left, and it is the one that cannot be
// removed without a build step.

/** Matches the decoder's cellVoltageKey(): lmu<module>_cell<n>_mv. */
export const CELL_VOLTAGE_PATTERN = /^lmu(\d+)_cell(\d+)_mv$/;

/**
 * Series positions in the pack: 11 modules, four with 8 cells and seven with 7.
 * Mirrors cellsInLmu() in src/can/decode-bms.ts.
 */
export const CELL_COUNT = 81;

/** Every physical slot, including missing readings; the naming stays beside CELL_VOLTAGE_PATTERN. */
export function cellVoltageLayout() {
  const slots = [];
  for (let module = 1; module <= MODULE_COUNT; module++) {
    for (let cell = 1; cell <= cellsInModule(module); cell++) {
      slots.push({ key: `lmu${module}_cell${cell}_mv`, module, cell, position: slots.length + 1 });
    }
  }
  return slots;
}

/**
 * The per-cell voltage keys among `keys`, in pack order.
 *
 * Sorted numerically by module then cell: a plain string sort puts lmu10 between
 * lmu1 and lmu2, which would silently scramble which bar is which cell — the strip
 * would still look plausible while pointing at the wrong module.
 * @param {string[]} keys
 * @returns {string[]}
 */
export function cellVoltageKeys(keys) {
  const found = [];
  for (const key of keys) {
    const match = CELL_VOLTAGE_PATTERN.exec(key);
    if (match) {
      found.push({ key, lmu: Number(match[1]), cell: Number(match[2]) });
    }
  }
  found.sort((a, b) => (a.lmu === b.lmu ? a.cell - b.cell : a.lmu - b.lmu));
  return found.map(entry => entry.key);
}

/** The three temperature sensors each module reports, in the order they are shown. */
export const MODULE_SENSORS = /** @type {const} */ (["bat1", "pcb1", "pcb2"]);

/** Modules 6 and 8 have no battery sensor — mirrors LMUS_WITHOUT_BATTERY_TEMP. */
export const MODULES_WITHOUT_BATTERY_SENSOR = [6, 8];

/** Modules in the pack, 1-indexed. */
export const MODULE_COUNT = 11;

/**
 * Sensors the pack actually has: 11 modules x 3 positions, less the two thermistors that
 * are not fitted. Derived rather than written as 31, so it cannot disagree with the two
 * facts above it — and computed once, because it is a property of the pack rather than
 * of any reading.
 */
export const MODULE_SENSOR_COUNT = MODULE_COUNT * MODULE_SENSORS.length - MODULES_WITHOUT_BATTERY_SENSOR.length;

/** Widest module. Mirrors cellsInLmu() in src/can/decode-bms.ts: 8 for modules 1-4. */
export const MAX_CELLS_PER_MODULE = 8;

/**
 * How many cells a module has. Mirrors cellsInLmu().
 * @param {number} moduleNumber
 */
export function cellsInModule(moduleNumber) {
  return moduleNumber <= 4 ? 8 : 7;
}

/**
 * The battery's nine physical modules, nine cells each in series order, as runs of
 * [lmu, first cell, last cell]. The BMS numbers the pack by its eleven LMUs (the boards
 * that measure the cells, 8 cells on LMUs 1-4 and 7 on 5-11), and those don't line up with
 * the modules bolted into the bike: most modules span two LMUs, and M6 three.
 *
 * ⚠️ Taken from one 21.5 kWh pack (2023), not confirmed by the manufacturer. Check it
 * against the pack in front of you before opening a module: PACK_LAYOUT_NOTE says so on
 * the page.
 * @type {Readonly<Record<number, ReadonlyArray<readonly [number, number, number]>>>}
 */
export const PACK_MODULES = {
  1: [[1, 1, 8], [2, 1, 1]],
  2: [[2, 2, 8], [3, 1, 2]],
  3: [[3, 3, 8], [4, 1, 3]],
  4: [[4, 4, 8], [5, 1, 4]],
  5: [[5, 5, 7], [6, 1, 6]],
  6: [[6, 7, 7], [7, 1, 7], [8, 1, 1]],
  7: [[8, 2, 7], [9, 1, 3]],
  8: [[9, 4, 7], [10, 1, 5]],
  9: [[10, 6, 7], [11, 1, 7]],
};

/** Where each module sits, looking at the pack: M1 top right, M7 bottom right. */
export const PACK_GRID = [
  [3, 2, 1],
  [4, 5, 6],
  [9, 8, 7],
];

export const PACK_MODULE_COUNT = 9;

export const PACK_LAYOUT_NOTE =
  "Module placement is taken from one 21.5 kWh pack (2023), not confirmed by the manufacturer. Check it against your pack before opening a module.";

/**
 * One physical module's cells, in series order, each with its LMU and that LMU's cell.
 * @param {number} packModule 1-9
 * @returns {Array<{ lmu: number, cell: number, key: string }>}
 */
export function packModuleCells(packModule) {
  return PACK_MODULES[packModule].flatMap(([lmu, first, last]) =>
    Array.from({ length: last - first + 1 }, (_, index) => ({
      lmu,
      cell: first + index,
      key: `lmu${lmu}_cell${first + index}_mv`,
    }))
  );
}

/**
 * The physical module an LMU's cell is in, or null for a slot the layout doesn't hold.
 * @param {number} lmu
 * @param {number} cell
 */
export function packModuleOf(lmu, cell) {
  for (let packModule = 1; packModule <= PACK_MODULE_COUNT; packModule++) {
    if (PACK_MODULES[packModule].some(([run, first, last]) => run === lmu && cell >= first && cell <= last)) {
      return packModule;
    }
  }
  return null;
}

/**
 * Which LMUs' sensors sit in a physical module: "LMU 1–2", "LMU 6–8".
 * @param {number} packModule
 */
export function packModuleLmus(packModule) {
  const runs = PACK_MODULES[packModule];
  return `LMU ${runs[0][0]}–${runs[runs.length - 1][0]}`;
}

/**
 * The key a module's temperature sensor reports under, or null where that sensor
 * does not exist. Mirrors `lmuTemperatureKey()` in src/can/decode-bms.ts, which
 * owns the naming — see the note at the top of this file.
 * @param {number} moduleNumber
 * @param {(typeof MODULE_SENSORS)[number]} sensor
 * @returns {string | null}
 */
export function moduleTemperatureKey(moduleNumber, sensor) {
  if (sensor === "bat1" && MODULES_WITHOUT_BATTERY_SENSOR.includes(moduleNumber)) {
    return null;
  }
  return `lmu${moduleNumber}_${sensor}_c`;
}

/**
 * @typedef {object} ModuleSensorCell
 * @property {number | null} value what it reads, or null if nothing has arrived
 * @property {boolean} absent true where the module has no such sensor at all
 */

/**
 * @typedef {object} ModuleTemperatures
 * @property {Array<{ module: number, cells: ModuleSensorCell[] }>} rows
 * @property {number} seen sensors currently reading, against MODULE_SENSOR_COUNT
 */

/**
 * The module-temperature grid's state: a row per module, a cell per sensor.
 *
 * Three states per cell and not two, which is the whole point. A `null` cannot tell a
 * module whose thermistor is disabled in the BMS config apart from one whose reading
 * stopped arriving, and only moduleTemperatureKey() knows which is which — so the
 * distinction is drawn here, where that knowledge is, rather than at the drawing code.
 *
 * ⚠️ Returns only what depends on the readings. How many sensors the pack HAS, and which
 * modules lack one, are constants above — a caption that needs them imports them rather
 * than having them rebuilt on every redraw.
 *
 * `read` is a parameter for the same reason packResistanceWith()'s is: it lets
 * scripts/check-module-heatmap.ts drive this with no DOM. ⚠️ The view passes `peek`,
 * never `valueOf` — the grid redraws on chartTick, and subscribing it to 31 signals
 * would cancel that throttle silently.
 * @param {(key: string) => number | null} read
 * @returns {ModuleTemperatures}
 */
export function moduleTemperatureGrid(read) {
  const rows = [];
  let seen = 0;
  for (let module = 1; module <= MODULE_COUNT; module++) {
    const cells = MODULE_SENSORS.map(sensor => {
      const key = moduleTemperatureKey(module, sensor);
      if (key == null) {
        return { value: null, absent: true };
      }
      const value = read(key);
      if (value != null) {
        seen += 1;
      }
      return { value, absent: false };
    });
    rows.push({ module, cells });
  }
  return { rows, seen };
}
