// @ts-check
import van from "../vendor/van-1.6.1.js";
import { openDestination } from "../lib/destination.js";
import { SettingsCard } from "./settings-fields.js";

const { button } = van.tags;

export function AccessExplanation() {
  return SettingsCard(
    "Who can control my bike?",
    "emcool does not have individual user accounts. Over your Wi-Fi or phone hotspot, anyone with the SSH password, or the private half of an SSH key saved on the bike, can change settings and request changes to the motorcycle; the telnet password only lets them look. Anyone with your emcool Bluetooth access code has the same access over Bluetooth. Confirmations help prevent accidental taps; they do not stop another device from sending its own requests. Use a network you trust and do not make emcool accessible from the public internet. Motorcycle commands still pass the app’s checks and are recorded in its change history."
  );
}

export function AccessLink() {
  return button(
    { class: "settings-link", onclick: () => openDestination("settings", "access") },
    "Who can control my bike? →"
  );
}
