import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent, PluginEventType } from "@paperclipai/plugin-sdk";
import { MatrixClient } from "./matrix.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatComment,
  formatApprovalRequest,
  formatApprovalDecided,
  formatRunStarted,
  formatRunFinished,
  formatRunFailed,
  formatDailyDigest,
  formatIssueList,
  formatAgentList,
  formatHelp,
} from "./format.js";
import type {
  PluginConfig,
  RoomMapping,
  ThreadMapping,
  ApprovalMapping,
  MessageMapping,
} from "./types.js";
import {
  REACTION_APPROVE,
  REACTION_REJECT,
  REACTION_CONFIRMED,
  REACTION_EYES,
  COMMAND_PREFIX,
} from "./types.js";
import { isLocalhostUrl, isValidUuid, resolveRoom, sanitizeDisplayName } from "./routing.js";

// ============================================================
// Echo loop prevention — track comment IDs we created from Matrix
// ============================================================

const matrixOriginatedCommentIds = new Set<string>();

// ============================================================
// State helpers
// ============================================================

async function getThreadMapping(ctx: PluginContext, issueId: string): Promise<ThreadMapping | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `thread:${issueId}` })) as ThreadMapping | null;
}

async function setThreadMapping(ctx: PluginContext, issueId: string, mapping: ThreadMapping): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `thread:${issueId}` }, mapping);
}

async function setApprovalMapping(ctx: PluginContext, eventId: string, mapping: ApprovalMapping): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `approval:${eventId}` }, mapping);
}

async function getApprovalMapping(ctx: PluginContext, eventId: string): Promise<ApprovalMapping | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `approval:${eventId}` })) as ApprovalMapping | null;
}

async function setMessageMapping(
  ctx: PluginContext,
  roomId: string,
  eventId: string,
  mapping: MessageMapping,
): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `msg:${roomId}:${eventId}` }, mapping);
}

async function getMessageMapping(
  ctx: PluginContext,
  roomId: string,
  eventId: string,
): Promise<MessageMapping | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `msg:${roomId}:${eventId}`,
  })) as MessageMapping | null;
}

// ============================================================
// Outbound: Paperclip events → Matrix messages
// ============================================================

async function postToMatrix(
  matrix: MatrixClient,
  ctx: PluginContext,
  config: PluginConfig,
  content: { text: string; html: string },
  issueId?: string,
  routingHint?: { companyId?: string; projectId?: string },
): Promise<{ eventId: string; roomId: string }> {
  // 1. Existing thread? Use its room.
  if (config.enableThreads && issueId) {
    const thread = await getThreadMapping(ctx, issueId);
    if (thread) {
      const res = await matrix.sendThreadNotice(thread.roomId, thread.eventId, content.text, content.html);
      return { eventId: res.event_id, roomId: thread.roomId };
    }
  }

  // 2. No thread — resolve room via mapping
  const roomId = resolveRoom(config, routingHint?.companyId, routingHint?.projectId);
  const res = await matrix.sendNotice(roomId, content.text, content.html);
  return { eventId: res.event_id, roomId };
}

function setupOutboundHandlers(ctx: PluginContext, matrix: MatrixClient, config: PluginConfig): void {
  const safeOn = (eventName: PluginEventType, handler: (event: PluginEvent) => Promise<void>) => {
    ctx.events.on(eventName, async (event: PluginEvent) => {
      try {
        await handler(event);
      } catch (err) {
        ctx.logger.error(`Outbound handler failed: ${eventName}`, { error: String(err) });
      }
    });
  };

  // -- Issue Created --
  safeOn("issue.created", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    if (config.projectId && payload.projectId !== config.projectId) return;

    const formatted = formatIssueCreated(payload);
    const companyId = String(payload.companyId ?? config.companyId);
    const projectId = payload.projectId ? String(payload.projectId) : config.projectId;
    const { eventId, roomId } = await postToMatrix(matrix, ctx, config, formatted, undefined, { companyId, projectId });

    const issueId = String(payload.id ?? payload.issueId ?? "");
    if (issueId && config.enableThreads) {
      await setThreadMapping(ctx, issueId, { roomId, eventId });
    }
    if (issueId) {
      await setMessageMapping(ctx, roomId, eventId, { issueId, type: "issue" });
    }

    ctx.logger.info("Posted issue.created to Matrix", { issueId, eventId, roomId });
  });

  // -- Issue Updated (done) --
  safeOn("issue.updated", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.status !== "done") return;
    if (config.projectId && payload.projectId !== config.projectId) return;

    const formatted = formatIssueDone(payload);
    const issueId = String(payload.id ?? payload.issueId ?? "");
    const companyId = String(payload.companyId ?? config.companyId);
    const projectId = payload.projectId ? String(payload.projectId) : config.projectId;
    await postToMatrix(matrix, ctx, config, formatted, issueId, { companyId, projectId });

    ctx.logger.info("Posted issue.done to Matrix", { issueId });
  });

  // -- Comment Created --
  safeOn("issue.comment.created", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const issueId = String(payload.issueId ?? "");

    // Skip comments routed from Matrix (avoid echo loop)
    const commentId = String(payload.id ?? "");
    if (commentId && matrixOriginatedCommentIds.has(commentId)) {
      matrixOriginatedCommentIds.delete(commentId);
      return;
    }

    const issue = issueId ? await ctx.issues.get(issueId, config.companyId).catch(() => null) : null;
    const issueData = (issue ?? { identifier: issueId }) as Record<string, unknown>;

    let agentName: string | undefined;
    const agentId = payload.authorAgentId ? String(payload.authorAgentId) : undefined;
    if (agentId) {
      const agent = await ctx.agents.get(agentId, config.companyId).catch(() => null);
      agentName = agent ? String((agent as unknown as Record<string, unknown>).name ?? agentId) : agentId;
    }

    const formatted = formatComment(issueData, payload, agentName);
    const { eventId, roomId } = await postToMatrix(matrix, ctx, config, formatted, issueId);

    if (issueId) {
      await setMessageMapping(ctx, roomId, eventId, {
        issueId,
        commentId: String(payload.id ?? ""),
        type: "comment",
      });
    }
  });

  // -- Approval Created --
  safeOn("approval.created", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const issueId = String(payload.issueId ?? "");

    const formatted = formatApprovalRequest(payload);
    const { eventId } = await postToMatrix(matrix, ctx, config, formatted, issueId);

    if (config.enableReactionApprovals) {
      const approvalId = String(payload.id ?? payload.approvalId ?? "");
      if (approvalId) {
        await setApprovalMapping(ctx, eventId, {
          approvalId,
          issueId,
          companyId: config.companyId,
        });
      }
    }

    ctx.logger.info("Posted approval request to Matrix", { issueId, eventId });
  });

  // -- Approval Decided --
  safeOn("approval.decided", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const decision = String(payload.decision ?? "unknown");
    const decidedBy = String(payload.decidedBy ?? payload.decidedByUserId ?? "unknown");
    const issueId = String(payload.issueId ?? "");

    const formatted = formatApprovalDecided(payload, decision, decidedBy);
    await postToMatrix(matrix, ctx, config, formatted, issueId);
  });

  // -- Agent Run Started --
  safeOn("agent.run.started", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const agentId = String(payload.agentId ?? "");
    const issueId = String(payload.issueId ?? payload.taskId ?? "");

    const agent = agentId
      ? await ctx.agents.get(agentId, config.companyId).catch(() => null)
      : null;
    const agentData = (agent ?? { name: agentId }) as Record<string, unknown>;

    if (issueId) {
      const thread = await getThreadMapping(ctx, issueId);
      if (thread) matrix.setTyping(thread.roomId, true).catch(() => {});
    }

    const formatted = formatRunStarted(agentData, issueId ? { identifier: issueId } : undefined);
    await postToMatrix(matrix, ctx, config, formatted, issueId);
  });

  // -- Agent Run Finished --
  safeOn("agent.run.finished", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const agentId = String(payload.agentId ?? "");
    const issueId = String(payload.issueId ?? payload.taskId ?? "");

    const agent = agentId
      ? await ctx.agents.get(agentId, config.companyId).catch(() => null)
      : null;
    const agentData = (agent ?? { name: agentId }) as Record<string, unknown>;

    if (issueId) {
      const thread = await getThreadMapping(ctx, issueId);
      if (thread) matrix.setTyping(thread.roomId, false).catch(() => {});
    }

    const formatted = formatRunFinished(agentData, issueId ? { identifier: issueId } : undefined);
    await postToMatrix(matrix, ctx, config, formatted, issueId);
  });

  // -- Agent Run Failed --
  safeOn("agent.run.failed", async (event: PluginEvent) => {
    const payload = event.payload as Record<string, unknown>;
    const agentId = String(payload.agentId ?? "");
    const error = payload.error ? String(payload.error) : undefined;
    const issueId = String(payload.issueId ?? payload.taskId ?? "");

    const agent = agentId
      ? await ctx.agents.get(agentId, config.companyId).catch(() => null)
      : null;
    const agentData = (agent ?? { name: agentId }) as Record<string, unknown>;

    if (issueId) {
      const thread = await getThreadMapping(ctx, issueId);
      if (thread) matrix.setTyping(thread.roomId, false).catch(() => {});
    }

    const formatted = formatRunFailed(agentData, error);
    await postToMatrix(matrix, ctx, config, formatted, issueId);
  });
}

// ============================================================
// Inbound: Matrix events → Paperclip actions
// ============================================================

function setupInboundHandlers(ctx: PluginContext, matrix: MatrixClient, config: PluginConfig): void {
  // -- Messages (m.room.message) --
  matrix.onMessage((roomId: string, event: Record<string, unknown>) => {
    // Ignore own messages
    if (event.sender === config.matrixBotUserId) return;
    // Ignore non-text
    const content = event.content as Record<string, unknown> | undefined;
    if (!content || content.msgtype !== "m.text") return;

    const body = String(content.body ?? "").trim();
    if (!body) return;

    const eventId = String(event.event_id ?? "");

    // Read receipt
    matrix.sendReadReceipt(roomId, eventId).catch(() => {});

    // Command?
    if (body.startsWith(COMMAND_PREFIX)) {
      handleCommand(ctx, matrix, config, roomId, event, body).catch((err) =>
        ctx.logger.error("Command handler error", { error: String(err) }),
      );
      return;
    }

    // Reply routing → Paperclip comment
    handleReplyRouting(ctx, matrix, config, roomId, event, body).catch((err) =>
      ctx.logger.error("Reply routing error", { error: String(err) }),
    );
  });

  // -- Reactions (m.reaction) --
  matrix.onEvent((roomId: string, event: Record<string, unknown>) => {
    if (event.type !== "m.reaction") return;
    if (event.sender === config.matrixBotUserId) return;
    if (!config.enableReactionApprovals) return;

    handleReaction(ctx, matrix, config, roomId, event).catch((err) =>
      ctx.logger.error("Reaction handler error", { error: String(err) }),
    );
  });
}

async function handleReplyRouting(
  ctx: PluginContext,
  matrix: MatrixClient,
  config: PluginConfig,
  roomId: string,
  event: Record<string, unknown>,
  body: string,
): Promise<void> {
  const content = event.content as Record<string, unknown>;
  const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
  const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
  const replyToEventId = inReplyTo?.event_id as string | undefined;
  const threadEventId =
    relatesTo?.rel_type === "m.thread" ? String(relatesTo.event_id ?? "") : undefined;

  // Direct reply to a bot message
  if (replyToEventId) {
    const mapping = await getMessageMapping(ctx, roomId, replyToEventId);
    if (mapping?.issueId) {
      await routeAsComment(ctx, config, mapping.issueId, body, String(event.sender ?? ""));
      await matrix.sendReaction(roomId, String(event.event_id ?? ""), REACTION_EYES);
      return;
    }
  }

  // Message in a known thread
  if (threadEventId) {
    const mapping = await getMessageMapping(ctx, roomId, threadEventId);
    if (mapping?.issueId) {
      await routeAsComment(ctx, config, mapping.issueId, body, String(event.sender ?? ""));
      await matrix.sendReaction(roomId, String(event.event_id ?? ""), REACTION_EYES);
      return;
    }
  }
}

async function routeAsComment(
  ctx: PluginContext,
  config: PluginConfig,
  issueId: string,
  body: string,
  matrixSender: string,
): Promise<void> {
  const rawName = matrixSender.replace(/^@/, "").replace(/:.*$/, "");
  const displayName = sanitizeDisplayName(rawName);
  const commentBody = `**${displayName}** (via Matrix):\n${body}`;

  const comment = await ctx.issues.createComment(issueId, commentBody, config.companyId);
  const commentData = comment as unknown as Record<string, unknown>;
  const commentId = String(commentData.id ?? "");
  if (commentId) {
    matrixOriginatedCommentIds.add(commentId);
    // Prevent unbounded growth — remove after 60s (event should have arrived by then)
    setTimeout(() => matrixOriginatedCommentIds.delete(commentId), 60_000);
  }
  ctx.logger.info("Routed Matrix reply as Paperclip comment", { issueId, commentId, sender: matrixSender });
}

async function handleReaction(
  ctx: PluginContext,
  matrix: MatrixClient,
  config: PluginConfig,
  roomId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const content = event.content as Record<string, unknown>;
  const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
  if (!relatesTo || relatesTo.rel_type !== "m.annotation") return;

  const targetEventId = String(relatesTo.event_id ?? "");
  const key = String(relatesTo.key ?? "");

  if (key !== REACTION_APPROVE && key !== REACTION_REJECT) return;

  const approvalMapping = await getApprovalMapping(ctx, targetEventId);
  if (!approvalMapping) return;

  const sender = String(event.sender ?? "");

  // Check power level
  try {
    const powerLevels = await matrix.getPowerLevels(roomId);
    const userLevel = matrix.getUserPowerLevel(powerLevels, sender);
    if (userLevel < config.approvalMinPowerLevel) {
      ctx.logger.warn("User lacks power level for approval", {
        sender,
        level: userLevel,
        required: config.approvalMinPowerLevel,
      });
      const thread = await getThreadMapping(ctx, approvalMapping.issueId);
      const msg = `\u26A0\uFE0F ${sender} hat nicht genug Rechte (Level ${userLevel}, braucht ${config.approvalMinPowerLevel})`;
      if (thread) {
        await matrix.sendThreadNotice(roomId, thread.eventId, msg);
      } else {
        await matrix.sendNotice(roomId, msg);
      }
      return;
    }
  } catch {
    ctx.logger.warn("Could not check power levels, allowing approval");
  }

  // Execute approval decision
  const decision = key === REACTION_APPROVE ? "approved" : "rejected";
  const displayName = sanitizeDisplayName(sender.replace(/^@/, "").replace(/:.*$/, ""));

  if (!isValidUuid(approvalMapping.approvalId)) {
    ctx.logger.error("Invalid approvalId format, rejecting", { approvalId: approvalMapping.approvalId });
    return;
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.paperclipApiToken) {
      headers["Authorization"] = `Bearer ${config.paperclipApiToken}`;
    }

    const res = await fetch(`${config.paperclipApiUrl}/approvals/${approvalMapping.approvalId}/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        decision,
        note: `${decision} by ${displayName} via Matrix reaction`,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text}`);
    }

    await matrix.sendReaction(roomId, targetEventId, REACTION_CONFIRMED);

    ctx.logger.info("Processed approval via reaction", {
      approvalId: approvalMapping.approvalId,
      decision,
      sender,
    });
  } catch (err) {
    ctx.logger.error("Failed to process approval decision", { error: String(err) });
    await matrix.sendNotice(roomId, `\u274C Approval fehlgeschlagen: ${String(err)}`);
  }
}

// ============================================================
// Issue lookup helper
// ============================================================

async function findIssueByIdentifier(
  ctx: PluginContext,
  companyId: string,
  identifier: string,
  projectId?: string,
): Promise<Record<string, unknown> | null> {
  // Fast path: try direct get (works if identifier is actually an ID)
  try {
    const issue = await ctx.issues.get(identifier, companyId);
    if (issue) return issue as unknown as Record<string, unknown>;
  } catch {
    // Not a direct ID, try list+filter
  }

  // Slow path: search by identifier in list
  const issues = await ctx.issues.list({ companyId, projectId, limit: 100 });
  return (issues as unknown as Array<Record<string, unknown>>).find(
    (i) => i.identifier === identifier,
  ) ?? null;
}

// ============================================================
// Commands
// ============================================================

async function handleCommand(
  ctx: PluginContext,
  matrix: MatrixClient,
  config: PluginConfig,
  roomId: string,
  event: Record<string, unknown>,
  body: string,
): Promise<void> {
  const parts = body.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);

  const content = event.content as Record<string, unknown>;
  const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
  const threadEventId =
    relatesTo?.rel_type === "m.thread" ? String(relatesTo.event_id ?? "") : undefined;

  const reply = async (text: string, html?: string) => {
    if (threadEventId) {
      await matrix.sendThreadNotice(roomId, threadEventId, text, html);
    } else {
      await matrix.sendNotice(roomId, text, html);
    }
  };

  try {
    switch (command) {
      case "issue": {
        const title = args.join(" ").replace(/^["']|["']$/g, "");
        if (!title) {
          await reply('Usage: !clip issue "Titel des Issues"');
          return;
        }
        const issue = await ctx.issues.create({
          companyId: config.companyId,
          projectId: config.projectId,
          title,
        });
        const issueData = issue as unknown as Record<string, unknown>;
        const id = issueData.identifier ?? issueData.id ?? "?";

        if (issueData.id) {
          await ctx.issues.update(String(issueData.id), { status: "todo" }, config.companyId);
        }

        await reply(`\u2705 Issue ${id} erstellt: "${title}"`);
        ctx.logger.info("Created issue via Matrix command", { issueId: String(id) });
        break;
      }

      case "status": {
        const issues = await ctx.issues.list({
          companyId: config.companyId,
          projectId: config.projectId,
          limit: 20,
        });
        const openIssues = (issues as unknown as Array<Record<string, unknown>>).filter(
          (i) => i.status !== "done" && i.status !== "cancelled",
        );
        const formatted = formatIssueList(openIssues);
        await reply(formatted.text, formatted.html);
        break;
      }

      case "agents": {
        const agents = await ctx.agents.list({ companyId: config.companyId, limit: 50 });
        const formatted = formatAgentList(agents as unknown as Array<Record<string, unknown>>);
        await reply(formatted.text, formatted.html);
        break;
      }

      case "approve":
      case "reject": {
        const issueIdentifier = args[0];
        if (!issueIdentifier) {
          await reply(`Usage: !clip ${command} ISSUE-ID`);
          return;
        }
        const reason = command === "reject" ? args.slice(1).join(" ").replace(/^["']|["']$/g, "") : undefined;
        const decision = command === "approve" ? "approved" : "rejected";
        const sender = String(event.sender ?? "");

        // Check power level
        const powerLevels = await matrix.getPowerLevels(roomId);
        const userLevel = matrix.getUserPowerLevel(powerLevels, sender);
        if (userLevel < config.approvalMinPowerLevel) {
          await reply(`\u26A0\uFE0F Nicht genug Rechte (Level ${userLevel}, braucht ${config.approvalMinPowerLevel})`);
          return;
        }

        // Find issue by identifier
        const targetIssue = await findIssueByIdentifier(ctx, config.companyId, issueIdentifier, config.projectId);
        if (!targetIssue) {
          await reply(`\u274C Issue ${issueIdentifier} nicht gefunden`);
          return;
        }

        // Find approval mapping for this issue
        const targetIssueId = String(targetIssue.id ?? "");
        const thread = await getThreadMapping(ctx, targetIssueId);
        if (!thread) {
          await reply(`\u274C Kein Approval-Request fuer ${issueIdentifier} gefunden`);
          return;
        }

        // Try to find the approval via the Paperclip API
        const displayName = sanitizeDisplayName(sender.replace(/^@/, "").replace(/:.*$/, ""));
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.paperclipApiToken) {
          headers["Authorization"] = `Bearer ${config.paperclipApiToken}`;
        }

        // List pending approvals for this issue
        const approvalRes = await fetch(`${config.paperclipApiUrl}/issues/${targetIssueId}/approvals?status=pending`, {
          headers,
        });
        if (!approvalRes.ok) {
          await reply(`\u274C Konnte Approvals nicht laden: ${approvalRes.status}`);
          return;
        }
        const approvals = (await approvalRes.json()) as Array<Record<string, unknown>>;
        if (approvals.length === 0) {
          await reply(`\u2139\uFE0F Keine offenen Approvals fuer ${issueIdentifier}`);
          return;
        }

        // Approve/reject the first pending approval
        const approvalId = String(approvals[0].id ?? "");
        if (!isValidUuid(approvalId)) {
          await reply(`\u274C Ungueltige Approval-ID vom Server: ${approvalId}`);
          return;
        }
        const decisionRes = await fetch(`${config.paperclipApiUrl}/approvals/${approvalId}/decision`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            decision,
            note: `${decision} by ${displayName} via !clip ${command}${reason ? `: ${reason}` : ""}`,
          }),
        });
        if (!decisionRes.ok) {
          const text = await decisionRes.text().catch(() => "");
          throw new Error(`${decisionRes.status} ${text}`);
        }

        const emoji = decision === "approved" ? "\u2705" : "\u274C";
        await reply(`${emoji} ${issueIdentifier} ${decision} von ${displayName}${reason ? ` (${reason})` : ""}`);
        ctx.logger.info("Processed approval via command", { issueId: targetIssueId, decision, sender });
        break;
      }

      case "assign": {
        const issueIdentifier = args[0];
        const agentQuery = args[1];
        if (!issueIdentifier || !agentQuery) {
          await reply("Usage: !clip assign ISSUE-ID AGENT-NAME");
          return;
        }

        // Find agent by name
        const allAgents = await ctx.agents.list({ companyId: config.companyId, limit: 50 });
        const agentsList = allAgents as unknown as Array<Record<string, unknown>>;
        const matchedAgent = agentsList.find(
          (a) => String(a.name ?? "").toLowerCase() === agentQuery.toLowerCase()
            || String(a.id ?? "") === agentQuery,
        );
        if (!matchedAgent) {
          const names = agentsList.map((a) => a.name ?? a.id).join(", ");
          await reply(`\u274C Agent "${agentQuery}" nicht gefunden. Verfuegbar: ${names}`);
          return;
        }

        // Find issue
        const issueForAssign = await findIssueByIdentifier(ctx, config.companyId, issueIdentifier, config.projectId);
        if (!issueForAssign) {
          await reply(`\u274C Issue ${issueIdentifier} nicht gefunden`);
          return;
        }

        const agentId = String(matchedAgent.id ?? "");
        const issueId = String(issueForAssign.id ?? "");
        await ctx.agents.invoke(agentId, config.companyId, {
          prompt: `Work on issue ${issueIdentifier} (ID: ${issueId})`,
          reason: `Assigned via Matrix by ${String(event.sender ?? "")}`,
        });

        await reply(`\u2705 ${matchedAgent.name} wurde ${issueIdentifier} zugewiesen`);
        ctx.logger.info("Assigned agent via command", { issueId, agentId, agent: matchedAgent.name });
        break;
      }

      case "comment": {
        const issueIdentifier = args[0];
        if (!issueIdentifier || args.length < 2) {
          await reply('Usage: !clip comment ISSUE-ID "Kommentar-Text"');
          return;
        }
        const commentText = args.slice(1).join(" ").replace(/^["']|["']$/g, "");
        if (!commentText) {
          await reply('Usage: !clip comment ISSUE-ID "Kommentar-Text"');
          return;
        }

        // Find issue
        const issueForComment = await findIssueByIdentifier(ctx, config.companyId, issueIdentifier, config.projectId);
        if (!issueForComment) {
          await reply(`\u274C Issue ${issueIdentifier} nicht gefunden`);
          return;
        }

        const sender = String(event.sender ?? "");
        const displayName = sanitizeDisplayName(sender.replace(/^@/, "").replace(/:.*$/, ""));
        const issueId = String(issueForComment.id ?? "");

        const comment = await ctx.issues.createComment(issueId, `**${displayName}** (via Matrix):\n${commentText}`, config.companyId);
        const commentData = comment as unknown as Record<string, unknown>;
        const commentId = String(commentData.id ?? "");
        if (commentId) {
          matrixOriginatedCommentIds.add(commentId);
          setTimeout(() => matrixOriginatedCommentIds.delete(commentId), 60_000);
        }

        await reply(`\u2705 Kommentar auf ${issueIdentifier} erstellt`);
        ctx.logger.info("Created comment via command", { issueId, sender });
        break;
      }

      case "help":
      default: {
        const formatted = formatHelp();
        await reply(formatted.text, formatted.html);
        break;
      }
    }
  } catch (err) {
    ctx.logger.error("Command failed", { command, error: String(err) });
    await reply(`\u274C Fehler: ${String(err)}`);
  }
}

// ============================================================
// Daily Digest Job
// ============================================================

function setupDigestJob(ctx: PluginContext, matrix: MatrixClient, config: PluginConfig): void {
  ctx.jobs.register("matrix-daily-digest", async () => {
    try {
      const issues = await ctx.issues.list({
        companyId: config.companyId,
        projectId: config.projectId,
        limit: 100,
      });
      const agents = await ctx.agents.list({ companyId: config.companyId, limit: 50 });

      const formatted = formatDailyDigest(
        issues as unknown as Array<Record<string, unknown>>,
        agents as unknown as Array<Record<string, unknown>>,
      );
      await matrix.sendNotice(config.defaultRoomId, formatted.text, formatted.html);

      ctx.logger.info("Daily digest sent");
    } catch (err) {
      ctx.logger.error("Daily digest failed", { error: String(err) });
    }
  });
}

// ============================================================
// Plugin Definition
// ============================================================

let matrixInstance: MatrixClient | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    // 1. Read and validate config
    const rawConfig = (await ctx.config.get()) as unknown as Record<string, unknown>;
    const config: PluginConfig = {
      matrixHomeserverUrl: String(rawConfig.matrixHomeserverUrl ?? ""),
      matrixAccessToken: String(rawConfig.matrixAccessToken ?? ""),
      matrixBotUserId: String(rawConfig.matrixBotUserId ?? ""),
      companyId: String(rawConfig.companyId ?? ""),
      projectId: rawConfig.projectId ? String(rawConfig.projectId) : undefined,
      defaultRoomId: String(rawConfig.defaultRoomId ?? ""),
      paperclipApiUrl: String(rawConfig.paperclipApiUrl ?? "http://127.0.0.1:3100/api"),
      approvalMinPowerLevel: Number(rawConfig.approvalMinPowerLevel ?? 50),
      enableThreads: rawConfig.enableThreads !== false,
      enableReactionApprovals: rawConfig.enableReactionApprovals !== false,
      enableEncryption: rawConfig.enableEncryption !== false,
      paperclipApiToken: String(rawConfig.paperclipApiToken ?? ""),
      roomMappings: Array.isArray(rawConfig.roomMappings)
        ? (rawConfig.roomMappings as Array<Record<string, unknown>>).map((m) => ({
            roomId: String(m.roomId ?? ""),
            companyId: String(m.companyId ?? ""),
            projectId: m.projectId ? String(m.projectId) : undefined,
          })).filter((m) => m.roomId && m.companyId)
        : [],
    };

    // Resolve secret references
    if (config.matrixAccessToken && !config.matrixAccessToken.startsWith("syt_")) {
      try {
        config.matrixAccessToken = await ctx.secrets.resolve(config.matrixAccessToken);
      } catch {
        // Not a secret ref, use as-is
      }
    }
    if (config.paperclipApiToken) {
      try {
        config.paperclipApiToken = await ctx.secrets.resolve(config.paperclipApiToken);
      } catch {
        // Not a secret ref, use as-is
      }
    }

    if (!config.matrixHomeserverUrl || !config.matrixAccessToken || !config.matrixBotUserId) {
      ctx.logger.warn("Matrix plugin not configured — homeserverUrl, accessToken, and botUserId required");
      return;
    }
    if (!config.companyId || !config.defaultRoomId) {
      ctx.logger.warn("Matrix plugin not configured — companyId and defaultRoomId required");
      return;
    }
    if (!isLocalhostUrl(config.paperclipApiUrl)) {
      ctx.logger.error("paperclipApiUrl must point to localhost/127.0.0.1 (SSRF protection)", {
        url: config.paperclipApiUrl,
      });
      return;
    }

    // 2. Create and initialize Matrix client (with E2E if enabled)
    const matrix = new MatrixClient(
      config.matrixHomeserverUrl,
      config.matrixAccessToken,
      config.matrixBotUserId,
      config.enableEncryption,
    );
    await matrix.init();
    matrixInstance = matrix;

    ctx.logger.info("Matrix plugin starting", {
      homeserver: config.matrixHomeserverUrl,
      botUser: config.matrixBotUserId,
      room: config.defaultRoomId,
      threads: config.enableThreads,
      reactionApprovals: config.enableReactionApprovals,
      encryption: config.enableEncryption,
    });

    // 3. Register inbound handlers BEFORE starting sync (so we don't miss events)
    setupInboundHandlers(ctx, matrix, config);

    // 4. Register outbound handlers (Paperclip events → Matrix)
    setupOutboundHandlers(ctx, matrix, config);

    // 5. Register daily digest job
    setupDigestJob(ctx, matrix, config);

    // 6. Start Matrix sync loop with auto-reconnect (non-blocking)
    //    MUST NOT be awaited in setup() — Paperclip kills worker after 15s
    matrix.startWithReconnect((err, attempt) => {
      if (attempt === -1) {
        ctx.logger.error("Matrix sync dropped, reconnecting...", { error: String(err) });
      } else {
        ctx.logger.warn("Matrix sync connect failed, retrying", { attempt, error: String(err) });
      }
    }).catch((err) =>
      ctx.logger.error("Matrix sync start failed permanently", { error: String(err) }),
    );

    // 7. Join default room + all mapped rooms
    const roomsToJoin = new Set([config.defaultRoomId, ...config.roomMappings.map((m) => m.roomId)]);
    for (const roomId of roomsToJoin) {
      matrix.joinRoom(roomId).catch(() =>
        ctx.logger.warn("Could not join room (may already be joined)", { roomId }),
      );
    }

    // 8. Cleanup on shutdown
    ctx.events.on("plugin.stopping", async () => {
      await matrix.stop();
      ctx.logger.info("Matrix plugin stopped");
    });

    // 9. Startup notice
    matrix
      .sendNotice(
        config.defaultRoomId,
        config.enableEncryption
          ? "\uD83D\uDD12 Paperclip Matrix Bridge online (E2E encrypted)"
          : "\uD83D\uDFE2 Paperclip Matrix Bridge online",
      )
      .catch(() => {});

    ctx.logger.info("Matrix plugin started successfully");
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    if (!config.matrixHomeserverUrl) errors.push("matrixHomeserverUrl is required");
    if (!config.matrixAccessToken) errors.push("matrixAccessToken is required");
    if (!config.matrixBotUserId) errors.push("matrixBotUserId is required");
    if (!config.companyId) errors.push("companyId is required");
    if (!config.defaultRoomId) errors.push("defaultRoomId is required");

    if (config.paperclipApiUrl && !isLocalhostUrl(String(config.paperclipApiUrl))) {
      errors.push("paperclipApiUrl must point to localhost/127.0.0.1");
    }

    return errors.length > 0 ? { ok: false as const, errors } : { ok: true as const };
  },

  async onHealth() {
    if (!matrixInstance) {
      return { status: "error" as const, message: "Matrix client not initialized", details: {} };
    }
    const health = matrixInstance.getHealthStatus();
    if (!health.connected) {
      return {
        status: "error" as const,
        message: health.error ? `Matrix sync disconnected: ${health.error}` : "Matrix sync not started",
        details: { lastError: health.error },
      };
    }
    return { status: "ok" as const, message: "Matrix sync connected", details: {} };
  },

  async onShutdown() {
    // Cleanup handled by plugin.stopping event
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
