/**
 * Integration smoke test for MatrixClient against a real Conduit server.
 *
 * Requires: docker Conduit running on localhost:8448 with:
 *   - Bot user: @testbot:localhost (token: FI91uxnerpukhwvz0vTxfyvrm5hM0vLr)
 *   - Test user: @karin:localhost (token: 3p7OOZQhz9T3lQ4BzqYitfGy7XkCOHK5)
 *   - Room created with bot invited
 *
 * Run: npx vitest run test/smoke.integration.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MatrixClient } from "../src/matrix.js";

const BOT_TOKEN = "FI91uxnerpukhwvz0vTxfyvrm5hM0vLr";
const BOT_USER = "@testbot:localhost";
const HOMESERVER = "http://localhost:8448";
const ROOM_ID = "!twWHtJkFz1f6BPeBtEjCt9-DVYb5Yo09_yfMCImsXWg";

describe("MatrixClient integration (Conduit)", () => {
  let client: MatrixClient;

  beforeAll(async () => {
    client = new MatrixClient(HOMESERVER, BOT_TOKEN, BOT_USER, false);
    await client.init();
  }, 15_000);

  afterAll(async () => {
    await client.stop();
  });

  it("connects and starts sync", async () => {
    await client.start();
    const health = client.getHealthStatus();
    expect(health.connected).toBe(true);
    expect(health.error).toBeNull();
  }, 15_000);

  it("joins a room", async () => {
    const roomId = await client.joinRoom(ROOM_ID);
    expect(roomId).toBe(ROOM_ID);
  }, 10_000);

  it("sends a notice", async () => {
    const res = await client.sendNotice(ROOM_ID, "Smoke test: plain notice");
    expect(res.event_id).toBeTruthy();
    expect(res.event_id).toMatch(/^\$/);
  }, 10_000);

  it("sends a notice with HTML", async () => {
    const res = await client.sendNotice(
      ROOM_ID,
      "Smoke test: **bold** notice",
      "<b>Smoke test:</b> <i>bold</i> notice",
    );
    expect(res.event_id).toBeTruthy();
  }, 10_000);

  let threadRootEventId: string;

  it("sends a message that becomes a thread root", async () => {
    const res = await client.sendNotice(ROOM_ID, "Thread root message");
    threadRootEventId = res.event_id;
    expect(threadRootEventId).toBeTruthy();
  }, 10_000);

  it("sends a thread reply", async () => {
    expect(threadRootEventId).toBeTruthy();
    const res = await client.sendThreadNotice(
      ROOM_ID,
      threadRootEventId,
      "Thread reply",
      "<b>Thread reply</b>",
    );
    expect(res.event_id).toBeTruthy();
    expect(res.event_id).not.toBe(threadRootEventId);
  }, 10_000);

  it("sends a reaction", async () => {
    expect(threadRootEventId).toBeTruthy();
    const res = await client.sendReaction(ROOM_ID, threadRootEventId, "\u2705");
    expect(res.event_id).toBeTruthy();
  }, 10_000);

  it("sets typing indicator", async () => {
    // Should not throw
    await client.setTyping(ROOM_ID, true, 5000);
    await client.setTyping(ROOM_ID, false);
  }, 10_000);

  it("gets power levels", async () => {
    const levels = await client.getPowerLevels(ROOM_ID);
    expect(levels).toBeTruthy();
    expect(typeof levels.users).toBe("object");

    // users_default may be undefined (Conduit omits it when 0)
    const botLevel = client.getUserPowerLevel(levels, BOT_USER);
    expect(typeof botLevel).toBe("number");
    expect(botLevel).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("health status reports connected", () => {
    const health = client.getHealthStatus();
    expect(health.connected).toBe(true);
    expect(health.error).toBeNull();
  });

  it("stops cleanly", async () => {
    await client.stop();
    const health = client.getHealthStatus();
    expect(health.connected).toBe(false);
  });
});
