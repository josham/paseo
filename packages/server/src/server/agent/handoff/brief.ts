import type { AgentTaskItem } from "../agent-sdk-types.js";
import type { HandoffTimelineFacts } from "./timeline-facts.js";

export interface HandoffChangedFile {
  path: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
}

export interface HandoffGitFacts {
  branch: string | null;
  baseRef: string | null;
  files: readonly HandoffChangedFile[];
  diffTooLarge: boolean;
}

/** One end of a handoff: the launch config an agent runs under. */
export interface HandoffEndpoint {
  provider: string;
  model: string | null;
}

export interface HandoffNarrative {
  /**
   * Which tier wrote this. `outgoing-agent` is the source session speaking for
   * itself and sees reasoning the timeline never recorded; `summarizer` is an
   * observer model reading the timeline, which is all that is available once the
   * source is wedged or gone. Neither is verified.
   */
  origin: "outgoing-agent" | "summarizer";
  text: string;
}

export interface ComposeHandoffBriefInput {
  /** The original request, carried unchanged through the chain. Null on a first handoff. */
  rootObjective: string | null;
  facts: HandoffTimelineFacts;
  git: HandoffGitFacts | null;
  source: HandoffEndpoint;
  target: HandoffEndpoint;
  narrative: HandoffNarrative | null;
  /** 0 when the source agent started the chain. */
  chainDepth: number;
}

/**
 * Per-section caps. The brief exists largely because the previous session ran
 * out of context, so it must not arrive as another oversized prompt. Capping each
 * section rather than the total keeps truncation predictable: a caller can tell
 * from the input alone what will survive.
 */
const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_FILES = 40;
const MAX_TASKS = 30;
const MAX_TASK_CHARS = 120;
const MAX_ERROR_CHARS = 300;
const MAX_NARRATIVE_CHARS = 4_000;
const MAX_LAST_MESSAGE_CHARS = 800;

const PREAMBLE = `# Handoff brief

You are picking up work already in progress. This brief is the only context you
have: the previous session's conversation is not available to you.

OBSERVED sections are read from git and from the previous agent's tracked state.
DECLARED sections are the previous agent's own account and are unverified — check
them against the working tree before you rely on them.`;

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function describeEndpoint(endpoint: HandoffEndpoint): string {
  return endpoint.model ? `${endpoint.provider} (${endpoint.model})` : endpoint.provider;
}

function isSameEndpoint(a: HandoffEndpoint, b: HandoffEndpoint): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function fileMarker(file: HandoffChangedFile): string {
  if (file.isNew) return "+";
  if (file.isDeleted) return "-";
  return "~";
}

function taskMarker(task: AgentTaskItem): string {
  if (task.completed || task.status === "completed") return "x";
  return task.status === "in_progress" ? "~" : " ";
}

function renderWorkingTree(git: HandoffGitFacts): string | null {
  const lines: string[] = [];
  if (git.branch) {
    lines.push(
      git.baseRef ? `Branch: ${git.branch} (base: ${git.baseRef})` : `Branch: ${git.branch}`,
    );
  }
  if (git.diffTooLarge) {
    lines.push("Changed files: the diff is too large to summarize — inspect it with git yourself.");
  } else if (git.files.length > 0) {
    lines.push("Changed files:");
    for (const file of git.files.slice(0, MAX_FILES)) {
      lines.push(`  ${fileMarker(file)} ${file.path} +${file.additions} -${file.deletions}`);
    }
    if (git.files.length > MAX_FILES) {
      lines.push(`  …and ${git.files.length - MAX_FILES} more files`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function renderFooter(input: ComposeHandoffBriefInput): string {
  const lines: string[] = [];
  if (input.chainDepth > 0) {
    lines.push(
      `This is handoff ${input.chainDepth + 1} of a chain. The objective above is the original request, carried forward unchanged.`,
    );
  }
  lines.push(
    isSameEndpoint(input.source, input.target)
      ? `Continued from an earlier ${describeEndpoint(input.source)} session in a fresh context.`
      : `Handed off from ${describeEndpoint(input.source)} to ${describeEndpoint(input.target)}.`,
  );
  lines.push("Start by confirming the working tree matches this brief, then continue the work.");
  return lines.join("\n");
}

export function composeHandoffBrief(input: ComposeHandoffBriefInput): string {
  const sections: string[] = [PREAMBLE];

  const objective = input.rootObjective ?? input.facts.objective;
  if (objective) {
    sections.push(`## Objective\n\n${truncate(objective, MAX_OBJECTIVE_CHARS)}`);
  }

  const workingTree = input.git ? renderWorkingTree(input.git) : null;
  if (workingTree) {
    sections.push(`## Working tree (OBSERVED)\n\n${workingTree}`);
  }

  if (input.facts.tasks.length > 0) {
    const lines = input.facts.tasks
      .slice(0, MAX_TASKS)
      .map((task) => `- [${taskMarker(task)}] ${task.text.slice(0, MAX_TASK_CHARS)}`);
    if (input.facts.tasks.length > MAX_TASKS) {
      lines.push(`- …and ${input.facts.tasks.length - MAX_TASKS} more tasks`);
    }
    sections.push(`## Task list (OBSERVED)\n\n${lines.join("\n")}`);
  }

  if (input.facts.recentErrors.length > 0) {
    const errors = input.facts.recentErrors
      .map((error) => `- ${error.slice(0, MAX_ERROR_CHARS)}`)
      .join("\n");
    sections.push(`## Errors in the previous session (OBSERVED)\n\n${errors}`);
  }

  if (input.narrative) {
    sections.push(
      `## Notes from the previous agent (DECLARED)\n\n${truncate(input.narrative.text, MAX_NARRATIVE_CHARS)}`,
    );
  }

  if (input.facts.lastAssistantMessage) {
    sections.push(
      `## Last message from the previous agent (DECLARED)\n\n${truncate(input.facts.lastAssistantMessage, MAX_LAST_MESSAGE_CHARS)}`,
    );
  }

  sections.push(`---\n\n${renderFooter(input)}`);

  return sections.join("\n\n");
}
