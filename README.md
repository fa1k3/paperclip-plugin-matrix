[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# paperclip-plugin-matrix

A [Matrix](https://matrix.org) integration plugin for [Paperclip](https://github.com/paperclipai/paperclip) that transforms Element/Matrix into a bidirectional agent command center with issue threading, reaction-based approvals, bot commands, and multi-room routing.

Built on the Paperclip plugin SDK. Works with any Matrix homeserver (Conduit, Synapse, Dendrite).

## Why Matrix?

| Kriterium | Discord | Slack | **Matrix** |
|-----------|---------|-------|------------|
| Self-hosted | No | No | **Yes (Conduit, 50 MB RAM)** |
| Cost | Free | Paid >10 users | **Free** |
| Data Privacy | US Cloud | US Cloud | **Everything local** |
| Bridges | No | No | **Discord, Slack, Telegram, Signal, WhatsApp** |
| Agents as Users | One bot account | One bot account | **Appservice: one user per agent** |

Matrix keeps communication where the rest of the stack lives: on your own infrastructure. And it can bridge to Discord, Slack, and Telegram, so you get one hub instead of N integrations.

## What It Does

### Outbound: Paperclip Events to Matrix

Paperclip events are posted as rich HTML messages into Matrix rooms, grouped by issue threads:

- **Issue created** -- title, description, priority, assignee status
- **Issue completed** -- done confirmation
- **Comments** -- agent name, body (Markdown-rendered)
- **Approval requests** -- with reaction instructions
- **Approval decisions** -- approved/rejected by whom
- **Agent run started** -- typing indicator in thread
- **Agent run finished/failed** -- completion status, error details

### Inbound: Matrix to Paperclip

- **Reply routing** -- reply to any bot message and it becomes a Paperclip comment on that issue
- **Thread routing** -- messages in an issue thread become Paperclip comments
- **Reaction approvals** -- react with a checkmark to approve, X to reject (power-level gated)
- **Bot commands** -- `!clip` prefix commands for issue management

### Threading Model

```
Matrix Room = Paperclip Project/Company
  +-- Thread (m.thread) = Paperclip Issue
       |-- Root Event: "KAR-42: Neue Landing Page"
       |-- Reply: "Ada hat begonnen..."
       |-- Reply: "index.html erstellt, CSS..."
       |-- Reply: "KAR-42 done"
       +-- User reply in thread --> becomes Paperclip comment
```

### Reaction-Based Approvals

```
Bot posts:
  Approval required: KAR-42
  "Deploy new landing page to Netlify"
  React: checkmark = Approve   X = Reject

User reacts with checkmark -->
  1. Bot checks power level (>= 50 = Moderator)
  2. Bot calls Paperclip Approval API
  3. Bot reacts with flag (confirmed)
  4. Bot posts thread reply: "Approved by @karin:local"
```

### Multi-Room Routing

Map different Matrix rooms to different Paperclip companies/projects. Issues always stay in the room where they were created:

```json
{
  "roomMappings": [
    { "roomId": "!teamA:local", "companyId": "company-1" },
    { "roomId": "!teamB:local", "companyId": "company-1", "projectId": "project-x" },
    { "roomId": "!other:local", "companyId": "company-2" }
  ]
}
```

Unmatched events fall back to `defaultRoomId`.

## Commands

| Command | Description |
|---------|-------------|
| `!clip issue "Title"` | Create a new issue |
| `!clip status` | List open issues |
| `!clip agents` | List available agents |
| `!clip assign KAR-42 ada` | Assign issue to an agent |
| `!clip comment KAR-42 "Text"` | Add comment to issue |
| `!clip approve KAR-42` | Approve pending approval |
| `!clip reject KAR-42 "Reason"` | Reject pending approval |
| `!clip help` | Show help |

## Installation

```bash
npm install paperclip-plugin-matrix
```

Or install from local path:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-matrix","isLocalPath":true}'
```

## Setup

### 1. Start a Matrix Homeserver

The fastest option is [Conduit](https://conduit.rs) (50 MB RAM, no external DB):

```bash
docker run -d --name conduit -p 8448:6167 \
  -e CONDUIT_SERVER_NAME=localhost \
  -e CONDUIT_ALLOW_REGISTRATION=true \
  matrixconduit/matrix-conduit:latest
```

### 2. Create a Bot User

Register a bot user on your homeserver and obtain an access token.

### 3. Configure the Plugin

```bash
# Find plugin ID
curl http://127.0.0.1:3100/api/plugins | jq

# Set config
curl -X POST http://127.0.0.1:3100/api/plugins/PLUGIN_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "configJson": {
      "matrixHomeserverUrl": "http://localhost:8448",
      "matrixAccessToken": "syt_...",
      "matrixBotUserId": "@paperclip:localhost",
      "companyId": "26dc5b3a-...",
      "defaultRoomId": "!abc:localhost"
    }
  }'
```

### 4. Restart Paperclip

Paperclip does not hot-reload plugins. Restart the server to activate the plugin.

## Configuration

| Setting | Required | Default | Description |
|---------|----------|---------|-------------|
| `matrixHomeserverUrl` | Yes | `http://localhost:8448` | Matrix homeserver URL |
| `matrixAccessToken` | Yes | | Bot access token (use a secret-ref for production) |
| `matrixBotUserId` | Yes | | Bot user ID (e.g. `@paperclip:localhost`) |
| `companyId` | Yes | | Paperclip company ID to bridge |
| `defaultRoomId` | Yes | | Default Matrix room for notifications |
| `projectId` | No | | Filter to specific project |
| `paperclipApiUrl` | No | `http://127.0.0.1:3100/api` | Paperclip API URL (must be localhost) |
| `paperclipApiToken` | No | | Bearer token for Paperclip API (use a secret-ref) |
| `approvalMinPowerLevel` | No | `50` | Matrix power level required to approve/reject |
| `enableThreads` | No | `true` | Group issue events in Matrix threads |
| `enableReactionApprovals` | No | `true` | Allow approve/reject via emoji reactions |
| `enableEncryption` | No | `true` | Enable E2E encryption for Matrix rooms |
| `roomMappings` | No | `[]` | Array of `{ roomId, companyId, projectId? }` mappings |

### Power Levels for Approvals

Matrix power levels control who can approve/reject via reactions or commands:

- **0** = Default user (can see and comment)
- **50** = Moderator (can approve/reject) -- default threshold
- **100** = Admin

Configurable via `approvalMinPowerLevel`.

## Security

- **SSRF protection** -- `paperclipApiUrl` is validated to only allow localhost/127.0.0.1
- **UUID validation** -- all API path parameters are validated as UUIDs before interpolation
- **Markdown injection** -- display names are sanitized to prevent Markdown injection in comments
- **Auth headers** -- approval API calls include Bearer token authentication
- **Echo loop prevention** -- comments created from Matrix are tracked to prevent infinite loops
- **Secret references** -- access tokens can be stored as Paperclip secret-refs instead of plaintext
- **0 CVE dependencies** -- uses matrix-js-sdk (actively maintained) with no known vulnerabilities

## Architecture

```
Outbound (Paperclip --> Matrix):
  Paperclip Event (issue.created, approval.created, ...)
  --> Plugin Worker receives event
  --> Formats as HTML
  --> Resolves target room (thread mapping or room mapping)
  --> Posts to Matrix room/thread

Inbound (Matrix --> Paperclip):
  Matrix Event (m.room.message, m.reaction)
  --> Plugin sync loop receives event
  --> Reply to bot message? --> Paperclip Comment
  --> Reaction on approval? --> Paperclip Approval Decision
  --> !clip command? --> Paperclip Action
```

### State Mapping

```
thread:{issueId}        --> { roomId, eventId }         (which thread belongs to which issue)
approval:{eventId}      --> { approvalId, companyId }    (which message is an approval request)
msg:{roomId}:{eventId}  --> { issueId, commentId }       (which bot message belongs to which issue)
```

### Sync & Reconnection

The Matrix sync loop runs in the background with automatic reconnection:

- Exponential backoff: 2s, 4s, 8s, ..., 60s max
- Health check reports actual sync status (not always "ok")
- Graceful shutdown on `plugin.stopping` event
- Sync must not be awaited in `setup()` (Paperclip kills workers after 15s)

## Development

```bash
npm install
npm run build        # TypeScript compilation
npm test             # Run 57 unit tests
npm run test:watch   # Watch mode
npm run dev          # TypeScript watch mode
```

### Project Structure

```
src/
  index.ts          Export manifest
  manifest.ts       Plugin manifest (config schema, capabilities, jobs)
  types.ts          TypeScript interfaces and constants
  matrix.ts         Matrix client wrapper (matrix-js-sdk)
  routing.ts        Room resolution, URL validation, input sanitization
  format.ts         Message formatters (text + HTML)
  worker.ts         Plugin logic (inbound/outbound handlers, commands)
test/
  format.test.ts    Formatter tests (30 tests)
  routing.test.ts   Routing + security tests (27 tests)
```

### Tech Stack

- **Runtime:** Node.js (ESM)
- **Language:** TypeScript 6.0 (strict mode)
- **Matrix SDK:** matrix-js-sdk v41.3
- **Plugin SDK:** @paperclipai/plugin-sdk
- **Tests:** Vitest
- **Build:** tsc

## Known Limitations

1. **Single company per instance** -- for multi-company, install multiple plugin instances
2. **No native buttons in Matrix** -- reactions replace approve/reject buttons
3. **No slash commands** -- prefix commands (`!clip`) instead of `/clip`
4. **Appservice mode not implemented** -- each agent as its own Matrix user is planned for v0.2
5. **`ctx.http.fetch` blocks localhost** -- native `fetch()` used for Paperclip API calls

## Roadmap

### v0.2.0 (planned)

- Appservice mode: each agent = own Matrix user (@ada:local, @jarvis:local)
- Agent sessions in threads (ctx.agents.sessions)
- Media pipeline (images/files)
- Community intelligence (room scanning)

### v0.3.0 (future)

- Matrix Widgets (Paperclip dashboard in Element)
- Federation support (external stakeholders)
- Bridge integration (Discord/Slack transparent)

## Credits

Built with [gstack](https://github.com/garrytan/gstack) AI engineering skills for code review, security audit, and architecture validation.

## License

MIT
