import { describe, it, expect } from "vitest";
import { guardAtlasPageVersions } from "@/lib/atlasPageVersionGuard";

// The fake reproduces the bookkeeping that actually bites (GH #314), not the
// whole atlas: xterm's TextureAtlas merges once the page count reaches
// `maxAtlasPages`, splicing four pages out, pushing a MERGED page carrying
// version 1 (fresh page 0, then one `version++`) and then a fresh page
// carrying version 0. Because the merge fires at exactly `maxAtlasPages` and
// is always -4/+2, the merged page lands at the same index with the same
// version every time — measured on WKWebView as 62 consecutive merges all
// landing index 12 with version 1.
//
// `renderPass` is GlyphRenderer.render's upload rule, which is the half that
// turns that into wrong pixels: upload page `i` only when its version differs
// from the version last uploaded to texture unit `i`.

const MAX_PAGES = 16;

interface Page { version: number; frozen?: boolean }

function makeAtlas() {
  const listeners: Array<() => void> = [];
  const atlas = {
    _pages: [] as Page[],
    onAddTextureAtlasCanvas(listener: () => void) { listeners.push(listener); },
    /** A glyph was rasterized into `page` — the atlas bumps its version. */
    touch(page: Page) { page.version++; },
    addPage() {
      const page: Page = { version: 0 };
      this._pages.push(page);
      for (const l of listeners) l();
      return page;
    },
    /** TextureAtlas._createNewPage's merge branch: four pages out, a merged
     *  page in at `length - 4`, then a fresh page after it.
     *
     *  The merged page is deliberately never `touch`ed again, matching
     *  _mergePages removing it from `_activePages`: no glyph is ever
     *  rasterized into a merged page, so its version stays 1 for the rest of
     *  the session. That is what makes the collision deterministic rather
     *  than a coincidence. */
    merge() {
      this._pages.splice(0, 4);
      const merged: Page = { version: 0 };
      this._pages.push(merged);
      merged.version++;            // the real `mergedPage.version++`
      merged.frozen = true;
      for (const l of listeners) l();
      return this.addPage();       // the fresh page pushed right after
    },
    /** Grow back to the merge threshold, bumping versions on the pages glyphs
     *  actually land in (never the merged ones). */
    fill() {
      while (this._pages.length < MAX_PAGES) {
        const page = this.addPage();
        for (let i = 0; i < 5 + this._pages.length; i++) this.touch(page);
      }
      for (const page of this._pages) {
        if (!page.frozen) this.touch(page);
      }
    },
    /** One real cycle: the atlas regrows to the threshold, then merges. */
    cycle() {
      this.fill();
      this.merge();
    },
  };
  return atlas;
}

const addonFor = (atlas: unknown) => ({ _renderer: { _charAtlas: atlas } });

/** One GlyphRenderer's per-texture-unit version cache. */
function makeRenderer() {
  const uploaded: Array<{ page: Page; version: number } | undefined> = [];
  return {
    uploaded,
    /** Returns the units that will draw the WRONG bitmap: the page at that
     *  index is not the one last uploaded there, yet the version check says
     *  no upload is needed. */
    renderPass(pages: Page[]): number[] {
      const stale: number[] = [];
      pages.forEach((page, i) => {
        const cached = uploaded[i];
        const willUpload = !cached || cached.version !== page.version;
        if (willUpload) uploaded[i] = { page, version: page.version };
        else if (cached.page !== page) stale.push(i);
      });
      return stale;
    },
  };
}

describe("atlas page version guard (GH #314)", () => {
  // The control. If this ever stops finding a stale unit the fake has drifted
  // from the real algorithm and every test below is passing vacuously.
  it("UNGUARDED: a second merge leaves a texture unit sampling the wrong page", () => {
    const atlas = makeAtlas();
    const r = makeRenderer();

    atlas.cycle();
    r.renderPass(atlas._pages);
    // The atlas regrows to the threshold and merges again: a second merged
    // page, carrying version 1 again, lands at the index that already cached
    // version 1 from the first one.
    atlas.cycle();

    const stale = r.renderPass(atlas._pages);
    expect(stale.length).toBeGreaterThan(0);
  });

  it("guarded: repeated merges never leave a stale texture unit", () => {
    const atlas = makeAtlas();
    guardAtlasPageVersions(addonFor(atlas));
    const r = makeRenderer();

    for (let i = 0; i < 10; i++) {
      atlas.cycle();
      expect(r.renderPass(atlas._pages)).toEqual([]);
    }
  });

  it("guards pages created after the guard was installed", () => {
    const atlas = makeAtlas();
    guardAtlasPageVersions(addonFor(atlas));
    atlas.fill();

    const versions = atlas._pages.map(p => p.version);
    expect(new Set(versions).size).toBe(versions.length);
    // Never the 0/1 an unguarded page is born with, which is the whole
    // collision: a merged page's 1 meeting a previously cached 1.
    expect(versions.every(v => v > 1)).toBe(true);
  });

  it("keeps `version++` working, handing out a fresh unique value each time", () => {
    const atlas = makeAtlas();
    const page = atlas.addPage();
    guardAtlasPageVersions(addonFor(atlas));

    const before = page.version;
    atlas.touch(page);
    const after = page.version;
    expect(after).not.toBe(before);

    const other = atlas.addPage();
    atlas.touch(other);
    expect(other.version).not.toBe(after);
  });

  it("is idempotent across terminals sharing one atlas", () => {
    const atlas = makeAtlas();
    atlas.fill();
    const addon = addonFor(atlas);

    guardAtlasPageVersions(addon);
    const first = atlas._pages.map(p => p.version);
    // A second terminal with the same font/theme/dpr gets the SAME atlas.
    guardAtlasPageVersions(addonFor(atlas));
    guardAtlasPageVersions(addon);

    expect(atlas._pages.map(p => p.version)).toEqual(first);
  });

  it("no-ops instead of throwing when the internals are renamed or absent", () => {
    expect(() => guardAtlasPageVersions(undefined)).not.toThrow();
    expect(() => guardAtlasPageVersions(null)).not.toThrow();
    expect(() => guardAtlasPageVersions({})).not.toThrow();
    expect(() => guardAtlasPageVersions({ _renderer: {} })).not.toThrow();
    // Renamed page list: nothing to guard, and no subscription attempt.
    expect(() => guardAtlasPageVersions(addonFor({ _pagesRenamed: [] }))).not.toThrow();
    // Renamed event: the pages present are still guarded.
    const atlas = { _pages: [{ version: 0 }] };
    expect(() => guardAtlasPageVersions(addonFor(atlas))).not.toThrow();
    expect(atlas._pages[0].version).toBeGreaterThan(1);
  });

  it("leaves a non-configurable version property alone rather than throwing", () => {
    const page = {};
    Object.defineProperty(page, "version", { value: 0, configurable: false, writable: true });
    const atlas = { _pages: [page as Page], onAddTextureAtlasCanvas() {} };
    expect(() => guardAtlasPageVersions(addonFor(atlas))).not.toThrow();
    expect((page as Page).version).toBe(0);
  });
});
