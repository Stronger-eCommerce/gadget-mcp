import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { compareVersions, getUpdateInfo, renderUpdateBox, box, updateNoticeForAgent, UPGRADE_CMD } =
  await import("../update.js");
const { isPinnedEntry } = await import("../setup.js");

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cacheFile = () => join(mkdtempSync(join(tmpdir(), "gadget-mcp-")), "update-check.json");
const registry = (version: string) =>
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version }) } as Response);

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.GADGET_MCP_NO_UPDATE_CHECK;
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("treats a release as newer than its prerelease", () => {
    expect(compareVersions("1.3.0", "1.3.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("getUpdateInfo", () => {
  it("reports a newer version with its kind", async () => {
    registry("2.0.0");
    const info = await getUpdateInfo({ cacheFile: cacheFile(), current: "1.2.0" });
    expect(info).toEqual({ current: "1.2.0", latest: "2.0.0", kind: "major" });
  });

  it("returns null when running the latest or a newer local build", async () => {
    registry("1.2.0");
    expect(await getUpdateInfo({ cacheFile: cacheFile(), current: "1.2.0" })).toBeNull();
    registry("1.2.0");
    expect(await getUpdateInfo({ cacheFile: cacheFile(), current: "1.3.0" })).toBeNull();
  });

  it("uses the cache within 24h and refreshes after", async () => {
    const file = cacheFile();
    writeFileSync(file, JSON.stringify({ checkedAt: 1_000, latest: "1.4.0" }));
    const info = await getUpdateInfo({ cacheFile: file, current: "1.2.0", now: 1_000 + 60_000 });
    expect(info?.kind).toBe("minor");
    expect(mockFetch).not.toHaveBeenCalled();

    registry("1.2.1");
    const later = await getUpdateInfo({ cacheFile: file, current: "1.2.0", now: 1_000 + 25 * 3600_000 });
    expect(later?.kind).toBe("patch");
    expect(JSON.parse(readFileSync(file, "utf8")).latest).toBe("1.2.1");
  });

  it("force bypasses the cache", async () => {
    const file = cacheFile();
    writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: "1.2.0" }));
    registry("1.5.0");
    const info = await getUpdateInfo({ cacheFile: file, current: "1.2.0", force: true });
    expect(info?.latest).toBe("1.5.0");
  });

  it("never throws when offline", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await getUpdateInfo({ cacheFile: cacheFile(), current: "1.0.0" })).toBeNull();
  });

  it("can be disabled with GADGET_MCP_NO_UPDATE_CHECK", async () => {
    process.env.GADGET_MCP_NO_UPDATE_CHECK = "1";
    expect(await getUpdateInfo({ cacheFile: cacheFile(), current: "1.0.0" })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("update prompt rendering", () => {
  it("draws an aligned box", () => {
    const rows = stripAnsi(box(["short", "\x1b[1ma much longer line\x1b[0m"])).split("\n");
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it("includes versions, kind and the upgrade command", () => {
    const out = stripAnsi(renderUpdateBox({ current: "1.2.0", latest: "2.0.0", kind: "major" }));
    expect(out).toContain("1.2.0 → 2.0.0");
    expect(out).toContain("breaking changes");
    expect(out).toContain(UPGRADE_CMD);
  });

  it("gives the agent a plain-text notice", () => {
    const notice = updateNoticeForAgent({ current: "1.2.0", latest: "1.3.0", kind: "minor" });
    expect(notice).toContain("1.2.0 → 1.3.0");
    expect(notice).toContain(UPGRADE_CMD);
    expect(notice).not.toMatch(/\x1b/);
  });
});

describe("isPinnedEntry", () => {
  it("flags configs that don't use @latest", () => {
    expect(isPinnedEntry(["@stronger-ecommerce/gadget-mcp"])).toBe(true);
    expect(isPinnedEntry(["-y", "@stronger-ecommerce/gadget-mcp@1.1.0"])).toBe(true);
    expect(isPinnedEntry(["@stronger-ecommerce/gadget-mcp@latest"])).toBe(false);
    expect(isPinnedEntry(["some-other-mcp"])).toBe(false);
  });
});
