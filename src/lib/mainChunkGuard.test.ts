import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// CodeMirror's language registry is ~150 grammars, ~800K of them in the
// bundle. termic pays nothing for that at app start ONLY because the registry
// is reachable from the lazily-loaded editor / diff panes and from nowhere
// else, so rolldown puts every grammar behind a dynamic import.
//
// That is a one-line mistake away at all times: `lib/languages` is imported by
// the command palette and the breadcrumb, and the "Set syntax" picker is
// mounted from App.tsx. A static import of `@codemirror/language-data` (or of
// `lib/languageExts`, which is its gateway) from any of them silently moves
// the whole registry onto the app-start path.
//
// So walk the STATIC import graph from the entry point and prove it is not
// there. Dynamic `import()` is what the lazy panes and the picker use and is
// deliberately not followed.
//
// If you are here because this test failed: do not add the module to the
// allowlist. Load it with `await import(...)` at the point of use instead, the
// way SyntaxPalette does.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..");
const ENTRY = resolve(src, "main.tsx");

/** Packages that must never be reachable statically from app start, matched
 *  as prefixes.
 *
 *  The registry index is the obvious one. The GRAMMARS are the one that
 *  actually bit: a single `import { javascript } from "@codemirror/lang-
 *  javascript"` in the settings pane pinned that package into the main chunk,
 *  and the namespace object the registry's own `import()` then received came
 *  back with no `javascript` export at all. Every .ts and .js file in the app
 *  silently fell through to the content sniffer. Nothing in the main chunk may
 *  name a grammar package, however small it looks. */
const FORBIDDEN = [
  "@codemirror/language-data",
  "@codemirror/lang-",
  "@codemirror/legacy-modes",
  "codemirror-lang-",
  // Code intelligence (GH #174) is off by default and most users never arm it,
  // so its client, its LSP types and everything they pull in must be behind a
  // dynamic import. The chip that OFFERS it sits in the main chunk, so this is
  // the same shape as the syntax palette: the affordance is cheap, the
  // machinery is fetched only when it is used.
  "@codemirror/lsp-client",
];
/** Our own modules that exist to pull the forbidden packages in. */
const FORBIDDEN_LOCAL = ["lib/languageExts", "lib/lsp/host", "lib/lsp/editorExtension"];

const EXTS = [".ts", ".tsx", ".js", ".jsx"];

function resolveLocal(spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/")
    ? join(src, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(fromFile), spec)
      : null;
  if (!base) return null;
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  for (const e of EXTS) if (existsSync(join(base, "index" + e))) return join(base, "index" + e);
  return existsSync(base) ? base : null;
}

/** Static specifiers only: `import x from "y"` and `export … from "y"`.
 *  `import type` emits nothing at runtime and `import("y")` is the lazy form
 *  this whole guard exists to encourage, so neither counts. */
function staticImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]);
  return out;
}

/** Every module statically reachable from `main.tsx`, plus the first path by
 *  which each was reached (so a failure names the chain, not just the file). */
function walk(): Map<string, string[]> {
  // Keys use `/` on every OS: the assertions below match suffixes like
  // `lib/languages.ts`, and a Windows path would silently never match,
  // passing the forbidden-import checks without checking anything.
  const seen = new Map<string, string[]>([[norm(ENTRY), [norm(ENTRY)]]]);
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.shift()!;
    const trail = seen.get(norm(file))!;
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      const next = resolveLocal(spec, file);
      const key = next ? norm(next) : spec;
      if (seen.has(key)) continue;
      seen.set(key, [...trail, key]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

function norm(p: string) {
  return p.replaceAll("\\", "/");
}

function rel(p: string) {
  const root = norm(src);
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

describe("main chunk", () => {
  const graph = walk();

  it("walks a graph big enough to mean something", () => {
    // A regex that stopped matching would make every assertion below pass on
    // an empty graph.
    expect(graph.size).toBeGreaterThan(50);
    expect([...graph.keys()].some(k => k.endsWith("lib/languages.ts"))).toBe(true);
  });

  for (const pkg of FORBIDDEN) {
    it(`never statically imports ${pkg}*`, () => {
      const hit = [...graph.entries()].find(([k]) => k.startsWith(pkg));
      expect(hit && `${hit[0]}\n  ← ${hit[1].map(rel).join("\n  ← ")}`).toBeUndefined();
    });
  }

  for (const mod of FORBIDDEN_LOCAL) {
    it(`never statically imports ${mod}`, () => {
      const hit = [...graph.entries()].find(([k]) => k.endsWith(`${mod}.ts`));
      expect(hit && hit[1].map(rel).join("\n  → ")).toBeUndefined();
    });
  }
});
