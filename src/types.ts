// -- Plugin Config --

export interface PluginConfig {
  matrixHomeserverUrl: string;
  matrixAccessToken: string;
  matrixBotUserId: string;
  companyId: string;
  projectId?: string;
  defaultRoomId: string;
  paperclipApiUrl: string;
  approvalMinPowerLevel: number;
  enableThreads: boolean;
  enableReactionApprovals: boolean;
  enableEncryption: boolean;
  paperclipApiToken: string;
  roomMappings: RoomMapping[];
}

// -- Matrix Types (used by matrix.ts SDK wrapper) --

export interface MatrixMessageContent {
  msgtype: "m.text" | "m.notice" | "m.image" | "m.file";
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.relates_to"?: MatrixRelatesTo;
}

export interface MatrixReactionContent {
  "m.relates_to": {
    rel_type: "m.annotation";
    event_id: string;
    key: string;
  };
}

export interface MatrixRelatesTo {
  rel_type?: "m.thread" | "m.annotation";
  event_id?: string;
  "m.in_reply_to"?: { event_id: string };
  is_falling_back?: boolean;
}

export interface MatrixPowerLevels {
  users: Record<string, number>;
  users_default: number;
  events_default: number;
}

export interface MatrixSendResponse {
  event_id: string;
}

// -- State Mapping Types --

export interface RoomMapping {
  roomId: string;
  companyId: string;
  projectId?: string;
}

export interface ThreadMapping {
  roomId: string;
  eventId: string;
}

export interface ApprovalMapping {
  approvalId: string;
  issueId: string;
  companyId: string;
}

export interface MessageMapping {
  issueId: string;
  commentId?: string;
  type: "issue" | "comment" | "approval" | "run";
}

// -- Constants --

export const REACTION_APPROVE = "\u2705"; // ✅
export const REACTION_REJECT = "\u274C";  // ❌
export const REACTION_CONFIRMED = "\uD83C\uDFC1"; // 🏁
export const REACTION_EYES = "\uD83D\uDC40"; // 👀

export const COMMAND_PREFIX = "!clip";
