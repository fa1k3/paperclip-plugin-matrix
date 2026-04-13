import { describe, it, expect } from "vitest";
import { isLocalhostUrl, isValidUuid, resolveRoom, sanitizeDisplayName } from "../src/routing.js";

describe("isLocalhostUrl", () => {
  it("accepts localhost", () => {
    expect(isLocalhostUrl("http://localhost:3100/api")).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isLocalhostUrl("http://127.0.0.1:3100/api")).toBe(true);
  });

  it("accepts ::1 (IPv6 loopback)", () => {
    expect(isLocalhostUrl("http://[::1]:3100/api")).toBe(true);
  });

  it("accepts localhost without port", () => {
    expect(isLocalhostUrl("http://localhost/api")).toBe(true);
  });

  it("accepts https localhost", () => {
    expect(isLocalhostUrl("https://localhost:8448")).toBe(true);
  });

  it("rejects external hosts", () => {
    expect(isLocalhostUrl("http://evil.com:3100/api")).toBe(false);
  });

  it("rejects IPs that look like localhost but aren't", () => {
    expect(isLocalhostUrl("http://127.0.0.2:3100")).toBe(false);
  });

  it("rejects private network IPs", () => {
    expect(isLocalhostUrl("http://192.168.1.1:3100")).toBe(false);
    expect(isLocalhostUrl("http://10.0.0.1:3100")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isLocalhostUrl("")).toBe(false);
  });

  it("rejects invalid URL", () => {
    expect(isLocalhostUrl("not-a-url")).toBe(false);
  });

  it("rejects localhost as subdomain of external host", () => {
    expect(isLocalhostUrl("http://localhost.evil.com:3100")).toBe(false);
  });
});

describe("resolveRoom", () => {
  const defaultConfig = {
    defaultRoomId: "!default:localhost",
    roomMappings: [
      { roomId: "!room-a:localhost", companyId: "company-1" },
      { roomId: "!room-b:localhost", companyId: "company-1", projectId: "project-x" },
      { roomId: "!room-c:localhost", companyId: "company-2" },
    ],
  };

  it("returns default room when no mappings", () => {
    const config = { defaultRoomId: "!default:localhost", roomMappings: [] };
    expect(resolveRoom(config, "company-1")).toBe("!default:localhost");
  });

  it("matches by company only", () => {
    expect(resolveRoom(defaultConfig, "company-1")).toBe("!room-a:localhost");
  });

  it("prefers project+company match over company-only", () => {
    expect(resolveRoom(defaultConfig, "company-1", "project-x")).toBe("!room-b:localhost");
  });

  it("falls back to company match when project doesn't match", () => {
    expect(resolveRoom(defaultConfig, "company-1", "project-unknown")).toBe("!room-a:localhost");
  });

  it("falls back to default when no company matches", () => {
    expect(resolveRoom(defaultConfig, "company-unknown")).toBe("!default:localhost");
  });

  it("falls back to default when companyId is undefined", () => {
    expect(resolveRoom(defaultConfig)).toBe("!default:localhost");
  });

  it("matches different companies", () => {
    expect(resolveRoom(defaultConfig, "company-2")).toBe("!room-c:localhost");
  });
});

describe("isValidUuid", () => {
  it("accepts valid UUIDv4", () => {
    expect(isValidUuid("26dc5b3a-1234-4abc-9def-abcdef012345")).toBe(true);
  });

  it("accepts uppercase UUIDs", () => {
    expect(isValidUuid("26DC5B3A-1234-4ABC-9DEF-ABCDEF012345")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isValidUuid("../../admin/delete")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });

  it("rejects partial UUID", () => {
    expect(isValidUuid("26dc5b3a-1234")).toBe(false);
  });

  it("rejects UUID with extra chars", () => {
    expect(isValidUuid("26dc5b3a-1234-4abc-9def-abcdef012345; DROP TABLE")).toBe(false);
  });
});

describe("sanitizeDisplayName", () => {
  it("passes through normal names", () => {
    expect(sanitizeDisplayName("karin")).toBe("karin");
  });

  it("strips Markdown bold", () => {
    expect(sanitizeDisplayName("**admin**")).toBe("admin");
  });

  it("strips Markdown link syntax", () => {
    expect(sanitizeDisplayName("[evil](http://bad.com)")).toBe("evilhttp://bad.com");
  });

  it("strips backticks", () => {
    expect(sanitizeDisplayName("`code`")).toBe("code");
  });

  it("strips mixed Markdown chars", () => {
    expect(sanitizeDisplayName("~~*_user_*~~")).toBe("user");
  });
});
