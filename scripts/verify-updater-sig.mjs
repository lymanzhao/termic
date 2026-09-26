#!/usr/bin/env node
// Verify an updater signature the way the in-app updater will: against the
// public key in src-tauri/tauri.conf.json (plugins.updater.pubkey).
//
//   node scripts/verify-updater-sig.mjs <artifact> [<artifact>.sig]
//
// release.yml runs this on the Windows installer before uploading it: a
// signature made with the wrong key, or over the wrong bytes, would otherwise
// only show up as installs that silently never update.
//
// Format: minisign, which is what `tauri signer` writes. Both the key and the
// .sig file are base64 of a minisign text file. The key's payload is
// "Ed" + 8-byte key id + 32-byte Ed25519 public key. The signature file holds
// an untrusted comment, a signature line ("Ed" or "ED" + key id + 64 bytes),
// a trusted comment, and a global signature over signature || trusted comment.
// "ED" means the file was prehashed with BLAKE2b-512 before signing.

import { createPublicKey, createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** The minisign text inside a base64 blob, as its non-empty lines. */
function minisignLines(b64) {
  return Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/).filter(Boolean);
}

/** An Ed25519 public key object from its 32 raw bytes. */
function ed25519Key(raw) {
  // SubjectPublicKeyInfo for Ed25519 is a fixed 12-byte prefix + the key.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function verifyUpdaterSignature(fileBytes, sigB64, pubkeyB64) {
  const keyLines = minisignLines(pubkeyB64);
  const keyBytes = Buffer.from(keyLines[keyLines.length - 1], "base64");
  if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString() !== "Ed") {
    throw new Error("the public key is not a minisign Ed25519 key");
  }
  const keyId = keyBytes.subarray(2, 10);
  const pub = ed25519Key(keyBytes.subarray(10));

  const lines = minisignLines(sigB64);
  if (lines.length < 4) throw new Error("the signature file is not a minisign signature");
  const sig = Buffer.from(lines[1], "base64");
  const trusted = lines[2];
  const globalSig = Buffer.from(lines[3], "base64");
  if (sig.length !== 74) throw new Error("the signature line has the wrong length");
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(keyId)) {
    throw new Error(
      `signed with key ${sig.subarray(2, 10).toString("hex")}, the app trusts ${keyId.toString("hex")}`,
    );
  }
  const message = alg === "ED" ? createHash("blake2b512").update(fileBytes).digest() : fileBytes;
  if (!verify(null, message, pub, sig.subarray(10))) throw new Error("the file signature does not verify");
  if (!trusted.startsWith("trusted comment: ")) throw new Error("the trusted comment is missing");
  const signedComment = Buffer.concat([sig.subarray(10), Buffer.from(trusted.slice("trusted comment: ".length))]);
  if (!verify(null, signedComment, pub, globalSig)) throw new Error("the trusted comment signature does not verify");
  return { keyId: keyId.toString("hex"), prehashed: alg === "ED", trusted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [file, sigArg] = process.argv.slice(2);
  if (!file) die("usage: verify-updater-sig.mjs <artifact> [<artifact>.sig]");
  const sigFile = sigArg ?? `${file}.sig`;
  const conf = JSON.parse(readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (!pubkey) die("no plugins.updater.pubkey in tauri.conf.json");
  try {
    const r = verifyUpdaterSignature(readFileSync(file), readFileSync(sigFile, "utf8"), pubkey);
    console.log(`✓ ${path.basename(file)}: signed by key ${r.keyId}${r.prehashed ? " (prehashed)" : ""}`);
    console.log(`  ${r.trusted}`);
  } catch (e) {
    die(`${path.basename(file)}: ${e.message}`);
  }
}
