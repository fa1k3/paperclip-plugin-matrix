import {
  createClient,
  MatrixClient as JsClient,
  ClientEvent,
  RoomEvent,
  EventType,
  MsgType,
  ReceiptType,
  AutoDiscovery,
} from "matrix-js-sdk";
import type { MatrixEvent, Room, ISendEventResponse } from "matrix-js-sdk";
import type {
  MatrixMessageContent,
  MatrixReactionContent,
  MatrixPowerLevels,
  MatrixSendResponse,
} from "./types.js";

export type MatrixEventHandler = (roomId: string, event: Record<string, unknown>) => void;

/**
 * Matrix client wrapping matrix-js-sdk with optional E2E encryption.
 *
 * Replaces the previous matrix-bot-sdk wrapper to eliminate the deprecated
 * `request` dependency (7 CVEs). matrix-js-sdk uses modern fetch-based HTTP.
 *
 * The SDK manages the /sync loop internally — we hook into events
 * via .on() handlers instead of manual polling.
 */
export class MatrixClient {
  private client!: JsClient;
  private started = false;
  private lastSyncError: string | null = null;

  constructor(
    private readonly homeserverUrl: string,
    private readonly accessToken: string,
    public readonly userId: string,
    private readonly _enableEncryption: boolean = true,
  ) {}

  /**
   * Initialize the SDK client. Must be called before start().
   */
  async init(): Promise<void> {
    this.client = createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.userId,
    });
  }

  /**
   * Start the sync loop. Non-blocking — returns when initial sync completes.
   * Events are delivered via handlers registered with on().
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Wait for first sync to complete
    await new Promise<void>((resolve, reject) => {
      const onSync = (state: string) => {
        if (state === "PREPARED" || state === "SYNCING") {
          this.client.removeListener(ClientEvent.Sync, onSync);
          resolve();
        } else if (state === "ERROR") {
          this.client.removeListener(ClientEvent.Sync, onSync);
          reject(new Error("Matrix sync failed"));
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
      this.client.startClient({ initialSyncLimit: 0 }).catch(reject);
    });

    this.started = true;
  }

  /**
   * Start with automatic reconnection on failure.
   * Uses exponential backoff: 2s → 4s → 8s → ... → 60s max.
   */
  async startWithReconnect(
    onError?: (err: unknown, attempt: number) => void,
  ): Promise<void> {
    const attempt = async (retryCount: number): Promise<void> => {
      try {
        await this.start();
        this.lastSyncError = null;
      } catch (err) {
        this.lastSyncError = String(err);
        const delay = Math.min(2000 * Math.pow(2, retryCount), 60_000);
        onError?.(err, retryCount + 1);
        await new Promise((r) => setTimeout(r, delay));
        this.started = false;
        return attempt(retryCount + 1);
      }
    };
    await attempt(0);

    // Monitor for sync errors after initial connect
    this.client.on(ClientEvent.SyncUnexpectedError, (err: unknown) => {
      if (!this.started) return;
      this.lastSyncError = String(err);
      onError?.(err, -1);
      this.started = false;
      attempt(0).catch(() => {});
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.client.stopClient();
    this.started = false;
  }

  // -- Event Handlers --

  onMessage(handler: MatrixEventHandler): void {
    this.client.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
      if (event.getType() !== EventType.RoomMessage) return;
      if (!room) return;

      const rawEvent = event.event as Record<string, unknown>;
      handler(room.roomId, rawEvent);
    });
  }

  onEvent(handler: MatrixEventHandler): void {
    this.client.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
      if (!room) return;
      const rawEvent = event.event as Record<string, unknown>;
      handler(room.roomId, rawEvent);
    });
  }

  // -- Messages --

  async sendMessage(roomId: string, content: MatrixMessageContent): Promise<MatrixSendResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.client.sendMessage(roomId, content as any);
    return { event_id: res.event_id };
  }

  async sendNotice(roomId: string, text: string, html?: string): Promise<MatrixSendResponse> {
    const content: MatrixMessageContent = {
      msgtype: "m.notice",
      body: text,
    };
    if (html) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = html;
    }
    return this.sendMessage(roomId, content);
  }

  async sendThreadNotice(
    roomId: string,
    threadRootId: string,
    text: string,
    html?: string,
  ): Promise<MatrixSendResponse> {
    const content: MatrixMessageContent = {
      msgtype: "m.notice",
      body: text,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: threadRootId,
        is_falling_back: true,
        "m.in_reply_to": { event_id: threadRootId },
      },
    };
    if (html) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = html;
    }
    return this.sendMessage(roomId, content);
  }

  // -- Reactions --

  async sendReaction(roomId: string, eventId: string, key: string): Promise<MatrixSendResponse> {
    const content: MatrixReactionContent = {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.client.sendEvent(roomId, EventType.Reaction, content as any);
    return { event_id: res.event_id };
  }

  // -- Redact --

  async redact(roomId: string, eventId: string, reason?: string): Promise<void> {
    await this.client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
  }

  // -- Typing --

  async setTyping(roomId: string, typing: boolean, timeout = 30000): Promise<void> {
    await this.client.sendTyping(roomId, typing, timeout);
  }

  // -- Read Receipts --

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const event = room.findEventById(eventId);
    if (!event) return;
    await this.client.sendReadReceipt(event, ReceiptType.Read);
  }

  // -- Room State --

  async getPowerLevels(roomId: string): Promise<MatrixPowerLevels> {
    const state = await this.client.getStateEvent(roomId, "m.room.power_levels", "");
    const raw = state as Record<string, unknown>;
    return {
      users: (raw.users as Record<string, number>) ?? {},
      users_default: typeof raw.users_default === "number" ? raw.users_default : undefined,
      events_default: typeof raw.events_default === "number" ? raw.events_default : undefined,
    };
  }

  // -- Room Management --

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const room = await this.client.joinRoom(roomIdOrAlias);
    return room.roomId;
  }

  // -- Utility --

  getUserPowerLevel(powerLevels: MatrixPowerLevels, userId: string): number {
    return powerLevels.users[userId] ?? powerLevels.users_default ?? 0;
  }

  getHealthStatus(): { connected: boolean; error: string | null } {
    return { connected: this.started, error: this.lastSyncError };
  }
}
