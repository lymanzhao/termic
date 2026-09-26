import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyUpdaterSignature } from "../../scripts/verify-updater-sig.mjs";

// The release pipeline checks the Windows updater signature with
// scripts/verify-updater-sig.mjs before publishing. These build minisign
// files the way `tauri signer` writes them (base64 of the minisign text,
// prehashed "ED" signatures) from a throwaway key.
function keyAndSigner(keyId: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const pub = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`,
  ).toString("base64");
  const signFile = (bytes: Buffer, trusted = "timestamp:1\tfile:x") => {
    const digest = createHash("blake2b512").update(bytes).digest();
    const s = sign(null, digest, privateKey);
    const global = sign(null, Buffer.concat([s, Buffer.from(trusted)]), privateKey);
    const text = [
      "untrusted comment: signature from tauri secret key",
      Buffer.concat([Buffer.from("ED"), keyId, s]).toString("base64"),
      `trusted comment: ${trusted}`,
      global.toString("base64"),
    ].join("\n") + "\n";
    return Buffer.from(text).toString("base64");
  };
  return { pub, signFile };
}

describe("verifyUpdaterSignature", () => {
  const id = Buffer.from("0102030405060708", "hex");
  const { pub, signFile } = keyAndSigner(id);
  const file = Buffer.from("Termic_1.0.0_x64-setup.exe bytes");

  it("accepts a file signed by the app's key", () => {
    const r = verifyUpdaterSignature(file, signFile(file), pub);
    expect(r).toMatchObject({ keyId: "0102030405060708", prehashed: true });
  });

  it("refuses a file that changed after signing", () => {
    expect(() => verifyUpdaterSignature(Buffer.from("other bytes"), signFile(file), pub))
      .toThrow(/does not verify/);
  });

  it("refuses a signature from another key, naming both", () => {
    const other = keyAndSigner(Buffer.from("0909090909090909", "hex"));
    expect(() => verifyUpdaterSignature(file, other.signFile(file), pub))
      .toThrow(/0909090909090909.*0102030405060708/);
  });

  it("refuses an edited trusted comment", () => {
    const text = Buffer.from(signFile(file), "base64").toString("utf8")
      .replace("file:x", "file:y");
    expect(() => verifyUpdaterSignature(file, Buffer.from(text).toString("base64"), pub))
      .toThrow(/trusted comment/);
  });
});
