// Suite-wide test environment pinning.
//
// The active language defaults to "system", which follows
// navigator.language, and Node >= 21 exposes a real navigator with the
// machine's locale. On a zh-CN machine every user-visible string renders
// as Chinese and the assertions that match on English catalog text fail,
// which reads like an app bug but is pure environment. The suites are
// written against the English catalog (and CI is an en machine), so pin
// it here; src/locales/parity.test.ts covers the other language's keys.
//
// The other locale-sensitive surface is localStorage (the uiLanguage
// pref): set it too, for the happy-dom files where i18n reads it at
// module load.

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
