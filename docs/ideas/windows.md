# Windows support: what is left

Status: **idea, not approved.** The first pass of the port landed on the
`feature/windows` branch: the app compiles, installs and launches on
Windows, and CI builds and tests it on every push. What exists, how to build
it, and why each part works the way it does is in
[../windows.md](../windows.md). This file is only what is left, and what has
to be measured on a real Windows machine before it is built.

Line references were read at the branch head on 2026-09-23. If one misses,
grep for the symbol next to it.

## Decisions already made

- Windows 11 x64 first. ARM64 later.
- **The only sandbox is Docker.** Seatbelt is never offered, and a stored
  Seatbelt mode reads as Off (done).
- Closing the window quits. The app draws its own title bar (done:
  `WindowControls`, no native frame).
- Experimental: no Authenticode signing, and the release's Windows job stays
  out of the release job's `needs` (done: `build-windows` / `release-windows`
  in `release.yml`), until someone decides Windows is supported.

## 1. Measure first

These decide designs below. Each is an afternoon on a Windows machine.
Write the answer here, with how it was measured, and delete the question.

**M1. Answered.** Measured on the `windows-latest` runner
(`src-tauri/examples/conpty_osc_probe.rs`, run by
`.github/workflows/windows.yml`), through portable-pty 0.8.1's ConPTY with
no passthrough flag and no bundled `conpty.dll`:

| Path | Result |
|---|---|
| The PTY's own child writes OSC 777, OSC 9, OSC 133 (BEL or ST) | passes through byte for byte |
| A hook: a node parent spawns a child with piped stdio, `windowsHide: false`; the child writes to `CONOUT$` | passes through |
| The same with `windowsHide: true` (`CREATE_NO_WINDOW`) | lost: the child has no console to open |
| A Git Bash hook writing to `/dev/tty` | fails: `/dev/tty: No such device or address` |

So a console-writing hook helper works only for an agent that spawns hooks
without hiding them, which is unknown per agent (M3). Section 2's control
plane design does not depend on it.

**M2. Docker Desktop mounts** (the Docker port is built on these, untested):
- does `-v C:\Users\u\x:/c/Users/u/x` parse on the Windows docker CLI, or
  does it need `--mount type=bind,source=...,target=...`
  (`docker::render_argv`)?
- can a container running as `1000:1000` write a Windows bind mount?
- does the rewritten `.git` pointer mounted read-only over the worktree's
  own work (`git status` inside a Docker task on a worktree)?
- are the hook scripts termic writes executable inside the container? If
  not, register them as `sh <path>` for `Target::Docker`
  (`agent_hooks.rs`, `command_for`).

**M3. Which shell does each agent run hooks and `headersHelper` in on
Windows?** Claude Code uses Git Bash. codex and gemini are unknown. Decides
the MCP helper (section 4).

**M4. IME.** Japanese (MS-IME) and Korean (2-set) into an agent terminal:
each character must arrive once (`src/lib/ime.ts`, and the `keyCode === 229`
short-circuit in `TerminalPane.tsx` / `AuxTerminal.tsx`).

**M5. WebView2 clipboard.** Terminal paste uses
`navigator.clipboard.readText()`. If WebView2 prompts for permission, move
paste to the clipboard-manager plugin (needs
`clipboard-manager:allow-read-text` in `capabilities/default.json`).

**M6. A bare Alt press** may put the window into menu mode and swallow the
next key (Alt+arrow bindings).

## 2. Agent hooks

Done for claude: a per-PTY named pipe as `TERMIC_PTY` (`hook_pipe.rs`), and
the generated scripts write through `termic hook-emit` on Windows, because
neither Git Bash's `>` nor Node's append mode can open a named pipe
(measured). An end-to-end test runs claude's real scripts through Git Bash on
the Windows runner.

Left: the other agents. Their hook commands are registered as `.sh` paths,
which only work if the agent runs hooks in Git Bash (M3). For an agent that
uses cmd or PowerShell, register `bash.exe <script>` or the CLI directly.
The opencode / pi JS plugins would need `fs.writeFileSync` (not append) or a
spawn of `termic hook-emit`.

## 3. Processes

`proc_ctl.rs` tree-kills with `TerminateProcess`. Two things remain:

- **Graceful stop, scripts.** Agents get a Ctrl+C typed into their
  pseudoconsole and STOP_GRACE to exit before the tree kill
  (`graceful_then_kill`). A run script restarted for port release has no
  console to type into (`CREATE_NO_WINDOW`), so it is killed outright;
  `GenerateConsoleCtrlEvent` does not reach a process without a console.
- **Job Objects** would make a tree kill exact (no snapshot race, children
  cannot escape) and let the handle replace the pid in `RUNNING_SCRIPTS`,
  `LSP_SERVERS` and the grep map. The PTY side needs
  `Child::clone_killer()` on the `PtySlot`.

## 4. CLI and MCP

- **Named-pipe transport.** The control plane is loopback TCP
  (`termic_proto::local`), so another local account can reach the three
  unauthenticated verbs (`hello`, `raise`, `open_url`). A named pipe named
  per data dir, created with `FILE_FLAG_FIRST_PIPE_INSTANCE`,
  `PIPE_REJECT_REMOTE_CLIENTS` and a current-user DACL, plus a peer SID
  check (`GetNamedPipeClientProcessId`, then the token user) closes that.
  All pipe IO must be overlapped: attach reads and writes one connection
  from two threads, which deadlocks on a synchronous pipe. The CLI must also
  verify the SERVER's identity before sending the token, because the pipe
  namespace is machine-wide.
- **Token file ACL.** The token files inherit the data dir's ACL (user,
  SYSTEM, Administrators). An explicit protected user-only DACL at creation
  (`cli_server::write_token_file`) would match the unix 0600.
- **Installing `termic` onto PATH** (`cli_server.rs`, `windows_unsupported`):
  keep a copy at `%LOCALAPPDATA%\termic\bin\termic.exe`, refreshed at launch
  when its version differs (rename the running one aside, then copy);
  "Add to PATH" appends that dir to `HKCU\Environment\Path` and broadcasts
  `WM_SETTINGCHANGE`. Never put the app's install dir on PATH (`termic`
  would resolve to `Termic.exe`). No `.cmd` wrapper: cmd re-parses `%*`.
  CLI auto-launch (`termic-cli/src/client.rs`) needs the app's path recorded
  somewhere it can read.
- **MCP headers helper** (`mcp_server.rs`, `helper_command`) is a POSIX
  `printf ... "$(cat ...)"`. Replace with a shell-free `termic-cli.exe
  mcp-headers` if M3 says an agent runs it outside bash.

## 5. Language servers

Done: pinned Windows downloads, and the Windows checkout layouts. Left:
zuban's own venv installer (`Scripts\python.exe`, `py -3`), and the tests
that pin the unix layouts are `#[cfg(unix)]`
(`the_checkouts_own_toolchain_wins_over_path` and its neighbours).

## 6. Smaller gaps

- **PDF preview.** Tauri serves custom schemes as
  `http://taskpdf.localhost/` on Windows, and the CSP's `object-src` does not
  cover it (`previewPaths.ts`). A CSP change: maintainer only
  (`src/lib/cspGuard.test.ts`).
- **Activity monitor** (`procmon_other.rs` answers "unsupported").
- Remaining macOS copy: the Settings sandbox text in `RepositorySection.tsx`
  and `TaskSandboxDialog.tsx` describes Seatbelt, which Windows never shows
  as a choice but still explains.
- Tray icon: `icon_as_template(true)` is a macOS idea; check it is visible on
  a dark taskbar.

## 7. Tests and CI

- **e2e on Windows** runs in CI (`windows.yml`, reporting, not gating), with
  a screenshot, the window text and the profile's `e2e-*.log` files captured
  at every failure (`TERMIC_E2E_FAIL_CAPTURE`). The whole suite runs in about
  18 minutes, and it has passed 19 of 19 spec files. Intermittent on the
  runner, each passing on the run before or after:
  - the #311 picker cases: the typed pick sometimes never reaches the fake
    picker's `read`. The fixture logs what it skips and reads
    (`e2e-picker.log`); the focus report is one cause, not all of them.
  - the IME key-rollover case and the delegated-message case in
    `agent.e2e.ts`.
  - a temp repo that stays busy after its project is removed, with no
    termic child process in it (`rmTree` lists the processes). Either
    Defender or the indexer on a fresh `.git`, or a handle termic itself
    keeps; `handle.exe` on a Windows machine would tell which.
- **Release.** Done: `build-windows` and `release-windows` in `release.yml`.
  Left: Authenticode signing
  (Azure Trusted Signing through `bundle.windows.signCommand`) or accept the
  SmartScreen warning, and a real update from one release to the next
  observed on a Windows machine (does the app come back after the passive
  install).

## Open questions

- Is Windows supported or an experiment? Decides signing, the release job,
  and whether amd64 hardware gets bought for perf sign-off (Apple Silicon
  cannot run x64 Windows, and emulated timings are not a perf signal).
- Does anyone want it? No Windows demand is recorded in the repo.
