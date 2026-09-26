import { relUnder, baseName } from "@/lib/osPath";
// What a usages row calls its file (GH #174).
//
// Naming every row by its basename alone is what the popup did, and it is
// wrong exactly when it matters: a Django repo has a views.py per app, so nine
// usages across three of them read as nine usages in one file. The old rule
// (strip the directory every row shares) made that worse rather than better,
// since rows in ONE file share all of it and collapse to the basename.
//
// The rule here is PyCharm's, which is the right one: a basename that appears
// once says just the basename, and only a clash pays for a path. A path that
// is long gets its middle elided, because the parts that identify a file are
// its first directory and its name, not the four segments between them.

/** One file to label: its absolute path, and the checkout it belongs to (null
 *  for a file outside any checkout, e.g. site-packages). */
export interface UsagePath {
  path: string;
  root: string | null;
}

/** Segments kept before eliding: `projects/api/views.py` fits, anything longer
 *  becomes `projects/…/views.py`. Three is what reads as a path without
 *  becoming one, and it is what PyCharm shows. */
const MAX_SEGMENTS = 3;

const basename = (p: string) => baseName(p);

/** Path relative to its checkout, or the absolute path when it has none. */
function relative(entry: UsagePath): string {
  const { path, root } = entry;
  return (root && relUnder(path, root)) || path;
}

/** Shorten a path to first segment, ellipsis, name. Leaves anything already
 *  short enough alone. An ABSOLUTE path keeps its leading slash and its first
 *  real segment: splitting "/usr/lib/x.py" gives an empty first element, and
 *  eliding to "/…/x.py" would throw away the only part that says where this
 *  file is. */
function elide(rel: string): string {
  const absolute = rel.startsWith("/");
  const segs = (absolute ? rel.slice(1) : rel).split("/");
  if (segs.length <= MAX_SEGMENTS) return rel;
  const short = `${segs[0]}/…/${segs[segs.length - 1]}`;
  return absolute ? `/${short}` : short;
}

/**
 * Labels for `entries`, positionally. A basename unique across the set is
 * shown bare; a clashing one is shown as its (elided) path.
 *
 * When two elided paths would still read the same (`a/x/views.py` and
 * `a/y/views.py` both elide to `a/…/views.py`), the full relative path is used
 * for those instead: an ambiguous label is the whole problem this solves, and
 * a long row beats a wrong one.
 */
export function usageLabels(entries: UsagePath[]): string[] {
  // DISTINCT files per basename, not rows: nine usages in one views.py are
  // not a clash, and making them pay for a path is the noise the bare-name
  // rule exists to avoid.
  const filesFor = new Map<string, Set<string>>();
  for (const e of entries) {
    const b = basename(e.path);
    const set = filesFor.get(b) ?? new Set<string>();
    set.add(e.path);
    filesFor.set(b, set);
  }

  const rels = entries.map(relative);
  const labels = entries.map((e, i) =>
    (filesFor.get(basename(e.path))?.size ?? 0) > 1
      ? elide(rels[i])
      : basename(e.path));

  // Second pass: any label that is still shared by two DIFFERENT files falls
  // back to the full relative path.
  const owners = new Map<string, Set<string>>();
  labels.forEach((label, i) => {
    const set = owners.get(label) ?? new Set<string>();
    set.add(entries[i].path);
    owners.set(label, set);
  });
  return labels.map((label, i) =>
    (owners.get(label)?.size ?? 0) > 1 ? rels[i] : label);
}
