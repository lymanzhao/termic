import { describe, it, expect } from "vitest";
import { lastAgentLine } from "./resumeTail";

describe("lastAgentLine", () => {
  it("keeps the agent's reason and drops its colour and cursor codes", () => {
    // The shape claude prints on a background session: styled, with a
    // cursor save/restore around it.
    const raw = "\x1b7\x1b[2mSession abc is running as a background session (abc). "
      + "Run `claude attach abc` to open it.\x1b[0m\x1b8\r\n";
    expect(lastAgentLine(raw)).toBe(
      "Session abc is running as a background session (abc). Run `claude attach abc` to open it.");
  });

  it("drops OSC sequences such as a title change", () => {
    expect(lastAgentLine("\x1b]0;✳ task\x07No conversation found with session ID: x\n"))
      .toBe("No conversation found with session ID: x");
  });

  it("joins the last few lines and trims to a toast-sized string", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(lastAgentLine(raw)).toBe("line 7 line 8 line 9");
    expect(lastAgentLine("x".repeat(500), 20)).toHaveLength(20);
  });

  it("says nothing when nothing was printed", () => {
    expect(lastAgentLine("")).toBe("");
    expect(lastAgentLine("\x1b[?25l\x1b[2J")).toBe("");
  });
});
