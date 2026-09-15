import type { AgentTaskItem, AgentTimelineItem } from "../agent-sdk-types.js";

const DEFAULT_MAX_ERRORS = 3;

/**
 * What a handoff brief can state as observed, drawn from the source agent's own
 * timeline. Nothing here is summarized or inferred — a successor can be told to
 * trust it without re-deriving it.
 */
export interface HandoffTimelineFacts {
  /** The first thing the user asked for, verbatim. */
  objective: string | null;
  /** The source agent's task list as it last stood. */
  tasks: readonly AgentTaskItem[];
  recentErrors: readonly string[];
  lastAssistantMessage: string | null;
}

function nonBlank(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractHandoffTimelineFacts(
  timeline: readonly AgentTimelineItem[],
  options?: { maxErrors?: number },
): HandoffTimelineFacts {
  const maxErrors = options?.maxErrors ?? DEFAULT_MAX_ERRORS;

  let objective: string | null = null;
  let tasks: readonly AgentTaskItem[] = [];
  let lastAssistantMessage: string | null = null;
  const errors: string[] = [];

  for (const item of timeline) {
    switch (item.type) {
      case "user_message":
        objective ??= nonBlank(item.text);
        break;
      case "assistant_message":
        lastAssistantMessage = nonBlank(item.text) ?? lastAssistantMessage;
        break;
      case "todo":
        tasks = item.items;
        break;
      case "error": {
        const message = nonBlank(item.message);
        if (message) {
          errors.push(message);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    objective,
    tasks,
    recentErrors: maxErrors > 0 ? errors.slice(-maxErrors) : [],
    lastAssistantMessage,
  };
}

const DEFAULT_DIGEST_MAX_CHARS = 12_000;
const MAX_DIGEST_LINE_CHARS = 400;

/**
 * A bounded, output-free rendering of the conversation, for a summarizer model to
 * read. Tool results are the bulk of a timeline and the least useful part of a
 * narrative — git already reports what actually changed — so only the tool name
 * survives. The tail is kept rather than the head: the end of a session is where
 * its unfinished work is.
 */
export function renderTimelineDigest(
  timeline: readonly AgentTimelineItem[],
  options?: { maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? DEFAULT_DIGEST_MAX_CHARS;
  const lines: string[] = [];

  for (const item of timeline) {
    const line = digestLine(item);
    if (line) {
      lines.push(line.slice(0, MAX_DIGEST_LINE_CHARS));
    }
  }

  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      break;
    }
    used += cost;
    kept.unshift(line);
  }

  return kept.join("\n");
}

function digestLine(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
      return prefixed("user", item.text);
    case "assistant_message":
      return prefixed("assistant", item.text);
    case "tool_call":
      return prefixed("tool", item.name);
    case "error":
      return prefixed("error", item.message);
    default:
      return null;
  }
}

function prefixed(label: string, text: string): string | null {
  const value = nonBlank(text);
  return value ? `${label}: ${value.replace(/\s+/g, " ")}` : null;
}
