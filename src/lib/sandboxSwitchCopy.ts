// Confirm copy for moving a task between cages.
//
// It lives here rather than inline in `TaskSandboxDialog` for one reason:
// the session-loss note must ride along with EVERY message that crosses the
// Docker boundary, in either direction, and an inline string is one edit
// away from a new crossing path that forgets it. The builders below are the
// only way to phrase these prompts, and `sandboxSwitchCopy.test.ts` pins the
// invariant.

import { THIS_MACHINE } from "./platform";
/**
 * Crossing into or out of Docker moves where the agent keeps its sessions:
 * in Docker mode that is termic's own mounted config dir
 * (`docker-agents/<agent>`), outside it the agent's real `~/.claude`. The
 * tab's stored session id names a conversation only one of those two stores
 * has ever heard of, so the `--resume` after the switch finds nothing, the
 * CLI exits immediately, and `TerminalPane`'s `failedResume` path relaunches
 * fresh. Nothing is deleted and nothing carries over, and the confirm is the
 * last moment anyone can be told: by the time the terminal is back, the
 * choice has already been made.
 */
export const SESSION_LOSS_NOTE =
  "The conversation does not come with it: an agent keeps its history inside the cage it ran in, so this task's current session cannot be resumed after the switch and the agent starts fresh. The old conversation is not deleted, it stays in the environment that created it.";

/** Confirm body for turning Docker mode on or off for a task. */
export function dockerToggleMessage(toDocker: boolean): string {
  const base = toDocker
    ? "The agent will run inside a Docker container instead of the Seatbelt cage. Any agent currently running in this task will be terminated and relaunched inside the container."
    : "Any agent currently running in this task will be terminated and relaunched outside the container.";
  return `${base} ${SESSION_LOSS_NOTE}`;
}

/** Confirm body for leaving Docker and landing on a Seatbelt mode (or none). */
export function leaveDockerMessage(to: "off" | "seatbelt"): string {
  const base = to === "off"
    ? `The container will be stopped and the agent relaunched on ${THIS_MACHINE} with NO sandbox. Any agent currently running in this task will be terminated and relaunched.`
    : "The container will be stopped and the agent relaunched under the Seatbelt sandbox instead. Any agent currently running in this task will be terminated and relaunched.";
  return `${base} ${SESSION_LOSS_NOTE}`;
}
