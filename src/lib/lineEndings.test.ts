import { describe, it, expect } from "vitest";
import { isPureCrlf } from "./lineEndings";

describe("isPureCrlf", () => {
  it("is true only when every break is CRLF", () => {
    expect(isPureCrlf("a\r\nb\r\n")).toBe(true);
    expect(isPureCrlf("a\nb\n")).toBe(false);
    expect(isPureCrlf("a\r\nb\n")).toBe(false);
    expect(isPureCrlf("no breaks")).toBe(false);
    expect(isPureCrlf("")).toBe(false);
  });
});
