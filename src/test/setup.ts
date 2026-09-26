// Runs before every unit-test file (vitest.config.ts `setupFiles`).
//
// The suite runs under node, whose `navigator.userAgent` is neither macOS
// nor Windows, so platform detection would switch the macOS Seatbelt
// sandbox off for every spec. Specs about Seatbelt semantics were written
// against macOS; the ones about the off-macOS clamp flip it themselves.
import { setSeatbeltAvailableForTests } from "@/lib/platform";

setSeatbeltAvailableForTests(true);

// The active language defaults to "system", which follows
// navigator.language, and Node >= 21 exposes a real navigator with the
// machine's locale. On a zh-CN machine every user-visible string renders
// as Chinese and the assertions that match on English catalog text fail,
// which reads like an app bug but is pure environment. The suites are
// written against the English catalog (and CI is an en machine), so pin
// it here; src/locales/parity.test.ts covers the other language's keys.
const nav = typeof navigator !== "undefined" ? navigator : undefined;
if (nav) {
  try {
    Object.defineProperty(nav, "language", { value: "en-US", configurable: true });
    Object.defineProperty(nav, "languages", { value: ["en-US"], configurable: true });
  } catch {
    // A non-configurable navigator would have to fall back to the
    // localStorage pin below (and LANG for node's ICU).
  }
}
try {
  localStorage.setItem("uiLanguage", "en");
} catch {
  // node-environment files have no localStorage; navigator above covers
  // them (and "en" is i18n's own default when it sees no navigator).
}
