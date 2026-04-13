# Paperclip Plugin Matrix

## Projektübersicht

Paperclip-Plugin das Matrix (Element) als bidirektionalen Kommunikationskanal für Paperclip-Agents anbindet. Mitarbeiter kommunizieren via Matrix mit Paperclip-Agents — alles dokumentiert und nachvollziehbar in Paperclip Issues.

**Repo:** https://github.com/fa1k3/paperclip-plugin-matrix
**Status:** v0.1.0 — Code fertig, Integration-getestet gegen Conduit, noch nicht in Paperclip-Instanz end-to-end getestet.

## Tech Stack

- **Runtime:** Node.js (ESM)
- **Language:** TypeScript 6.0 (strict mode)
- **Matrix SDK:** matrix-js-sdk v41.3 (0 CVEs, aktiv maintained)
- **Plugin SDK:** @paperclipai/plugin-sdk
- **Tests:** Vitest (68 Tests: 57 Unit + 11 Integration)
- **Build:** tsc

## Architektur

### Dateien

```
src/
  index.ts          Re-export manifest
  manifest.ts       Plugin-Manifest (Config-Schema, Capabilities, Jobs)
  types.ts          Interfaces und Konstanten
  matrix.ts         Matrix-Client-Wrapper (matrix-js-sdk)
  routing.ts        Room-Resolution, URL-Validierung, Input-Sanitization
  format.ts         Nachrichtenformatter (text + HTML)
  worker.ts         Plugin-Logik (In/Outbound-Handler, Commands, Digest)
test/
  format.test.ts    Formatter-Tests (30 Tests)
  routing.test.ts   Routing + Security-Tests (27 Tests)
  smoke.test.ts     Integration-Tests gegen Conduit (11 Tests)
```

### Nachrichtenfluss

```
Outbound (Paperclip → Matrix):
  Paperclip Event (issue.created, approval.created, ...)
  → safeOn() wrapper fängt Fehler pro Handler
  → postToMatrix() resolved Room via Thread-Mapping oder Room-Mapping
  → Formatiert als HTML (format.ts)
  → Postet in Matrix Room/Thread via matrix-js-sdk

Inbound (Matrix → Paperclip):
  Matrix Event (m.room.message, m.reaction)
  → Plugin Sync-Loop empfängt Event (RoomEvent.Timeline)
  → Reply auf Bot-Nachricht? → routeAsComment() → Paperclip Comment
  → Reaction auf Approval? → handleReaction() → Power-Level-Check → Paperclip Approval API
  → !clip Command? → handleCommand() → Paperclip Action
```

### State Mapping (ctx.state)

```
thread:{issueId}        → { roomId, eventId }         (welcher Thread gehört zu welchem Issue)
approval:{eventId}      → { approvalId, companyId }    (welche Nachricht ist ein Approval-Request)
msg:{roomId}:{eventId}  → { issueId, commentId }       (welche Bot-Nachricht gehört zu welchem Issue)
```

### Multi-Room Routing

```
resolveRoom(config, companyId, projectId):
  1. Existierender Thread? → thread.roomId (aus State)
  2. Project+Company Match in roomMappings? → roomMapping.roomId
  3. Company-only Match? → roomMapping.roomId
  4. Fallback → config.defaultRoomId
```

## Sicherheit

- **SSRF-Schutz:** `paperclipApiUrl` wird via `isLocalhostUrl()` validiert (nur localhost/127.0.0.1/::1)
- **UUID-Validierung:** `isValidUuid()` auf allen API-Pfad-Parametern vor fetch()-Interpolation
- **Markdown-Injection:** `sanitizeDisplayName()` strippt Markdown-Sonderzeichen aus Matrix-Usernamen
- **Echo-Loop:** `matrixOriginatedCommentIds` Set trackt selbst erstellte Comments (60s TTL)
- **Auth:** Bearer-Token auf Approval-API-Calls, Secret-Ref-Auflösung für Tokens
- **Error Isolation:** `safeOn()` wrapper um jeden Outbound-Handler — ein Fehler bricht nicht andere Handler
- **0 CVEs:** matrix-js-sdk statt deprecated matrix-bot-sdk (request-Dependency eliminiert)

**Wichtig:** `ctx.http.fetch` blockt localhost/private IPs. Für Paperclip Approval-API-Calls wird native `fetch()` genutzt.

## Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `!clip issue "Titel"` | Neues Issue erstellen |
| `!clip status` | Offene Issues listen |
| `!clip agents` | Verfügbare Agents listen |
| `!clip assign KAR-42 ada` | Issue an Agent zuweisen (ctx.agents.invoke) |
| `!clip comment KAR-42 "Text"` | Kommentar auf Issue |
| `!clip approve KAR-42` | Approval erteilen (Power-Level-Check, API-Call) |
| `!clip reject KAR-42 "Grund"` | Approval ablehnen |
| `!clip help` | Hilfe anzeigen |

## Build & Test

```bash
npm install
npm run build        # TypeScript-Kompilierung
npm test             # Alle 68 Tests (Unit + Integration)
npm run dev          # TypeScript Watch-Mode
```

Integration-Tests brauchen laufenden Conduit auf localhost:8448 (siehe test/smoke.test.ts).

## Konfiguration

```json
{
  "matrixHomeserverUrl": "http://localhost:8448",
  "matrixAccessToken": "syt_...",
  "matrixBotUserId": "@paperclip:localhost",
  "companyId": "26dc5b3a-...",
  "defaultRoomId": "!abc:localhost",
  "paperclipApiUrl": "http://127.0.0.1:3100/api",
  "paperclipApiToken": "secret-ref:...",
  "approvalMinPowerLevel": 50,
  "enableThreads": true,
  "enableReactionApprovals": true,
  "enableEncryption": true,
  "roomMappings": [
    { "roomId": "!teamA:local", "companyId": "company-1" },
    { "roomId": "!teamB:local", "companyId": "company-1", "projectId": "project-x" }
  ]
}
```

## Homeserver-Optionen

### Lokal (Conduit)

```bash
cat > /tmp/conduit.toml <<'EOF'
[global]
server_name = "localhost"
database_path = "/var/lib/conduit"
database_backend = "rocksdb"
address = "0.0.0.0"
port = 6167
allow_registration = true
EOF

docker run -d --name conduit -p 8448:6167 \
  -v /tmp/conduit.toml:/etc/conduit.toml:ro \
  -e CONDUIT_CONFIG=/etc/conduit.toml \
  matrixconduit/matrix-conduit:latest
```

### Erreichbarkeit von aussen

Optionen evaluiert:
- **Tailscale:** Kollidiert mit Mullvad VPN (beide manipulieren Routing-Tabellen)
- **Cloudflare Tunnel:** Funktioniert mit Mullvad, braucht aber Domain
- **Eigene Domain + VPS:** ~55 EUR/Jahr, sauberste Lösung
- **Nope.chat/matrix.org:** Keine Bot-Garantie, Daten auf fremden Servern

**Entscheidung steht aus** — Domain + Hosting-Setup ist nächster Schritt für Produktionsbetrieb.

## Offene Punkte (v0.1 → Produktion)

- [ ] End-to-End Test in echter Paperclip-Instanz (Plugin installieren, Config setzen, Events testen)
- [ ] Hosting-Entscheidung: Domain + VPS oder lokaler Betrieb
- [ ] Optional: Linter einrichten (biome), Dead-Code-Detection (knip)
- [ ] Optional: npm publish für einfachere Installation

## Roadmap

### v0.1.0 (aktuell)
- [x] Outbound: Issue/Approval/Run Notifications mit safeOn() Error Guards
- [x] Inbound: Reply-Routing → Paperclip Comments
- [x] Threading: Issue ↔ Matrix Thread
- [x] Reaction-Approvals: ✅/❌ mit Power-Level-Check
- [x] Commands: !clip issue/status/agents/assign/comment/approve/reject/help
- [x] Typing Indicator bei Agent-Runs
- [x] Daily Digest Job
- [x] Multi-Room Routing (roomMappings)
- [x] Sync Reconnection mit Exponential Backoff
- [x] Health Check (Sync-Status)
- [x] Security: SSRF, UUID-Validation, Markdown-Sanitization, Auth
- [x] matrix-js-sdk Migration (0 CVEs)
- [x] 68 Tests (Unit + Integration gegen Conduit)

### v0.2.0 (geplant)
- [ ] Appservice-Mode: Jeder Agent = eigener Matrix-User (@ada:local, @jarvis:local)
- [ ] Agent Sessions im Thread (ctx.agents.sessions)
- [ ] Media-Pipeline (Bilder/Dateien)
- [ ] Community Intelligence (Room-Scanning)

### v0.3.0 (Zukunft)
- [ ] Matrix Widgets (Paperclip Dashboard im Element)
- [ ] Federation Support (externe Stakeholder)
- [ ] Bridges-Integration (Discord/Slack transparent)

## Referenz-Code

- **mvanhorn Discord-Plugin:** `paperclip-plugin-discord` auf npm — gleiche Plugin-SDK-Architektur, 323+ Tests
- **mvanhorn Slack-Plugin:** `paperclip-plugin-slack` auf npm — Block Kit, Escalation, Media Pipeline
- **Paperclip Plugin SDK:** `@paperclipai/plugin-sdk` — definePlugin, runWorker, PluginContext
- **matrix-js-sdk Docs:** https://matrix-org.github.io/matrix-js-sdk/
