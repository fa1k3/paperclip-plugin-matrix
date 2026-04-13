import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-matrix",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Matrix Bridge",
  description:
    "Bidirectional Matrix integration — issue notifications, reply routing, reaction-based approvals, and bot commands via Element/Matrix.",
  author: "fa1k3",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      matrixHomeserverUrl: {
        type: "string",
        title: "Matrix Homeserver URL",
        description: "e.g. http://localhost:8448",
        default: "http://localhost:8448",
      },
      matrixAccessToken: {
        type: "string",
        title: "Bot Access Token",
        description: "Matrix access token for the bot user. Use a secret-ref for production.",
        default: "",
      },
      matrixBotUserId: {
        type: "string",
        title: "Bot User ID",
        description: "e.g. @paperclip:localhost",
        default: "",
      },
      companyId: {
        type: "string",
        title: "Paperclip Company ID",
        description: "Which company to bridge",
        default: "",
      },
      projectId: {
        type: "string",
        title: "Paperclip Project ID (optional)",
        description: "Filter to a specific project. Leave empty for all.",
        default: "",
      },
      defaultRoomId: {
        type: "string",
        title: "Default Matrix Room ID",
        description: "e.g. !abc:localhost — main room for notifications",
        default: "",
      },
      paperclipApiUrl: {
        type: "string",
        title: "Paperclip API URL",
        description: "For approval decisions (native fetch, bypasses ctx.http.fetch localhost block)",
        default: "http://127.0.0.1:3100/api",
      },
      approvalMinPowerLevel: {
        type: "number",
        title: "Minimum Power Level for Approvals",
        description: "Matrix power level required to approve/reject (default: 50 = Moderator)",
        default: 50,
      },
      enableThreads: {
        type: "boolean",
        title: "Enable Threading",
        description: "Use Matrix threads (m.thread) to group issue events",
        default: true,
      },
      enableReactionApprovals: {
        type: "boolean",
        title: "Enable Reaction Approvals",
        description: "Allow approving/rejecting via emoji reactions",
        default: true,
      },
      enableEncryption: {
        type: "boolean",
        title: "Enable E2E Encryption",
        description: "Enable end-to-end encryption for Matrix rooms. Requires @matrix-org/matrix-sdk-crypto-nodejs. Crypto state is stored in ~/.paperclip-plugin-matrix/crypto/",
        default: true,
      },
      paperclipApiToken: {
        type: "string",
        title: "Paperclip API Token",
        description: "Bearer token for Paperclip API calls (approval decisions). Use a secret-ref for production.",
        default: "",
      },
      roomMappings: {
        type: "array",
        title: "Room Mappings",
        description: "Map Matrix rooms to Paperclip companies/projects. New issues route to the matching room. If empty, defaultRoomId is used for everything.",
        default: [],
        items: {
          type: "object",
          properties: {
            roomId: { type: "string", title: "Matrix Room ID", description: "e.g. !abc:localhost" },
            companyId: { type: "string", title: "Company ID" },
            projectId: { type: "string", title: "Project ID (optional)" },
          },
          required: ["roomId", "companyId"],
        },
      },
    },
    required: ["matrixHomeserverUrl", "matrixAccessToken", "matrixBotUserId", "companyId", "defaultRoomId"],
  },
  jobs: [
    {
      jobKey: "matrix-daily-digest",
      displayName: "Daily Digest",
      description: "Send daily issue/agent summary to Matrix",
      schedule: "0 9 * * *",
    },
  ],
  webhooks: [],
  tools: [],
};

export default manifest;
