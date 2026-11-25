// @ts-check
// The SSH console's public keys, SSH_KEY_1 to SSH_KEY_3: each the one line of an OpenSSH .pub file.
// A light copy of the bike's checks (components/emcool_settings/src/ssh_keys.cpp), so a paste that
// can't work says why before it is sent; the bike still checks it fully and has the last word. Plain
// functions with no page in them, so they run in Node too.

export const SSH_KEY_SETTINGS = ["SSH_KEY_1", "SSH_KEY_2", "SSH_KEY_3"];
export const SSH_KEY_MAX_BYTES = 400;

// The two kinds the bike's wolfSSH can check (wolfSSL is built without RSA), each with its key's size
// in SSH wire form: its type name, then an Ed25519 key's 32 bytes, or P-256's curve name and 65-byte
// point, each with a 4-byte length in front.
const BLOB_BYTES = /** @type {Record<string, number>} */ ({ "ssh-ed25519": 51, "ecdsa-sha2-nistp256": 104 });

export const PRIVATE_KEY_REFUSAL =
  "⚠️ That is a private key, and it must stay on your computer. Nothing was sent, and the field is cleared. Paste the public key instead: the one line in the .pub file (~/.ssh/id_ed25519.pub, not ~/.ssh/id_ed25519). If the private key was shared anywhere else, make a new pair with ssh-keygen -t ed25519.";

/** UTF-8 bytes, which is what the bike counts. @param {string} text */
const byteLength = text => new TextEncoder().encode(text).length;

/**
 * Whether the text holds a private key: a PEM or OpenSSH private key (its BEGIN line, or the
 * base64 of "openssh-key-v1" it starts with), or a PuTTY .ppk file.
 * @param {string} text
 */
export function looksLikePrivateKey(text) {
  return /PRIVATE KEY-----|PuTTY-User-Key-File-|b3BlbnNzaC1rZXktdjE/.test(text);
}

/** Padded base64 in its one canonical spelling, as the bike takes it. @param {string} text @returns {Uint8Array<ArrayBuffer> | null} */
function decodeBase64(text) {
  try {
    const binary = atob(text);
    if (btoa(binary) !== text) return null;
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

/** The type name a key blob starts with (an SSH string: a 4-byte length, then the name). @param {Uint8Array} blob */
function blobType(blob) {
  if (blob.length < 4) return "";
  const length = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0;
  if (length > 64 || length > blob.length - 4) return "";
  return String.fromCharCode(...blob.subarray(4, 4 + length));
}

/**
 * TYPE, BASE64 and COMMENT, split as the bike splits them: on spaces and tabs. The comment's words
 * come back one space apart, as the bike saves them.
 * @param {string} text
 */
function parts(text) {
  const [type = "", base64 = "", ...comment] = text.split(/[ \t]+/).filter(Boolean);
  return { type, base64, comment: comment.join(" ") };
}

/** @typedef {{ type: string, base64: string, comment: string }} SshKeyLine */

/** @typedef {{ type: string, fingerprint: string, comment: string }} SavedSshKey */

/**
 * A key as GET /console sends it, which is how `show` prints it: "TYPE SHA256:… COMMENT", the comment
 * cut at 64 bytes with "...". Not the whole line: three of those, saved and running, would be too much
 * for the bike's internal heap in one go. null for an empty slot, and for a stored line the bike
 * couldn't read ("not a usable key").
 * @param {string} shown
 * @returns {SavedSshKey | null}
 */
export function splitSavedSshKey(shown) {
  const [type = "", fingerprint = "", ...comment] = shown.trim().split(" ");
  return type && fingerprint.startsWith("SHA256:") ? { type, fingerprint, comment: comment.join(" ") } : null;
}

/** A saved line's type, base64 and comment, or null when it isn't one. @param {string} line @returns {SshKeyLine | null} */
export function splitSshKey(line) {
  const key = parts(line.trim());
  return key.type && key.base64 ? key : null;
}

/**
 * A pasted .pub line as the bike saves it ("TYPE BASE64 COMMENT", one space apart), or why it can't
 * be one. `privateKey` says the paste was a private key, which the page refuses loudly.
 * @param {string} text
 * @returns {{ line: string, problem: string, privateKey: boolean }}
 */
export function checkSshKey(text) {
  /** @param {string} problem */
  const refuse = (problem, privateKey = false) => ({ line: "", problem, privateKey });
  const trimmed = text.trim();
  if (!trimmed) return refuse("Paste the line from a .pub file, such as ~/.ssh/id_ed25519.pub.");
  if (looksLikePrivateKey(trimmed)) return refuse(PRIVATE_KEY_REFUSAL, true);
  if (trimmed.startsWith("----")) {
    return refuse("That is a PEM or SSH2 public key block. Paste the one-line OpenSSH form: the .pub file's line, or what ssh-keygen -i -f FILE prints.");
  }
  // The console takes one line, and a slot holds one key.
  if (/[\r\n]/.test(trimmed)) return refuse("That is more than one line. Paste one key, the one line of its .pub file.");
  const { type, base64, comment } = parts(trimmed);
  if (type === "ssh-rsa" || type.startsWith("rsa-sha2-") || type === "ssh-dss") {
    return refuse("ssh-rsa isn't supported: this firmware can't check RSA or DSA keys. Make an Ed25519 key with ssh-keygen -t ed25519 and paste its .pub line.");
  }
  if (type.startsWith("sk-")) {
    return refuse("Security-key (FIDO) keys aren't supported. Make an Ed25519 key with ssh-keygen -t ed25519.");
  }
  if (type.endsWith("-cert-v01@openssh.com")) {
    return refuse("SSH certificates aren't supported. Paste the plain public key: the .pub file without -cert.");
  }
  if (type === "ecdsa-sha2-nistp384" || type === "ecdsa-sha2-nistp521") {
    return refuse("Only P-256 ECDSA keys (ecdsa-sha2-nistp256) are supported, not P-384 or P-521. ssh-keygen -t ed25519 makes one that is.");
  }
  if (!BLOB_BYTES[type]) {
    return refuse("It must start with ssh-ed25519 or ecdsa-sha2-nistp256, as a .pub file's line does, with nothing in front.");
  }
  if (!base64) return refuse(`There is no key after ${type}.`);
  // The blob names its own type and has a fixed size; a line cut short or edited loses one or the other.
  const blob = decodeBase64(base64);
  if (!blob || blob.length !== BLOB_BYTES[type] || blobType(blob) !== type) {
    return refuse(`That isn't a whole ${type} key. Was the line cut short?`);
  }
  if (/[\x00-\x1f\x7f]/.test(comment)) return refuse("The comment after the key can't hold control characters.");
  const line = comment ? `${type} ${base64} ${comment}` : `${type} ${base64}`;
  const bytes = byteLength(line);
  if (bytes > SSH_KEY_MAX_BYTES) {
    return refuse(`That line is ${bytes} bytes; the bike takes at most ${SSH_KEY_MAX_BYTES}. Shorten the comment after the key.`);
  }
  return { line, problem: "", privateKey: false };
}

/**
 * The key's fingerprint as `ssh-keygen -lf` and `ssh -v` print it: "SHA256:" and the unpadded base64
 * of SHA-256 over the decoded key. "" where crypto.subtle is missing (a page that isn't https).
 * @param {string} base64
 */
export async function sshKeyFingerprint(base64) {
  const blob = decodeBase64(base64);
  if (!blob || !globalThis.crypto?.subtle) return "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, "")}`;
}
