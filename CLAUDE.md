# Paperclip Plugin Matrix

## Projektübersicht

Paperclip-Plugin das Matrix (Element) als bidirektionalen Kommunikationskanal für Paperclip-Agents anbindet. Mitarbeiter kommunizieren via Matrix mit Paperclip-Agents — alles dokumentiert und nachvollziehbar in Paperclip Issues.

## Warum Matrix (statt Slack / Discord)?

### Entscheidungsmatrix

| Kriterium | Discord | Slack | Matrix |
|-----------|---------|-------|--------|
| Self-hosted | Nein | Nein | **Ja (Conduit, 50 MB RAM)** |
| Kosten | Gratis | Ab 10 User kostenpflichtig | Gratis |
| Datenschutz | US-Cloud | US-Cloud | **Alles lokal** |
| Bot-API | Gut, aber Message Content Intent nervt | Sehr gut (Socket Mode) | Gut (Client-Server API) |
| Threading | Forum Channels (umständlich) | **Exzellent** | Gut (m.thread seit Spec 1.4) |
| Interactive Buttons | Native Components | Block Kit | **Nein — Reactions stattdessen** |
| Slash Commands | Native | Native | **Prefix-Commands (!clip)** |
| Bridges zu anderen | Nein | Nein | **Ja (Discord, Slack, Telegram, Signal, WhatsApp)** |
| Agents als eigene User | Ein Bot-Account | Ein Bot-Account | **Appservice → @agent:local pro Agent** |
| Gateway-Komplexität | 344 Zeilen WebSocket | Socket Mode SDK | **client.start() — fertig** |

### Warum Matrix gewonnen hat

1. **Passt zum Stack:** Alles lokal (Paperclip, Hermes, llama-server) — Kommunikation gehört nicht auf US-Cloud-Server
2. **Hermes hat nativen Matrix-Gateway:** `gateway/platforms/matrix.py` (2064 Zeilen, produktionsreif)
3. **Bridges:** Matrix kann zu Discord, Slack, Telegram, Signal bridgen — ein Hub statt N Integrationen
4. **Reactions für Approvals:** Eleganter als Buttons — User reagiert mit Emoji, Bot erkennt und verarbeitet
5. **Agents als eigene User:** Via Appservice erscheint jeder Agent als eigener Matrix-User (@ada:local, @jarvis:local)
6. **Zero Dependencies:** Kein Bot-SDK nötig, raw HTTP gegen Matrix Client-Server API

### Bewusste Abstriche

- **Keine nativen Buttons** → Reactions (✅/❌) ersetzen Approve/Reject Buttons
- **Keine Slash Commands** → Prefix-Commands (`!clip issue "..."`) statt `/clip issue "..."`
- **Kein fertiges Community-Plugin** → Eigenentwicklung, aber nach mvanhorn-Plugin-Muster (Discord/Telegram/Slack)

## Architektur

### Nachrichtenfluss

```
Outbound (Paperclip → Matrix):
  Paperclip Event (issue.created, approval.created, ...)
  → Plugin Worker empfängt Event
  → Formatiert als HTML
  → Postet in Matrix Room/Thread

Inbound (Matrix → Paperclip):
  Matrix Event (m.room.message, m.reaction)
  → Plugin Sync-Loop empfängt Event
  → Reply auf Bot-Nachricht? → Paperclip Comment
  → Reaction auf Approval? → Paperclip Approval Decision
  → !clip Command? → Paperclip Action
```

### State Mapping

```
room:{roomId}           → { companyId, projectId }     (welche Company/Project gehört zu welchem Room)
thread:{issueId}        → { roomId, eventId }          (welcher Matrix-Thread gehört zu welchem Issue)
approval:{eventId}      → { approvalId, companyId }    (welche Matrix-Nachricht ist ein Approval-Request)
msg:{roomId}:{eventId}  → { issueId, commentId }       (welche Bot-Nachricht gehört zu welchem Issue/Comment)
sync-token              → string                        (Matrix Sync-Token für Restart-Persistenz)
```

### Threading-Modell

```
Matrix Room = Paperclip Project/Company
  └── Thread (m.thread) = Paperclip Issue
       ├── Root Event: "KAR-42: Neue Landing Page" (issue.created)
       ├── Reply: "Ada hat begonnen..." (agent.run.started)
       ├── Reply: "index.html erstellt, CSS..." (issue.comment.created)
       ├── Reply: "✅ KAR-42 done" (issue.updated → done)
       └── Neue Nachricht im Thread: User antwortet → wird Paperclip Comment
```

### Reaction-Based Approvals

```
Bot postet:
  🔴 Approval benötigt: KAR-42
  "Neue Landing Page auf Netlify deployen"
  Reagiere: ✅ = Approve  ❌ = Reject

User reagiert mit ✅ →
  1. Bot prüft Power Level (>= 50 = Moderator)
  2. Bot ruft Paperclip Approval API auf
  3. Bot reagiert mit 🏁 (bestätigt)
  4. Bot postet Thread-Reply: "Approved von @karin:local"
```

## Technische Details

### matrix-bot-sdk mit Rust-Crypto-Backend

Das Plugin nutzt `matrix-bot-sdk` (v0.8.x) als Matrix-Client mit optionalem E2E-Encryption-Support via `@matrix-org/matrix-sdk-crypto-nodejs` (Rust Native Bindings).

**Warum SDK statt raw HTTP:**
- E2E Encryption benötigt Olm/Megolm Session-Management — das manuell zu implementieren wäre ~3000+ Zeilen
- `matrix-bot-sdk` kapselt den Sync-Loop, Crypto, Key-Exchange transparent
- Graceful Degradation: wenn `@matrix-org/matrix-sdk-crypto-nodejs` nicht installiert ist, fällt der Bot automatisch auf unverschlüsselten Modus zurück

**E2E Encryption Details:**
- Crypto-State wird auf Disk persistiert: `~/.paperclip-plugin-matrix/crypto/`
- Sync-State: `~/.paperclip-plugin-matrix/sync/bot.json`
- Trust-on-First-Use: Neue Devices werden automatisch akzeptiert
- Verschlüsselung ist transparent — `sendMessage()` verschlüsselt automatisch in E2E-Rooms
- Konfigurierbar via `enableEncryption` (default: true)
- Bei Worker-Restart wird der Crypto-State von Disk geladen → keine Key-Verluste

**Wichtig:** `ctx.http.fetch` blockt localhost/private IPs. Für Paperclip Approval-API-Calls nutzen wir native `fetch()`. Für Matrix-API-Calls geht alles über das SDK.

### Matrix API Endpunkte (intern vom SDK genutzt)

| Endpunkt | Zweck |
|----------|-------|
| `GET /v3/sync` | Long-Polling für Events (SDK-managed) |
| `PUT /v3/rooms/{id}/send/m.room.message/{txn}` | Nachricht senden |
| `PUT /v3/rooms/{id}/send/m.reaction/{txn}` | Reaction senden |
| `PUT /v3/rooms/{id}/typing/{userId}` | Typing Indicator |
| `POST /v3/rooms/{id}/receipt/m.read/{eventId}` | Read Receipt |
| `GET /v3/rooms/{id}/state/m.room.power_levels` | Power Levels lesen |
| `POST /v3/join/{roomId}` | Room beitreten |
| `PUT /v3/rooms/{id}/redact/{eventId}/{txn}` | Event löschen |

### Plugin SDK Nutzung

- **`ctx.issues.*`** für alle Paperclip-Operationen (kein raw HTTP zu localhost nötig)
- **`ctx.agents.*`** für Agent-Sessions und Invocations
- **`ctx.state.*`** für State Mapping (Room↔Company, Thread↔Issue, Approval-Mapping)
- **`ctx.events.on()`** für Paperclip Event-Subscriptions
- **`ctx.secrets.resolve()`** für Access Token
- **`ctx.logger.*`** für strukturiertes Logging
- **`ctx.jobs.register()`** für Daily Digest

### Sync-Loop Pattern

```typescript
// KRITISCH: Sync-Loop darf NICHT awaited werden in setup()!
// Paperclip-Host killt Worker nach 15s wenn setup() nicht returned.
startSyncLoop().catch(err => ctx.logger.error("Sync crashed", { error: String(err) }));
```

Sync-Token wird in `ctx.state` persistiert → bei Worker-Restart kein Full-Sync nötig.

### Power Levels für Approvals

Matrix Power Levels pro Room:
- 0 = Default User (kann sehen, kommentieren)
- 50 = Moderator (kann approven/rejecten)
- 100 = Admin

Konfigurierbar via `approvalMinPowerLevel` in Plugin-Config.

## Konfiguration

```json
{
  "matrixHomeserverUrl": "http://localhost:8448",
  "matrixAccessToken": "syt_...",
  "matrixBotUserId": "@paperclip:localhost",
  "companyId": "26dc5b3a-...",
  "projectId": "eae82bc1-...",
  "defaultRoomId": "!abc:localhost",
  "paperclipApiUrl": "http://127.0.0.1:3100/api",
  "approvalMinPowerLevel": 50,
  "enableThreads": true,
  "enableReactionApprovals": true
}
```

### Homeserver Setup (Conduit)

```bash
docker run -d --name conduit -p 8448:6167 \
  -e CONDUIT_SERVER_NAME=localhost \
  -e CONDUIT_ALLOW_REGISTRATION=true \
  matrixconduit/matrix-conduit:latest
```

50 MB RAM, kein externes DB, 5 Minuten Setup.

## Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `!clip issue "Titel"` | Neues Issue erstellen |
| `!clip status` | Offene Issues listen |
| `!clip agents` | Verfügbare Agents listen |
| `!clip assign KAR-42 ada` | Issue an Agent zuweisen |
| `!clip comment KAR-42 "Text"` | Kommentar auf Issue |
| `!clip approve KAR-42` | Approval erteilen (Fallback zu Reactions) |
| `!clip reject KAR-42 "Grund"` | Approval ablehnen |
| `!clip help` | Hilfe anzeigen |

## Installation

```bash
cd "/home/user/Documents/09 paperclip-plugin-matrix"
npm install
npm run build

# In Paperclip installieren
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/home/user/Documents/09 paperclip-plugin-matrix","isLocalPath":true}'

# Plugin-ID nachschauen
curl http://127.0.0.1:3100/api/plugins | jq

# Config setzen
curl -X POST http://127.0.0.1:3100/api/plugins/PLUGIN_ID/config \
  -H "Content-Type: application/json" \
  -d '{"configJson":{...}}'

# Paperclip neustarten (kein Hot-Reload)
```

## Referenz-Code

- **Hermes Matrix-Adapter:** `gateway/platforms/matrix.py` im NousResearch/hermes-agent Repo — 2064 Zeilen, Reaction-Handling, Threading, E2E, Session-Management
- **mvanhorn Discord-Plugin:** `paperclip-plugin-discord` auf npm — gleiche Plugin-SDK-Architektur, State-Mapping-Pattern
- **mvanhorn Telegram-Plugin:** `paperclip-plugin-telegram` auf npm — Long-Polling-Pattern (wie unser Sync-Loop)
- **Paperclip Plugin SDK:** `@paperclipai/plugin-sdk` — definePlugin, runWorker, PluginContext

## Bekannte Einschränkungen

1. **ctx.http.fetch blockt localhost** → native `fetch()` für Paperclip Approval API
2. **Keine nativen Buttons in Matrix** → Reactions (✅/❌) für Approvals
3. **Keine Slash Commands** → Prefix-Commands (`!clip`)
4. **Single-Company pro Plugin-Instanz** → für Multi-Company: mehrere Instanzen installieren
5. **Appservice-Mode (Multi-User-Bots) nicht implementiert** → v2 Feature
6. **E2E: Trust-on-First-Use** → keine manuelle Device-Verification, neue Devices werden automatisch akzeptiert
7. **Native Rust-Modul** → `@matrix-org/matrix-sdk-crypto-nodejs` muss auf der Zielplattform kompilieren (Linux x86_64: funktioniert out-of-the-box)

## Roadmap

### v0.1.0 (aktuell)
- [x] Outbound: Issue/Approval/Run Notifications
- [x] Inbound: Reply-Routing → Paperclip Comments
- [x] Threading: Issue ↔ Matrix Thread
- [x] Reaction-Approvals: ✅/❌ mit Power-Level-Check
- [x] Commands: !clip issue/status/agents/approve/reject
- [x] Typing Indicator bei Agent-Runs
- [x] Daily Digest Job
- [x] E2E Encryption (matrix-bot-sdk + Rust Crypto, graceful degradation)

### v0.2.0 (geplant)
- [ ] Appservice-Mode: Jeder Agent = eigener Matrix-User
- [ ] Agent Sessions im Thread (ctx.agents.sessions)
- [ ] Media-Pipeline (Bilder/Dateien)
- [ ] Community Intelligence (Room-Scanning)
- [ ] Multi-Company Support (Room-Mapping)

### v0.3.0 (Zukunft)
- [ ] Matrix Widgets (Paperclip Dashboard im Element)
- [ ] Federation Support (externe Stakeholder)
- [ ] Bridges-Integration (Discord/Slack transparent)
- [ ] VoIP-Integration
