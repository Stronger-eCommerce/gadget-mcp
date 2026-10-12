import { describe, it, expect, afterEach } from "vitest";

process.env.GADGET_APP = "secret-shop";
process.env.GADGET_API_KEY = "gsk-supersecretkey123";

const { buildIssueUrl, diagnostics, redact, setClientInfo, ISSUES_URL } = await import("../report.js");

const params = (url: string) => new URL(url).searchParams;

afterEach(() => {
  setClientInfo(undefined);
  delete process.env.GADGET_ALLOW_WRITES;
});

describe("redact", () => {
  it("removes Gadget API keys and bearer tokens", () => {
    const out = redact("key gsk-abc_123-XYZ and Authorization: Bearer eyJhbGci.payload.sig");
    expect(out).not.toContain("gsk-abc_123-XYZ");
    expect(out).not.toContain("eyJhbGci");
    expect(out).toContain("gsk-[REDACTED]");
  });

  it("removes the configured key even if it doesn't look like gsk-", () => {
    process.env.GADGET_API_KEY = "plainkey-0000-1111";
    expect(redact("used plainkey-0000-1111 here")).toBe("used [REDACTED] here");
    process.env.GADGET_API_KEY = "gsk-supersecretkey123";
  });
});

describe("diagnostics", () => {
  it("includes version, node, os and flags but never the key or app slug", () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    setClientInfo({ name: "claude-code", version: "2.1.0" });
    const diag = diagnostics();
    expect(diag).toMatch(/^gadget-mcp: \d+\.\d+\.\d+/);
    expect(diag).toContain(`node: ${process.version}`);
    expect(diag).toContain("client: claude-code 2.1.0");
    expect(diag).toContain("writes: on");
    expect(diag).toContain("deletes: off");
    expect(diag).not.toContain("secret-shop");
    expect(diag).not.toContain("gsk-supersecretkey123");
  });
});

describe("buildIssueUrl", () => {
  it("pre-fills the bug report form by field id", () => {
    const url = buildIssueUrl(
      { title: "count fails", whatHappened: "boom", steps: "1. call it", logs: "Error: x" },
      "gadget-mcp: 1.2.0"
    );
    expect(url.startsWith(ISSUES_URL + "?")).toBe(true);
    const p = params(url);
    expect(p.get("template")).toBe("bug_report.yml");
    expect(p.get("title")).toBe("[Bug]: count fails");
    expect(p.get("what-happened")).toBe("boom");
    expect(p.get("steps")).toBe("1. call it");
    expect(p.get("logs")).toBe("Error: x");
    expect(p.get("diagnostics")).toBe("gadget-mcp: 1.2.0");
    expect(p.has("expected")).toBe(false);
  });

  it("redacts secrets in every field", () => {
    const url = buildIssueUrl({ title: "gsk-supersecretkey123", logs: "Bearer abc.def" }, "x");
    expect(decodeURIComponent(url)).not.toContain("supersecretkey123");
    expect(decodeURIComponent(url)).not.toContain("abc.def");
  });

  it("truncates long error output to keep the URL usable", () => {
    const url = buildIssueUrl({ title: "big", whatHappened: "x", logs: "é".repeat(20_000) }, "diag");
    expect(url.length).toBeLessThanOrEqual(7500);
    expect(params(url).get("logs")).toContain("(truncated)");
    expect(params(url).get("what-happened")).toBe("x");
  });
});
