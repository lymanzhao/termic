import { describe, it, expect } from "vitest";
import { kbd } from "./platform";

describe("kbd", () => {
  it("leaves the macOS form alone on macOS", () => {
    expect(kbd("⇧⌘B", true)).toBe("⇧⌘B");
  });
  it("spells combinations out in Windows order and names elsewhere", () => {
    expect(kbd("⇧⌘B", false)).toBe("Ctrl+Shift+B");
    expect(kbd("⌥⌘P", false)).toBe("Ctrl+Alt+P");
    expect(kbd("⌘↵", false)).toBe("Ctrl+Enter");
    expect(kbd("⌘,", false)).toBe("Ctrl+,");
    expect(kbd("⌥", false)).toBe("Alt");
  });
});
