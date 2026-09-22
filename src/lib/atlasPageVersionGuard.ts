// GH #314: after a long, colourful session every cell in a terminal draws a
// FRAGMENT OF SOME OTHER GLYPH. The cell grid, the spacing and the colours are
// all correct; only the pixels are wrong. Selecting the text fixes the
// selected part (new bg = new cache key = a freshly rasterized glyph) and it
// comes straight back on deselect, which is what says the damage is in the
// cached entries rather than in the draw.
//
// xterm's WebGL renderer uploads an atlas page to texture unit `i` only when
// `pages[i].version !== _atlasTextures[i].version` (GlyphRenderer.render). But
// `version` is a PER-PAGE counter starting at 0, used as though it were a page
// IDENTITY. When the atlas outgrows `maxAtlasPages` it merges four pages into
// one (TextureAtlas._createNewPage): four pages are spliced out, a merged page
// is pushed carrying version 1 (fresh page 0, then one `version++`), and a
// fresh page is pushed after it carrying version 0. The merge fires at exactly
// `maxAtlasPages` every time, drops 4 and adds 2, so the merged page lands at
// THE SAME INDEX with THE SAME VERSION on every merge. From the second merge
// on, that index already cached version 1 from the previous merge's page, the
// equality test passes, the upload is skipped, and the unit keeps the old
// page's bitmap while the new page's glyph coordinates index into it.
//
// Not a race and not an unlucky collision: it is structural, and it reproduces
// on demand in both engines. Measured on WKWebView (the shipping target):
// MAX_TEXTURE_IMAGE_UNITS 16, so merges start at 16 pages, and 62 consecutive
// merges each landed the merged page at index 12 with version 1, leaving 1-2
// texture units permanently stale. Headless Chrome (SwiftShader, 32 units)
// does the same at index 28. A terminal in that state renders ~1 glyph in 16
// from the wrong bitmap, which is why the report says "doesn't always happen":
// whether you SEE it depends on whether the text on screen happens to use the
// stale page.
//
// Fix: give every AtlasPage a version drawn from ONE monotonic counter, so no
// two pages can ever present the same version at the same texture unit. The
// setter ignores the assigned value, which keeps `version++` (read current,
// write a fresh unique number) working exactly as the atlas expects. Verified
// to take stale units to 0 across five merges in Chrome and to render the same
// glyph stream correctly in WKWebView where the unguarded terminal drew debris.
//
// UPSTREAM, and the deletion criterion is concrete. xtermjs/xterm.js#6038
// ("[webgl] Atlas page merge corruption and overflow under heavy terminal
// rendering", closed 2026-07-21) is this bug, and the fix landed in
// @xterm/addon-webgl 0.20.0-beta.300 as exactly this approach:
// `public static nextVersion` on AtlasPage, with every `version++` replaced by
// `version = ++AtlasPage.nextVersion`. The same release also replaces the
// never-reset `_requestClearModel` flag with a monotonic `_pageLayoutVersion`
// (see docs/performance.md bear trap 11).
//
// 0.20.0 is BETA only; npm `latest` is still 0.19.0, which is what we ship.
// So: when @xterm/addon-webgl 0.20.0 goes stable and we upgrade, delete this
// module, its test, its wiring in loadTerminalRenderer and its entries in
// xtermInternals.test.ts. Until then it is load-bearing. Tracked in
// docs/tech-debt.md.
//
// Reach-ins are optional-chained and pinned by xtermInternals.test.ts, so a
// rename degrades to today's behaviour (the bug) rather than throwing.

/** One counter for every page of every atlas in the process. Starts above 0 so
 *  a guarded page can never collide with the 0/1 an unguarded one is born
 *  with (the atlas's first page exists before any addon can guard it). */
let nextVersion = 1_000_000;

/** Pages already converted, and atlases already subscribed. Weak so a disposed
 *  atlas and its pages stay collectable. */
const guardedPages = new WeakSet<object>();
const subscribedAtlases = new WeakSet<object>();

interface AtlasPageLike {
  version?: number;
}

interface AtlasLike {
  _pages?: AtlasPageLike[];
  onAddTextureAtlasCanvas?: (listener: () => void) => unknown;
}

/** Replace `page.version` with an accessor over the shared counter. Idempotent;
 *  a page is converted at most once. */
function uniquifyPageVersion(page: AtlasPageLike | undefined): void {
  if (!page || typeof page !== "object" || guardedPages.has(page)) return;
  let version = ++nextVersion;
  try {
    Object.defineProperty(page, "version", {
      get: () => version,
      // The atlas only ever does `version++`, so the value it writes is
      // meaningless to us: what matters is that the page now reads as
      // something no other page has ever read as.
      set: () => { version = ++nextVersion; },
      configurable: true,
      enumerable: true,
    });
  } catch {
    return; // non-configurable in some future xterm: leave it alone
  }
  guardedPages.add(page);
}

/** Guard every atlas page `addon` can currently see, and keep guarding the
 *  ones it creates later. Safe to call repeatedly and from several terminals
 *  sharing one atlas (same font/theme/dpr get the same TextureAtlas). */
export function guardAtlasPageVersions(addon: unknown): void {
  const atlas = (addon as { _renderer?: { _charAtlas?: AtlasLike } } | null | undefined)
    ?._renderer?._charAtlas;
  if (!atlas) return;

  // Read `_pages` fresh on every run: the array identity survives merges, but
  // reading through the atlas keeps this correct if that ever stops being true.
  const guardAll = () => {
    const pages = atlas._pages;
    if (!Array.isArray(pages)) return;
    for (const page of pages) uniquifyPageVersion(page);
  };

  guardAll();

  // Every page the atlas creates (normal, merged, and the oversized-glyph
  // page) fires this PUBLIC event at creation, before any render can read the
  // new page's version. One subscription per atlas, never disposed: the
  // listener dies with the atlas, and the atlas outlives any single terminal.
  if (subscribedAtlases.has(atlas)) return;
  subscribedAtlases.add(atlas);
  try {
    atlas.onAddTextureAtlasCanvas?.(guardAll);
  } catch {
    // Rename or signature change: the pages present at attach are still
    // guarded, later ones are not. Degrades, never throws.
  }
}
