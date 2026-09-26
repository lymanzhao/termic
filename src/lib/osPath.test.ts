import { describe, it, expect } from "vitest";
import { toContainerPath, quoteWindowsPath, terminalPathText, relUnder, baseName, joinPath, pathToFileUri, fileUriToPath } from "./osPath";

describe("toContainerPath", () => {
  it("is the identity off Windows", () => {
    expect(toContainerPath("/Users/u/a b.png", false)).toBe("/Users/u/a b.png");
  });
  it("maps a drive path to the container's /<drive>/ form, as docker.rs mounts it", () => {
    expect(toContainerPath("C:\\Users\\u\\shot.png", true)).toBe("/c/Users/u/shot.png");
    expect(toContainerPath("\\\\?\\D:\\wt\\api", true)).toBe("/d/wt/api");
    expect(toContainerPath("C:\\", true)).toBe("/c");
  });
});

describe("terminalPathText", () => {
  it("backslash-escapes on macOS, as Terminal.app does", () => {
    expect(terminalPathText("/Users/u/a b.png", false, false)).toBe("/Users/u/a\\ b.png");
  });
  it("quotes a native Windows path instead of escaping its separators", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", false, true)).toBe('"C:\\Users\\u\\a b.png"');
    expect(terminalPathText("C:\\Users\\u\\ab.png", false, true)).toBe("C:\\Users\\u\\ab.png");
  });
  it("types the container path, escaped, into a Docker task on Windows", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", true, true)).toBe("/c/Users/u/a\\ b.png");
  });
  it("doubles embedded quotes", () => {
    expect(quoteWindowsPath('C:\\a "b"')).toBe('"C:\\a ""b"""');
  });
});


describe("relUnder", () => {
  it("is a segment boundary, not a raw prefix", () => {
    expect(relUnder("/repo/src/a.ts", "/repo", false)).toBe("src/a.ts");
    expect(relUnder("/repo-old/a.ts", "/repo", false)).toBeNull();
    expect(relUnder("/repo", "/repo", false)).toBeNull();
  });
  it("ignores case and separator style on Windows", () => {
    expect(relUnder("c:\\Repo\\src\\a.ts", "C:\\repo", true)).toBe("src/a.ts");
    expect(relUnder("C:/repo/src/a.ts", "C:\\repo\\", true)).toBe("src/a.ts");
    expect(relUnder("C:\\repo-old\\a.ts", "C:\\repo", true)).toBeNull();
  });
});

describe("file URIs", () => {
  it("keeps the unix encoding byte for byte", () => {
    expect(pathToFileUri("/tmp/a#b", false)).toBe("file:///tmp/a%23b");
    expect(fileUriToPath("file:///tmp/a%23b", false)).toBe("/tmp/a#b");
  });
  it("uses file:///C:/... on Windows and round-trips to a native path", () => {
    expect(pathToFileUri("C:\\Users\\u\\a b.ts", true)).toBe("file:///C:/Users/u/a%20b.ts");
    expect(fileUriToPath("file:///C:/Users/u/a%20b.ts", true)).toBe("C:\\Users\\u\\a b.ts");
    // VS Code style (encoded colon) decodes too.
    expect(fileUriToPath("file:///c%3A/x/y.ts", true)).toBe("c:\\x\\y.ts");
  });
  it("takes the last segment on either separator on Windows", () => {
    expect(baseName("C:\\a\\b.ts", true)).toBe("b.ts");
    expect(baseName("/a/b.ts", false)).toBe("b.ts");
  });
});

describe("joinPath", () => {
  it("joins with the platform's separator, dropping a trailing one", () => {
    expect(joinPath("/Users/u/src/", "repo", false)).toBe("/Users/u/src/repo");
    expect(joinPath("/", "repo", false)).toBe("/repo");
    expect(joinPath("C:\\Users\\u\\src\\", "repo", true)).toBe("C:\\Users\\u\\src\\repo");
    expect(joinPath("C:\\", "repo", true)).toBe("C:\\repo");
    expect(joinPath("C:/Users/u/src/", "repo", true)).toBe("C:/Users/u/src\\repo");
  });
});
