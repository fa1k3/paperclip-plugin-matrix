import { describe, it, expect } from "vitest";
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
} from "../src/format.js";

describe("formatIssueCreated", () => {
  it("formats issue with identifier and title", () => {
    const result = formatIssueCreated({ identifier: "KAR-42", title: "Landing Page" });
    expect(result.text).toContain("KAR-42");
    expect(result.text).toContain("Landing Page");
    expect(result.html).toContain("KAR-42");
    expect(result.html).toContain("Landing Page");
  });

  it("uses id as fallback when no identifier", () => {
    const result = formatIssueCreated({ id: "abc-123", title: "Test" });
    expect(result.text).toContain("abc-123");
  });

  it("shows priority when present", () => {
    const result = formatIssueCreated({ identifier: "X-1", title: "T", priority: "high" });
    expect(result.text).toContain("high");
  });

  it("shows assignee status", () => {
    const assigned = formatIssueCreated({ identifier: "X-1", title: "T", assigneeAgentId: "ada" });
    expect(assigned.text).toContain("Assigned");

    const unassigned = formatIssueCreated({ identifier: "X-1", title: "T" });
    expect(unassigned.text).toContain("Unassigned");
  });

  it("truncates long descriptions", () => {
    const longDesc = "A".repeat(500);
    const result = formatIssueCreated({ identifier: "X-1", title: "T", description: longDesc });
    expect(result.text.length).toBeLessThan(500);
    expect(result.text).toContain("...");
  });

  it("escapes HTML in title", () => {
    const result = formatIssueCreated({ identifier: "X-1", title: '<script>alert("xss")</script>' });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});

describe("formatIssueDone", () => {
  it("formats done issue", () => {
    const result = formatIssueDone({ identifier: "KAR-42", title: "Done task" });
    expect(result.text).toContain("KAR-42");
    expect(result.text).toContain("done");
  });

  it("works without title", () => {
    const result = formatIssueDone({ identifier: "KAR-42" });
    expect(result.text).toContain("KAR-42");
    expect(result.text).toContain("done");
  });
});

describe("formatComment", () => {
  it("formats comment with agent name", () => {
    const result = formatComment({ identifier: "KAR-42" }, { body: "Updated code" }, "Ada");
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("KAR-42");
    expect(result.text).toContain("Updated code");
  });

  it("falls back to Unknown when no agent name", () => {
    const result = formatComment({ identifier: "KAR-42" }, { body: "text" });
    expect(result.text).toContain("Unknown");
  });

  it("truncates long comment body", () => {
    const longBody = "B".repeat(600);
    const result = formatComment({ identifier: "X-1" }, { body: longBody });
    expect(result.text.length).toBeLessThan(600);
  });
});

describe("formatApprovalRequest", () => {
  it("includes issue ID and reaction instructions", () => {
    const result = formatApprovalRequest({
      issueIdentifier: "KAR-42",
      title: "Deploy to prod",
      agentName: "Ada",
    });
    expect(result.text).toContain("KAR-42");
    expect(result.text).toContain("Deploy to prod");
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("Approve");
    expect(result.text).toContain("Reject");
  });
});

describe("formatApprovalDecided", () => {
  it("formats approved decision", () => {
    const result = formatApprovalDecided({ issueIdentifier: "KAR-42" }, "approved", "karin");
    expect(result.text).toContain("Approved");
    expect(result.text).toContain("karin");
  });

  it("formats rejected decision", () => {
    const result = formatApprovalDecided({ issueIdentifier: "KAR-42" }, "rejected", "tom");
    expect(result.text).toContain("Rejected");
    expect(result.text).toContain("tom");
  });
});

describe("formatRunStarted", () => {
  it("shows agent working on issue", () => {
    const result = formatRunStarted({ name: "Ada" }, { identifier: "KAR-42" });
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("KAR-42");
  });

  it("works without issue", () => {
    const result = formatRunStarted({ name: "Ada" });
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("arbeitet");
  });
});

describe("formatRunFinished", () => {
  it("shows agent finished", () => {
    const result = formatRunFinished({ name: "Ada" }, { identifier: "KAR-42" });
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("fertig");
    expect(result.text).toContain("KAR-42");
  });
});

describe("formatRunFailed", () => {
  it("shows error message", () => {
    const result = formatRunFailed({ name: "Ada" }, "Connection timeout");
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("fehlgeschlagen");
    expect(result.text).toContain("Connection timeout");
  });

  it("truncates long error", () => {
    const longError = "E".repeat(300);
    const result = formatRunFailed({ name: "Ada" }, longError);
    expect(result.text).toContain("...");
  });

  it("works without error", () => {
    const result = formatRunFailed({ name: "Ada" });
    expect(result.text).toContain("fehlgeschlagen");
  });
});

describe("formatDailyDigest", () => {
  it("counts open issues and done today", () => {
    const today = new Date().toISOString();
    const issues = [
      { status: "in_progress", updatedAt: today },
      { status: "done", updatedAt: today },
      { status: "cancelled", updatedAt: today },
    ];
    const agents = [
      { status: "active" },
      { status: "idle" },
    ];
    const result = formatDailyDigest(issues, agents);
    expect(result.text).toContain("Open Issues: 1");
    expect(result.text).toContain("Done today: 1");
    expect(result.text).toContain("Active Agents: 1/2");
  });

  it("handles empty lists", () => {
    const result = formatDailyDigest([], []);
    expect(result.text).toContain("Open Issues: 0");
    expect(result.text).toContain("Active Agents: 0/0");
  });
});

describe("formatIssueList", () => {
  it("returns empty message for no issues", () => {
    const result = formatIssueList([]);
    expect(result.text).toContain("Keine offenen Issues");
  });

  it("lists issues with identifier and status", () => {
    const issues = [
      { identifier: "KAR-1", title: "First", status: "todo" },
      { identifier: "KAR-2", title: "Second", status: "in_progress" },
    ];
    const result = formatIssueList(issues);
    expect(result.text).toContain("KAR-1");
    expect(result.text).toContain("KAR-2");
    expect(result.text).toContain("todo");
    expect(result.text).toContain("in_progress");
  });

  it("caps at 20 issues", () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({
      identifier: `X-${i}`, title: `Issue ${i}`, status: "todo",
    }));
    const result = formatIssueList(issues);
    expect(result.text).toContain("X-0");
    expect(result.text).toContain("X-19");
    expect(result.text).not.toContain("X-20");
  });
});

describe("formatAgentList", () => {
  it("returns empty message for no agents", () => {
    const result = formatAgentList([]);
    expect(result.text).toContain("Keine Agents");
  });

  it("lists agents with name, status, and role", () => {
    const agents = [
      { name: "Ada", status: "active", role: "Developer" },
      { name: "Jarvis", status: "idle" },
    ];
    const result = formatAgentList(agents);
    expect(result.text).toContain("Ada");
    expect(result.text).toContain("active");
    expect(result.text).toContain("Developer");
    expect(result.text).toContain("Jarvis");
  });
});

describe("formatHelp", () => {
  it("lists all commands", () => {
    const result = formatHelp();
    expect(result.text).toContain("!clip issue");
    expect(result.text).toContain("!clip status");
    expect(result.text).toContain("!clip agents");
    expect(result.text).toContain("!clip assign");
    expect(result.text).toContain("!clip comment");
    expect(result.text).toContain("!clip approve");
    expect(result.text).toContain("!clip reject");
    expect(result.text).toContain("!clip help");
  });
});
