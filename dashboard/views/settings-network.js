// @ts-check
// Settings → Network connections: the Wi-Fi network the bike joins (WIFI_SSID, WIFI_PASSWORD), the
// SSH console's password (ADMIN_PASSWORD) and public keys (SSH_KEY_1 to SSH_KEY_3), and the telnet
// password (TELNET_PASSWORD) that the read-only telnet console and the ride-log page ask for.
//
// It saves with the console's own `set` and `unset`, through the Bike console's runLine(), so the
// bike checks every value exactly as at the emcool> prompt (docs/wifi.md). The one rule added here:
// Wi-Fi runs only with WIFI_SSID and at least one of the passwords or an SSH key set
// (Settings::wifiSetUp()), so this page won't save a network until one is saved or typed beside it.
// The passwords are saved first and the network last, so a save that stops halfway never leaves a
// network saved without one. The two passwords must differ (the bike refuses a match): the telnet
// one crosses the network in plain text.
//
// Each key slot saves on its own, the .pub line as one quoted word (`set SSH_KEY_1 "ssh-ed25519 …"`),
// since the console takes at most 8 words. The page checks a paste lightly first (../lib/ssh-key.js)
// and refuses a private key without sending it; the bike checks the key fully and has the last word.
// Public keys aren't secret, so the bike sends them back whole and the page shows each one's type,
// comment and fingerprint.
// The summary and the ifconfig card are Menu → Network info's (./network-info.js), shown here too.
import van from "../vendor/van-1.6.1.js";
import { SettingsCard } from "./settings-fields.js";
import { ConsoleRestart, OUTPUT_STYLE, busy, linkReady, list, listError, quoted, results, runLine, watchConsoleList } from "./bike-console.js";
import { NetworkStatus, NetworkSummary, WifiSwitch } from "./network-info.js";
import {
  PRIVATE_KEY_REFUSAL,
  SSH_KEY_SETTINGS,
  checkSshKey,
  looksLikePrivateKey,
  splitSavedSshKey,
  splitSshKey,
  sshKeyFingerprint,
} from "../lib/ssh-key.js";

const { button, div, input, label, pre, textarea } = van.tags;

const ssid = van.state("");
const ssidEdited = van.state(false);
const wifiPassword = van.state("");
const openNetwork = van.state(false);
const adminPassword = van.state("");
const telnetPassword = van.state("");
const showPasswords = van.state(false);

// What each key slot's field holds.
const keyDrafts = /** @type {Record<string, import("../vendor/van-1.6.1.js").State<string>>} */ (
  Object.fromEntries(SSH_KEY_SETTINGS.map(name => [name, van.state("")]))
);
// The slot a private key was just pasted into, cleared and never sent.
const privateKeyPasted = van.state("");
// Fingerprints by the key's base64. crypto.subtle answers later, so each is worked out once.
const fingerprints = van.state(/** @type {Record<string, string>} */ ({}));
const fingerprintsAsked = new Set();

// A slot's results and busy show under the slot's setting name, as on the Bike console's own card.
const RESULT = "network";
// The bike's limits on a console command over Bluetooth: one line, and the request's JSON body.
const CONSOLE_LINE_BYTES = 512;
const REQUEST_BODY_BYTES = 1024;

/** UTF-8 bytes, which is what the bike counts. @param {string} text */
const byteLength = text => new TextEncoder().encode(text).length;

/** @param {string} name */
const setting = name => list.val?.settings.find(entry => entry.name === name);

/** The SSID field: what was typed, else what is saved. */
const ssidValue = () => (ssidEdited.val ? ssid.val : (setting("WIFI_SSID")?.saved ?? ""));

/** Whether any SSH key is saved: one guards Wi-Fi as a password does. */
const keySaved = () => SSH_KEY_SETTINGS.some(name => setting(name)?.set === true);

/**
 * Why Save can't run yet, or "" when it can. Mirrors the bike's own checks (settings.cpp validate()),
 * so the reason shows before the tap rather than after it.
 */
function blocker() {
  const current = list.val;
  if (!linkReady()) return "Connect over Bluetooth to change the network settings.";
  if (!current) return listError.val || "Reading the bike's settings…";
  const name = ssidValue();
  const nameBytes = byteLength(name);
  const savedSsid = setting("WIFI_SSID")?.saved ?? "";
  const adminSaved = setting("ADMIN_PASSWORD")?.set === true;
  const telnetSaved = setting("TELNET_PASSWORD")?.set === true;
  const admin = adminPassword.val;
  const telnet = telnetPassword.val;
  const password = wifiPassword.val;
  if (nameBytes > 32) return `The network name is ${nameBytes} bytes; it can be at most 32.`;
  const adminBytes = byteLength(admin);
  if (admin && (adminBytes < 8 || adminBytes > 128)) {
    return `The SSH password must be 8-128 characters; this is ${adminBytes}.`;
  }
  const telnetBytes = byteLength(telnet);
  if (telnet && (telnetBytes < 8 || telnetBytes > 128)) {
    return `The telnet password must be 8-128 characters; this is ${telnetBytes}.`;
  }
  if (admin && telnet && admin === telnet) {
    return "The SSH and telnet passwords must differ: the telnet one crosses the network in plain text.";
  }
  const passwordBytes = byteLength(password);
  if (!openNetwork.val && password && (passwordBytes < 8 || passwordBytes > 63)) {
    return `The Wi-Fi password must be 8-63 characters; this is ${passwordBytes}.`;
  }
  if (ssidEdited.val && !name && savedSsid) return "To forget the network, tap Forget the network; to turn Wi-Fi off and keep it, Turn Wi-Fi off below.";
  if (name && !adminSaved && !admin && !telnetSaved && !telnet && !keySaved()) {
    return "Enter an SSH password or a telnet password, or save an SSH key below. Wi-Fi stays off without one, because they guard what it serves.";
  }
  const changes =
    (ssidEdited.val && name && name !== savedSsid) ||
    admin ||
    telnet ||
    password ||
    (openNetwork.val && setting("WIFI_PASSWORD")?.set);
  if (!changes) return "Nothing to save yet.";
  return "";
}

/** Runs one line, and stops the save at the first refusal. @param {string} line */
async function step(line) {
  const reply = await runLine(RESULT, line);
  return reply?.ok === true;
}

async function save() {
  const name = ssidValue();
  const savedSsid = setting("WIFI_SSID")?.saved ?? "";
  const admin = adminPassword.rawVal;
  const telnet = telnetPassword.rawVal;
  const password = wifiPassword.rawVal;
  const outputs = [];
  if (admin) {
    if (!(await step(`set ADMIN_PASSWORD ${quoted(admin)}`))) return;
    outputs.push(results.rawVal[RESULT]);
    adminPassword.val = "";
  }
  if (telnet) {
    if (!(await step(`set TELNET_PASSWORD ${quoted(telnet)}`))) return;
    outputs.push(results.rawVal[RESULT]);
    telnetPassword.val = "";
  }
  if (openNetwork.rawVal) {
    if (setting("WIFI_PASSWORD")?.set) {
      if (!(await step("unset WIFI_PASSWORD"))) return;
      outputs.push(results.rawVal[RESULT]);
    }
    openNetwork.val = false;
  } else if (password) {
    if (!(await step(`set WIFI_PASSWORD ${quoted(password)}`))) return;
    outputs.push(results.rawVal[RESULT]);
    wifiPassword.val = "";
  }
  if (name && name !== savedSsid) {
    if (!(await step(`set WIFI_SSID ${quoted(name)}`))) return;
    outputs.push(results.rawVal[RESULT]);
  }
  ssidEdited.val = false;
  results.val = {
    ...results.rawVal,
    [RESULT]: `${outputs.join("\n")}\nSaved. Restart emcool below for it to take effect.`.trim(),
  };
}

async function turnOff() {
  if (await step("unset WIFI_SSID")) {
    ssidEdited.val = false;
    ssid.val = "";
  }
}

/** A key's fingerprint, once crypto.subtle has worked it out; "" until then. @param {string} base64 */
function fingerprintOf(base64) {
  const known = fingerprints.val[base64];
  if (known !== undefined) return known;
  if (!fingerprintsAsked.has(base64)) {
    fingerprintsAsked.add(base64);
    const keep = /** @param {string} print */ print => {
      fingerprints.val = { ...fingerprints.rawVal, [base64]: print };
    };
    void sshKeyFingerprint(base64).then(keep, () => keep(""));
  }
  return "";
}

/**
 * A key as a person reads it: its type and comment, then its fingerprint, which `ssh-keygen -lf` on
 * the .pub file prints too. A pasted key's is worked out here (or, without crypto.subtle, the end of
 * its base64 stands in); a saved key's comes from the bike.
 * @param {{ type: string, comment: string }} key @param {string} fingerprint
 */
function KeyReadout(key, fingerprint) {
  return div(div(`${key.type} · ${key.comment || "no comment"}`), div({ class: "ble-key-readout" }, fingerprint));
}

/** A pasted line's readout. @param {import("../lib/ssh-key.js").SshKeyLine} key */
const PastedReadout = key => KeyReadout(key, fingerprintOf(key.base64) || `…${key.base64.slice(-16)}`);

/** A saved slot's readout, from what the bike sent. @param {import("../lib/ssh-key.js").SavedSshKey} key */
const SavedReadout = key => KeyReadout(key, key.fingerprint);

/**
 * Why a slot's pasted key can't be saved, or "" when it can (or nothing is pasted). The bike's checks,
 * lightly, plus what it would take to send: the console's 512-byte line and the request's body.
 * @param {string} name
 */
function keyProblem(name) {
  const text = keyDrafts[name].val;
  if (!text.trim()) return "";
  const { line, problem } = checkSshKey(text);
  if (problem) return problem;
  // The bike sends a saved key's fingerprint, not its line, so a repeat is found by fingerprint, once
  // this one's is worked out (a moment, or never without crypto.subtle; the bike takes a repeat anyway).
  const pasted = splitSshKey(line);
  const print = pasted ? fingerprintOf(pasted.base64) : "";
  if (print) {
    const same = SSH_KEY_SETTINGS.find(other => splitSavedSshKey(setting(other)?.saved ?? "")?.fingerprint === print);
    if (same === name) return "That is the key saved here already.";
    if (same) return `That key is saved in ${same} already.`;
  }
  const command = `set ${name} ${quoted(line)}`;
  const body = JSON.stringify({ line: command, revision: list.val?.revision ?? 0 });
  if (byteLength(command) > CONSOLE_LINE_BYTES || byteLength(body) > REQUEST_BODY_BYTES) {
    return "With the quotes and backslashes in its comment, that line is too long for the bike's console. Shorten the comment after the key.";
  }
  return "";
}

/** Saves the pasted key in its slot, the line as one quoted word. @param {string} name */
async function saveKey(name) {
  const { line, problem } = checkSshKey(keyDrafts[name].rawVal);
  if (problem || keyProblem(name)) return;
  const reply = await runLine(name, `set ${name} ${quoted(line)}`);
  if (reply?.ok !== true) return;
  keyDrafts[name].val = "";
  results.val = { ...results.rawVal, [name]: `${results.rawVal[name]}\nRestart emcool below for it to take effect.` };
}

/** What a slot holds: the saved key, and what this boot runs with when a restart would change it. @param {string} name */
function SlotState(name) {
  const entry = setting(name);
  if (!entry) return div();
  const saved = entry.set ? splitSavedSshKey(entry.saved) : null;
  const running = entry.active ? splitSavedSshKey(entry.active) : null;
  const keysSaved = SSH_KEY_SETTINGS.filter(other => setting(other)?.set).length;
  const onlyWayIn = !!saved && keysSaved === 1 && setting("ADMIN_PASSWORD")?.set !== true;
  return div(
    { class: "settings-note settings-state" },
    saved ? SavedReadout(saved) : entry.set ? div("Saved, but the bike can't read it: paste the key again.") : div("Not set."),
    entry.pending
      ? saved
        ? div(running ? "Saved; it replaces the key in use now after Restart." : "Saved; it logs in after Restart.")
        : div(
            "Removed; until Restart this key still logs in:",
            running ? SavedReadout(running) : div()
          )
      : div(),
    onlyWayIn ? div("This is the only way into SSH: with no SSH password set, removing it turns SSH off after Restart.") : div()
  );
}

/** One slot: what is saved in it, a field to paste a .pub line into, Save and Remove. @param {string} name @param {number} index */
function KeySlot(name, index) {
  const draft = keyDrafts[name];
  return div(
    { class: "settings-form-fields" },
    div(`Key ${index + 1} (${name})`),
    () => SlotState(name),
    textarea({
      "aria-label": `SSH public key ${index + 1}`,
      rows: 3,
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: false,
      placeholder: () =>
        setting(name)?.set ? "paste a .pub line to replace it" : "paste a .pub line: ssh-ed25519 AAAA… you@laptop",
      value: () => draft.val,
      oninput: event => {
        const field = /** @type {HTMLTextAreaElement} */ (event.target);
        if (looksLikePrivateKey(field.value)) {
          // Off the screen at once, and never sent. The field is cleared by hand too, since a draft
          // that was already empty wouldn't change and so wouldn't redraw it.
          field.value = "";
          draft.val = "";
          privateKeyPasted.val = name;
          return;
        }
        privateKeyPasted.val = "";
        draft.val = field.value;
      },
    }),
    () =>
      privateKeyPasted.val === name
        ? div({ class: "settings-note", role: "alert", style: "color: var(--bad);" }, PRIVATE_KEY_REFUSAL)
        : div(),
    () => {
      const why = keyProblem(name);
      if (why) return div({ class: "settings-note", role: "status" }, why);
      const { line } = checkSshKey(draft.val);
      const pasted = line ? splitSshKey(line) : null;
      return pasted ? div({ class: "settings-note settings-state" }, div("Pasted, not saved yet:"), PastedReadout(pasted)) : div();
    },
    div(
      { class: "settings-actions" },
      button(
        {
          class: "settings-button",
          disabled: () => !!busy.val || !linkReady() || !setting(name) || !draft.val.trim() || !!keyProblem(name),
          onclick: () => {
            void saveKey(name);
          },
        },
        () => (busy.val === name ? "Working…" : "Save")
      ),
      () =>
        setting(name)?.set
          ? button(
              {
                class: "settings-button",
                disabled: () => !!busy.val || !linkReady(),
                onclick: () => {
                  void runLine(name, `unset ${name}`);
                },
              },
              "Remove"
            )
          : div({ hidden: true })
    ),
    () => (results.val[name] ? pre({ style: OUTPUT_STYLE }, results.val[name]) : div())
  );
}

/** SSH_KEY_1 to SSH_KEY_3: a public key in each, which logs in to the SSH console without the password. */
function SshKeys() {
  return SettingsCard(
    "SSH keys",
    "Log in to the SSH console with a key instead of the password: paste the one line of its .pub file (ssh-ed25519 AAAA… you@laptop; cat ~/.ssh/id_ed25519.pub prints it). ssh-ed25519 and ecdsa-sha2-nistp256 keys work. ssh-rsa isn't supported: if you have no other key, make one with ssh-keygen -t ed25519. Up to three. With the SSH password set too, either logs in; with keys only, SSH takes keys only. A key turns Wi-Fi on as a password does. Changes take effect after Restart. The bike shows each saved key by its fingerprint, which ssh-keygen -lf ~/.ssh/id_ed25519.pub prints too. The private key (the same file without .pub) stays on your computer.",
    () =>
      list.val && !setting(SSH_KEY_SETTINGS[0])
        ? div({ class: "settings-note", role: "status" }, "This firmware takes no SSH keys. Update emcool to use them.")
        : div(),
    ...SSH_KEY_SETTINGS.map((name, index) => KeySlot(name, index))
  );
}

/** @param {string} ariaLabel @param {import("../vendor/van-1.6.1.js").State<string>} value @param {() => string} placeholder @param {() => boolean} [disabled] */
function PasswordField(ariaLabel, value, placeholder, disabled = () => false) {
  return input({
    "aria-label": ariaLabel,
    type: () => (showPasswords.val ? "text" : "password"),
    autocomplete: "new-password",
    autocapitalize: "off",
    spellcheck: false,
    placeholder,
    maxlength: 128,
    disabled,
    value: () => value.val,
    oninput: event => {
      value.val = /** @type {HTMLInputElement} */ (event.target).value;
    },
  });
}

/** @param {string} text @param {import("../vendor/van-1.6.1.js").ChildDom} field */
function Field(text, field) {
  return label({ class: "settings-form-fields" }, div({ class: "settings-note" }, text), field);
}

export function NetworkConnections() {
  watchConsoleList();
  return div(
    SettingsCard(
      "Wi-Fi",
      "The bike joins this network (garage Wi-Fi or a phone hotspot) and serves the SSH console on port 22 (ssh admin@<bike>, behind the SSH password or an SSH key), which runs every command, and the ride-log page on port 80 behind the telnet password. The read-only telnet console on port 23 is off unless TELNET_CONSOLE is 1. It needs a network name and at least one password or SSH key; the change takes effect after Restart. ⚠️ The telnet password and the ride log cross the network in plain text; SSH is encrypted.",
      () =>
        div(
          { class: "settings-note", role: "status" },
          linkReady() ? listError.val : "Connect over Bluetooth to change the network settings."
        ),
      NetworkSummary()
    ),
    SettingsCard(
      "Change the network",
      "Leave a password blank to keep the one saved. Passwords are never sent back, only whether they are set.",
      Field(
        "Network name (SSID), 1-32 characters",
        input({
          "aria-label": "Network name (SSID)",
          type: "text",
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: false,
          maxlength: 32,
          placeholder: "garage wifi",
          value: () => ssidValue(),
          oninput: event => {
            ssid.val = /** @type {HTMLInputElement} */ (event.target).value;
            ssidEdited.val = true;
          },
        })
      ),
      Field(
        "Wi-Fi password, 8-63 characters",
        PasswordField(
          "Wi-Fi password",
          wifiPassword,
          () => (setting("WIFI_PASSWORD")?.set ? "saved; type a new one to replace it" : "not set"),
          () => openNetwork.val
        )
      ),
      label(
        { class: "settings-note settings-check" },
        input({
          type: "checkbox",
          checked: () => openNetwork.val,
          onchange: event => {
            openNetwork.val = /** @type {HTMLInputElement} */ (event.target).checked;
            if (openNetwork.rawVal) wifiPassword.val = "";
          },
        }),
        " Open network (no Wi-Fi password)"
      ),
      Field(
        "SSH password (ADMIN_PASSWORD), 8-128 characters. The SSH console runs everything: settings, restart, firmware, the CAN commands. Use one you use nowhere else. Optional with an SSH key (below).",
        PasswordField(
          "SSH password",
          adminPassword,
          () =>
            setting("ADMIN_PASSWORD")?.set
              ? "saved; type a new one to replace it"
              : keySaved()
                ? "not set: SSH takes keys only"
                : "not set: SSH is off"
        )
      ),
      Field(
        "Telnet password (TELNET_PASSWORD), 8-128 characters. For the ride-log page and the read-only telnet console; it crosses the network in plain text, so never the SSH password.",
        PasswordField(
          "Telnet password",
          telnetPassword,
          () => (setting("TELNET_PASSWORD")?.set ? "saved; type a new one to replace it" : "not set: the ride-log page is off")
        )
      ),
      label(
        { class: "settings-note settings-check" },
        input({
          type: "checkbox",
          checked: () => showPasswords.val,
          onchange: event => {
            showPasswords.val = /** @type {HTMLInputElement} */ (event.target).checked;
          },
        }),
        " Show passwords"
      ),
      () => {
        const why = blocker();
        return why ? div({ class: "settings-note", role: "status" }, why) : div();
      },
      div(
        { class: "settings-actions" },
        button(
          {
            class: "settings-button",
            disabled: () => !!busy.val || !!blocker(),
            onclick: () => {
              void save();
            },
          },
          () => (busy.val === RESULT ? "Saving…" : "Save")
        ),
        () =>
          setting("WIFI_SSID")?.set
            ? button(
                {
                  class: "settings-button",
                  disabled: () => !!busy.val || !linkReady(),
                  onclick: () => {
                    void turnOff();
                  },
                },
                "Forget the network"
              )
            : div({ hidden: true })
      ),
      () => (results.val[RESULT] ? pre({ style: OUTPUT_STYLE }, results.val[RESULT]) : div())
    ),
    SshKeys(),
    SettingsCard("Turn Wi-Fi on or off", "", WifiSwitch()),
    NetworkStatus(),
    ConsoleRestart()
  );
}
