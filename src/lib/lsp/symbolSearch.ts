// Find a symbol anywhere in the project (GH #174).
//
// PyCharm's ⇧⇧ / ⌥⌘O, and the one navigation feature you reach for with NO
// file open — which is the interesting problem, because a language server is
// per language and there is no open buffer to take a language from.
//
// The answer: ask every server armed for this checkout and merge. A repo with
// Python and TypeScript armed answers about both, which is what "search this
// project" means to the person typing. With nothing armed there is nothing to
// ask, and the caller offers to arm instead of showing an empty list.

import type { LSPClient } from "@codemirror/lsp-client";
import { fuzzyMatch } from "@/lib/fuzzy";
import { clientsForRoot } from "./host";
import { uriToPath } from "./workspace";
import { relUnder } from "@/lib/osPath";

/** LSP SymbolKind → the word a reader recognises. Exported so the
 *  real-server fixture test labels rows the way production does. */
export const KIND_LABEL: Record<number, string> = {
  2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string",
  22: "enum member", 23: "struct", 26: "type",
};

/** The kinds that count as a "class" for a Classes-only filter, which is the
 *  tab people use most in a large project.
 *
 *  22 is EnumMember and 23 is Struct, not the reverse: the table above had
 *  them swapped, so every Rust and Go struct in a result list rendered as a
 *  bare "symbol" and an enum member claimed to be a struct. The fixture test
 *  could not see it, because it carried its own copy of the label map. */
const TYPE_KINDS = new Set([5, 10, 11, 23, 26]);

/**
 * Kinds an IMPORTED name arrives as, rather than a place it is defined.
 *
 * Measured, not assumed. zuban answering `Store` across a real Django project
 * returns 95 symbols: 31 classes and 64 variables, and every one of those
 * variables is an `from stores.models import Store` line in some other module.
 * Nothing in the protocol marks them as imports; they are simply the binding
 * that the import statement creates, and a binding is a variable.
 *
 * A genuine module-level constant is a variable too, which is why this is only
 * half the rule: see `preferDefinitions`.
 *
 * 15 (String) is here for the same reason, found later and in another
 * language. terraform-ls answers a `.tfvars` file with one String symbol per
 * assignment, named for the variable and located at the line that sets it, so
 * a module with dev/stage/prod tfvars answers `Store` with three rows that all
 * match the query EXACTLY while the `variable "Store"` block that declares it
 * matches only as a substring. Measured on terraform-ls 0.39.0: the three
 * assignments led and the declaration came last. An assignment is a binding
 * whatever the protocol calls it, and nothing else termic serves has ever
 * answered `workspace/symbol` with a String at all.
 */
const BINDING_KINDS = new Set([13, 14, 15]);

export interface SymbolHit {
  name: string;
  kind: string;
  kindCode: number;
  /** Absolute path. */
  path: string;
  /** Path shown in the list: relative to the checkout when it is inside it. */
  file: string;
  line: number;
  /** The class or module it lives in, when the server says. */
  container?: string;
  /** Which server answered, so a merged list can be explained. */
  server: string;
  /** How many further places bind this same name, when the rest were
   *  collapsed away (see `collapseRepeatedBindings`). */
  alsoIn?: number;
}

interface WorkspaceSymbol {
  name: string;
  kind: number;
  containerName?: string;
  location?: { uri: string; range?: { start: { line: number } } };
  /** The newer shape allows a location with no range. */
  data?: unknown;
}

/**
 * What to ASK the server, so that case is the client's business and not the
 * server's.
 *
 * Servers disagree, and measurably: zuban matches case-sensitively, so
 * `AISetup` answers 26 symbols in a real project and `AiSetup` answers zero,
 * while gopls and rust-analyzer fold case and match camel humps. The same
 * keystrokes therefore produced a full list or an empty one depending on which
 * language the file happened to be, which is not something a person can be
 * expected to keep track of.
 *
 * The fix is to stop asking a precise question. A name containing `aisetup` in
 * ANY casing also contains `ai` in some casing, so asking for every casing of
 * the first two characters returns a superset of every answer, and the
 * client's own case-insensitive filter narrows it. Two characters is four
 * queries; measured against zuban on a 95-symbol answer they cost 26-28ms
 * each, the same as the precise one, because the work is in the index either
 * way.
 *
 * The exact query goes too. Servers cap what they return for a broad query
 * (rust-analyzer and gopls both do), and the precise one is the insurance
 * that the thing actually typed is in the answer.
 */
export function serverQueries(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const head = q.slice(0, 2);
  const variants = new Set<string>([q]);
  // Every casing of the head: 4 for two letters, fewer once duplicates
  // collapse (digits, `_`, and an all-lowercase query all fold together).
  for (let mask = 0; mask < 1 << head.length; mask++) {
    let v = "";
    for (let i = 0; i < head.length; i++) {
      v += mask & (1 << i) ? head[i].toUpperCase() : head[i].toLowerCase();
    }
    variants.add(v);
  }
  return [...variants];
}

/** Ask one server. Kept separate so a slow or broken server cannot take the
 *  others down with it. */
async function askOne(
  client: LSPClient,
  server: string,
  query: string,
  root: string,
): Promise<SymbolHit[]> {
  // Inside the try, because this is the promise that rejects when a server
  // fails to spawn. It sat outside, so a broken zuban rejected `Promise.all`
  // in searchSymbols and the user got ZERO symbols from the perfectly healthy
  // TypeScript server next to it, on every keystroke. The comment above this
  // function claimed exactly this could not happen.
  try {
    await client.initializing;
  } catch {
    return [];
  }
  if (!client.serverCapabilities?.workspaceSymbolProvider) return [];
  const answers = await Promise.all(serverQueries(query).map(async (q) => {
    try {
      return await client.request<unknown, WorkspaceSymbol[] | null>("workspace/symbol", { query: q });
    } catch {
      return null;
    }
  }));
  const symbols: WorkspaceSymbol[] = answers.flatMap(a => a ?? []);
  const out: SymbolHit[] = [];
  for (const sym of symbols ?? []) {
    const uri = sym.location?.uri;
    if (!uri) continue;
    const path = uriToPath(uri);
    if (!path) continue;
    out.push({
      name: sym.name,
      kind: KIND_LABEL[sym.kind] ?? "symbol",
      kindCode: sym.kind,
      path,
      file: relUnder(path, root) ?? path,
      line: (sym.location?.range?.start.line ?? 0) + 1,
      container: sym.containerName || undefined,
      server,
    });
  }
  return out;
}

export type SymbolScope = "all" | "classes";

/**
 * Search every server armed for this checkout.
 *
 * Results are merged and ranked here rather than per server: two servers
 * answering about one repo is normal (a Django project with a TypeScript
 * frontend), and the reader does not care which process knew the answer.
 */
export async function searchSymbols(
  root: string,
  query: string,
  scope: SymbolScope = "all",
  limit = 60,
): Promise<SymbolHit[]> {
  const clients = clientsForRoot(root);
  if (!clients.length || !query.trim()) return [];
  const answers = await Promise.all(
    clients.map(({ client, server }) => askOne(client, server, query.trim(), root)),
  );
  const seen = new Set<string>();
  const merged: SymbolHit[] = [];
  for (const hit of answers.flat()) {
    if (scope === "classes" && !TYPE_KINDS.has(hit.kindCode)) continue;
    // Two servers can describe the same symbol (a .d.ts and its source, a
    // package present twice); one row per place is what a list should show.
    const key = `${hit.path}:${hit.line}:${hit.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return rankSymbols(keepMatching(preferDefinitions(merged), query), query).slice(0, limit);
}

/**
 * Names that START WITH or CONTAIN the query, when there are any.
 *
 * Servers match more loosely than that and each in its own way, which is
 * measured rather than assumed: rust-analyzer answers `LsSrv` with
 * `LspServer`, and gopls answers `SB` with `StoreByID`. Camel humps, in other
 * words, which is a real IDE feature (JetBrains does it, and it is half the
 * reason ⇧⇧ is fast) and not something to throw away.
 *
 * So the rule is a preference, not a ban. A row whose name literally contains
 * what you typed is a better answer than one that does not, and when any of
 * those exist the rest are noise. When NONE exist, what the server matched is
 * all there is, and an empty list would be a worse answer than a clever one.
 *
 * Ranking then puts a prefix above a mere containment (`rankSymbols`): `Store`
 * gives the class, then `StoreAdmin`, and `MyStoreThing` last.
 */
export function keepMatching(hits: SymbolHit[], query: string): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits;
  // Case is never the reader's problem: `aisetup`, `AiSetup` and `AISetup` are
  // one question. The server was asked in every casing (see serverQueries) so
  // the rows are here to be narrowed.
  const literal = hits.filter(h => h.name.toLowerCase().includes(q));
  if (literal.length) return literal;
  // Then the same matcher ⌘P uses on filenames, which walks separators and
  // camel humps: `aisetup` finds `ai_setup`, `LsSrv` finds `LspServer`. Both
  // are things an IDE is expected to find, and both are what the row's
  // highlight is drawn from, so filtering and highlighting agree.
  const fuzzy = hits.filter(h => fuzzyMatch(h.name, query) !== null);
  // Nothing matched means NOTHING, not everything.
  //
  // This used to fall back to the server's own answer, which was defensible
  // when the server was asked the user's exact query. It stopped being
  // defensible the moment `serverQueries` started deliberately over-fetching:
  // the rows come back for `st`/`St`/`sT`/`ST`, so a query like
  // `storeadmsssssss` that matches nothing returned the entire two-character
  // superset — `Status`, `last_ids`, `CustomSet` — as if they were answers.
  // An empty list is the truth, and the dialog already renders "No matches".
  return fuzzy;
}

/**
 * Drop a name's import sites when the same name is DEFINED somewhere in the
 * answer.
 *
 * This is the whole difference between what termic showed and what an IDE
 * shows. Searching `Store` in a Django project produced 25 rows, every one of
 * them an import line in a different module, and the `class Store` those
 * imports refer to was not on screen at all: it tied with them on name, lost
 * the tiebreak to alphabetical path order (`api/…` sorts above `stores/…`),
 * and fell off the end of the list.
 *
 * Keyed on the NAME, not on the file, because that is the actual relationship:
 * `Store` at `endpoints/offers.py:11` exists only because `Store` is defined
 * in `stores/models.py:64`, so the definition is the answer and the import is
 * a way of spelling it. A name with no definition in the answer keeps its
 * bindings: a constant, or something imported from a dependency the server
 * cannot see into, is then the only place to go, and an empty list would be a
 * worse answer than an imprecise one.
 */
export function preferDefinitions(hits: SymbolHit[]): SymbolHit[] {
  const defined = new Set<string>();
  for (const h of hits) {
    if (BINDING_KINDS.has(h.kindCode)) continue;
    for (const name of definedNames(h)) defined.add(name);
  }
  const kept = defined.size
    ? hits.filter(h => !BINDING_KINDS.has(h.kindCode) || !defined.has(h.name))
    : hits;
  return collapseRepeatedBindings(kept);
}

/**
 * Every name a row is the definition OF. Its own, nearly always.
 *
 * terraform-ls is the exception, and it is not a quirk: it names a symbol the
 * way the block is written, so the row declaring `region` is called
 * `variable "region"` and the row declaring a bucket is called
 * `resource "aws_s3_bucket" "logs"`. On name equality the declaration of
 * `region` is not a definition of `region`, so every assignment of it in a
 * `.tfvars` file survives the filter above and outranks it.
 *
 * The full name is KEPT as well as split, rather than normalised down to the
 * last label. `aws_s3_bucket` is how somebody looks for the S3 bucket in a
 * module they did not write, and it is the half that normalising would throw
 * away. A quoted segment inside a workspace symbol's name is HCL's alone: no
 * other server termic ships has ever produced one.
 */
function definedNames(hit: SymbolHit): string[] {
  const labels = hit.name.match(/"[^"\n]+"/g);
  return labels ? [hit.name, ...labels.map(l => l.slice(1, -1))] : [hit.name];
}

/**
 * How many import sites of one name are worth showing: one, plus the count.
 *
 * The escape hatch above keeps a name's bindings when nothing in the answer
 * DEFINES it, which is right for a constant or something from a dependency the
 * server cannot see into: the import site is then the only place to go. What
 * it is not right about is repetition. Searching `DJANGO` in a Django project
 * returned fifty rows reading `django variable`, one per migration that says
 * `import django`, because the package is defined outside the project and
 * every one of those lines binds the name.
 *
 * Fifty copies of the same non-answer is not fifty answers. They are
 * indistinguishable to the reader, they push every real symbol off the screen,
 * and no amount of server-side exclusion fixes the shape of it: the next
 * repeated import does the same thing.
 */
const MAX_BINDING_SITES = 1;

function collapseRepeatedBindings(hits: SymbolHit[]): SymbolHit[] {
  const seen = new Map<string, number>();
  const out: SymbolHit[] = [];
  for (const hit of hits) {
    if (!BINDING_KINDS.has(hit.kindCode)) { out.push(hit); continue; }
    const n = (seen.get(hit.name) ?? 0) + 1;
    seen.set(hit.name, n);
    if (n <= MAX_BINDING_SITES) out.push(hit);
  }
  // The row says how many places it was, so the count is information rather
  // than something silently dropped.
  return out.map(hit => {
    const total = seen.get(hit.name) ?? 0;
    return total > MAX_BINDING_SITES ? { ...hit, alsoIn: total - MAX_BINDING_SITES } : hit;
  });
}

/**
 * Best match first: exact name, then prefix, then everything else, and
 * shorter names before longer ones at equal rank.
 *
 * Servers rank their own results, but a MERGED list has to be re-ranked or the
 * first result is just whichever server answered first — which for the reader
 * looks like the feature picking at random.
 */
export function rankSymbols(hits: SymbolHit[], query: string): SymbolHit[] {
  const q = query.trim().toLowerCase();
  const score = (h: SymbolHit): number => {
    const name = h.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  return [...hits].sort((a, b) => {
    const d = score(a) - score(b);
    if (d !== 0) return d;
    // A definition before a binding OF THE SAME NAME, and only then.
    //
    // Unqualified, this compared kinds across unrelated symbols and demoted
    // every module-level constant below every function: searching `REVIEW` in
    // a Python project put `review_pr`, `ReviewResult` and `review_single_pr`
    // above `REVIEW_SCHEMA`, `REVIEW_TEMPLATE` and `REVIEW_LOG_LEVEL` — the
    // three the capitals were asking for. A constant is a variable to LSP
    // (kind 13), the same kind an import binding arrives as, so the rule meant
    // to demote import SITES was demoting real definitions of a different
    // shape.
    //
    // Same-name is the only comparison it was ever about, and by then
    // `preferDefinitions` has usually removed the binding: this is the
    // backstop for a name it leaves alone, not a ranking of kinds.
    if (a.name === b.name) {
      const bind = Number(BINDING_KINDS.has(a.kindCode)) - Number(BINDING_KINDS.has(b.kindCode));
      if (bind !== 0) return bind;
    }
    const exact = Number(b.name.includes(query.trim())) - Number(a.name.includes(query.trim()));
    if (exact !== 0) return exact;
    // Then the CASE you typed. Matching is case-insensitive on purpose (a
    // server that folds case and one that does not must behave the same), but
    // the case someone typed is information about what they meant: `REVIEW`
    // is a person looking for the constants, and ranking `review_pr` above
    // `REVIEW_SCHEMA` because it is four characters shorter buries them under
    // the thing they did not ask for. Same rule the other way: `review` puts
    // the functions first.
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name) || a.file.localeCompare(b.file);
  });
}
