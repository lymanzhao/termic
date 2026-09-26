#!/usr/bin/env node
// Run the Tauri CLI with extra environment variables, portably.
//
//   node scripts/tauri-env.mjs VITE_E2E=1 -- build --debug --no-bundle --features e2e
//
// npm runs package.json scripts through cmd.exe on Windows, where the POSIX
// `VITE_E2E=1 tauri build` prefix is a syntax error, and where
// node_modules/.bin/tauri is a shell shim cmd cannot run. So: parse the
// NAME=value pairs before `--`, and start the CLI's own JS entry point with
// this node. Identical behaviour on macOS and Linux.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const pairs = sep === -1 ? [] : args.slice(0, sep);
const rest = sep === -1 ? args : args.slice(sep + 1);

const env = { ...process.env };
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i <= 0) {
    console.error(`tauri-env: expected NAME=value before --, got "${p}"`);
    process.exit(2);
  }
  env[p.slice(0, i)] = p.slice(i + 1);
}

const here = dirname(fileURLToPath(import.meta.url));
const tauriJs = resolve(here, "../node_modules/@tauri-apps/cli/tauri.js");
const r = spawnSync(process.execPath, [tauriJs, ...rest], { stdio: "inherit", env });
process.exit(r.status ?? 1);
