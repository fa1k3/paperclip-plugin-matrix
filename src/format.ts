import { REACTION_APPROVE, REACTION_REJECT } from "./types.js";

/**
 * Format Paperclip events as Matrix HTML messages.
 * All formatters return { text, html } for plain-text fallback + rich HTML.
 */

interface Formatted {
  text: string;
  html: string;
}

// -- Issues --

export function formatIssueCreated(issue: Record<string, unknown>): Formatted {
  const id = issue.identifier ?? issue.id ?? "?";
  const title = String(issue.title ?? "Untitled");
  const priority = issue.priority ? ` | Priority: ${issue.priority}` : "";
  const assignee = issue.assigneeAgentId ? ` | Assigned` : " | Unassigned";
  const desc = issue.description ? `\n${truncate(String(issue.description), 300)}` : "";

  return {
    text: `📋 ${id}: ${title}${priority}${assignee}${desc}`,
    html:
      `<b>\uD83D\uDCCB ${escHtml(String(id))}: ${escHtml(title)}</b>` +
      `<br/><sub>${escHtml(priority.slice(3))}${escHtml(assignee.slice(3))}</sub>` +
      (desc ? `<br/><blockquote>${escHtml(desc.trim())}</blockquote>` : ""),
  };
}

export function formatIssueDone(issue: Record<string, unknown>): Formatted {
  const id = issue.identifier ?? issue.id ?? "?";
  const title = String(issue.title ?? "");

  return {
    text: `✅ ${id} — done${title ? `: ${title}` : ""}`,
    html: `<b>\u2705 ${escHtml(String(id))}</b> — done${title ? `: ${escHtml(title)}` : ""}`,
  };
}

// -- Comments --

export function formatComment(
  issue: Record<string, unknown>,
  comment: Record<string, unknown>,
  agentName?: string,
): Formatted {
  const id = issue.identifier ?? issue.id ?? "?";
  const body = String(comment.body ?? "");
  const author = agentName ?? "Unknown";

  return {
    text: `💬 ${author} on ${id}:\n${truncate(body, 500)}`,
    html:
      `<b>\uD83D\uDCAC ${escHtml(author)}</b> on <b>${escHtml(String(id))}</b>:` +
      `<br/>${markdownToHtml(body)}`,
  };
}

// -- Approvals --

export function formatApprovalRequest(approval: Record<string, unknown>): Formatted {
  const issueId = approval.issueIdentifier ?? approval.issueId ?? "?";
  const title = String(approval.title ?? approval.description ?? "Approval required");
  const agentName = approval.agentName ?? "Agent";

  return {
    text:
      `🔴 Approval benötigt: ${issueId}\n` +
      `"${title}"\n` +
      `Von: ${agentName}\n\n` +
      `Reagiere: ${REACTION_APPROVE} = Approve  ${REACTION_REJECT} = Reject`,
    html:
      `<b>\uD83D\uDD34 Approval benötigt: ${escHtml(String(issueId))}</b><br/>` +
      `<i>"${escHtml(title)}"</i><br/>` +
      `Von: ${escHtml(String(agentName))}<br/><br/>` +
      `Reagiere: ${REACTION_APPROVE} = Approve &nbsp; ${REACTION_REJECT} = Reject`,
  };
}

export function formatApprovalDecided(
  approval: Record<string, unknown>,
  decision: string,
  decidedBy: string,
): Formatted {
  const issueId = approval.issueIdentifier ?? approval.issueId ?? "?";
  const emoji = decision === "approved" ? "\u2705" : "\u274C";
  const label = decision === "approved" ? "Approved" : "Rejected";

  return {
    text: `${emoji} ${issueId} — ${label} von ${decidedBy}`,
    html: `${emoji} <b>${escHtml(String(issueId))}</b> — ${label} von <b>${escHtml(decidedBy)}</b>`,
  };
}

// -- Agent Runs --

export function formatRunStarted(agent: Record<string, unknown>, issue?: Record<string, unknown>): Formatted {
  const name = agent.name ?? agent.id ?? "Agent";
  const issueId = issue?.identifier ?? "";
  const ctx = issueId ? ` an ${issueId}` : "";

  return {
    text: `🔄 ${name} arbeitet${ctx}...`,
    html: `\uD83D\uDD04 <b>${escHtml(String(name))}</b> arbeitet${ctx ? ` an <b>${escHtml(String(issueId))}</b>` : ""}...`,
  };
}

export function formatRunFinished(agent: Record<string, unknown>, issue?: Record<string, unknown>): Formatted {
  const name = agent.name ?? agent.id ?? "Agent";
  const issueId = issue?.identifier ?? "";

  return {
    text: `✅ ${name} fertig${issueId ? ` mit ${issueId}` : ""}`,
    html: `\u2705 <b>${escHtml(String(name))}</b> fertig${issueId ? ` mit <b>${escHtml(String(issueId))}</b>` : ""}`,
  };
}

export function formatRunFailed(agent: Record<string, unknown>, error?: string): Formatted {
  const name = agent.name ?? agent.id ?? "Agent";

  return {
    text: `❌ ${name} fehlgeschlagen${error ? `: ${truncate(error, 200)}` : ""}`,
    html:
      `\u274C <b>${escHtml(String(name))}</b> fehlgeschlagen` +
      (error ? `:<br/><code>${escHtml(truncate(error, 200))}</code>` : ""),
  };
}

// -- Daily Digest --

export function formatDailyDigest(
  issues: Array<Record<string, unknown>>,
  agents: Array<Record<string, unknown>>,
): Formatted {
  const openCount = issues.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
  const doneToday = issues.filter((i) => {
    if (i.status !== "done") return false;
    const updated = i.updatedAt ? new Date(String(i.updatedAt)) : null;
    if (!updated) return false;
    const today = new Date();
    return updated.toDateString() === today.toDateString();
  }).length;

  const activeAgents = agents.filter((a) => a.status === "active").length;

  const lines = [
    `📊 Daily Digest`,
    `Open Issues: ${openCount}`,
    `Done today: ${doneToday}`,
    `Active Agents: ${activeAgents}/${agents.length}`,
  ];

  return {
    text: lines.join("\n"),
    html:
      `<b>\uD83D\uDCCA Daily Digest</b><br/>` +
      `Open Issues: <b>${openCount}</b><br/>` +
      `Done today: <b>${doneToday}</b><br/>` +
      `Active Agents: <b>${activeAgents}/${agents.length}</b>`,
  };
}

// -- Command Responses --

export function formatIssueList(issues: Array<Record<string, unknown>>): Formatted {
  if (issues.length === 0) {
    return { text: "Keine offenen Issues.", html: "<i>Keine offenen Issues.</i>" };
  }

  const lines = issues.slice(0, 20).map((i) => {
    const id = i.identifier ?? i.id ?? "?";
    const title = truncate(String(i.title ?? ""), 60);
    const status = i.status ?? "?";
    return `• ${id} [${status}]: ${title}`;
  });

  const htmlLines = issues.slice(0, 20).map((i) => {
    const id = i.identifier ?? i.id ?? "?";
    const title = truncate(String(i.title ?? ""), 60);
    const status = i.status ?? "?";
    return `<li><b>${escHtml(String(id))}</b> [${escHtml(String(status))}]: ${escHtml(title)}</li>`;
  });

  return {
    text: lines.join("\n"),
    html: `<ul>${htmlLines.join("")}</ul>`,
  };
}

export function formatAgentList(agents: Array<Record<string, unknown>>): Formatted {
  if (agents.length === 0) {
    return { text: "Keine Agents konfiguriert.", html: "<i>Keine Agents konfiguriert.</i>" };
  }

  const lines = agents.map((a) => {
    const name = a.name ?? a.id ?? "?";
    const role = a.role ?? "";
    const status = a.status ?? "?";
    return `• ${name} [${status}]${role ? ` — ${role}` : ""}`;
  });

  const htmlLines = agents.map((a) => {
    const name = a.name ?? a.id ?? "?";
    const role = a.role ?? "";
    const status = a.status ?? "?";
    return `<li><b>${escHtml(String(name))}</b> [${escHtml(String(status))}]${role ? ` — ${escHtml(String(role))}` : ""}</li>`;
  });

  return {
    text: lines.join("\n"),
    html: `<ul>${htmlLines.join("")}</ul>`,
  };
}

export function formatHelp(): Formatted {
  const cmds = [
    `!clip issue "Titel" — Neues Issue erstellen`,
    `!clip status — Offene Issues listen`,
    `!clip agents — Verfügbare Agents listen`,
    `!clip assign ISSUE-ID AGENT — Issue an Agent zuweisen`,
    `!clip comment ISSUE-ID "Text" — Kommentar auf Issue`,
    `!clip approve ISSUE-ID — Approval erteilen`,
    `!clip reject ISSUE-ID "Grund" — Approval ablehnen`,
    `!clip help — Diese Hilfe`,
  ];

  return {
    text: cmds.join("\n"),
    html: `<b>Verfügbare Befehle:</b><br/><code>${cmds.map(escHtml).join("<br/>")}</code>`,
  };
}

// -- Helpers --

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function markdownToHtml(md: string): string {
  // Very basic markdown → HTML for common patterns
  return escHtml(md)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br/>");
}
