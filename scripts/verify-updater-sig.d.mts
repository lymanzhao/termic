/** Types for verify-updater-sig.mjs, so the unit test can import it. */
export function verifyUpdaterSignature(
  fileBytes: Uint8Array,
  sigB64: string,
  pubkeyB64: string,
): { keyId: string; prehashed: boolean; trusted: string };
