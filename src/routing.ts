import type { PluginConfig, RoomMapping } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Strip Markdown special chars from a display name to prevent injection
 * when the name is embedded in Markdown content (e.g. Paperclip comments).
 */
export function sanitizeDisplayName(name: string): string {
  return name.replace(/[*_`\[\]()~>#|\\]/g, "");
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function resolveRoom(config: Pick<PluginConfig, "defaultRoomId" | "roomMappings">, companyId?: string, projectId?: string): string {
  if (config.roomMappings.length === 0) return config.defaultRoomId;

  // Prefer project+company match, then company-only match
  if (projectId) {
    const projectMatch = config.roomMappings.find(
      (m) => m.companyId === companyId && m.projectId === projectId,
    );
    if (projectMatch) return projectMatch.roomId;
  }

  const companyMatch = config.roomMappings.find(
    (m) => m.companyId === companyId && !m.projectId,
  );
  if (companyMatch) return companyMatch.roomId;

  return config.defaultRoomId;
}
