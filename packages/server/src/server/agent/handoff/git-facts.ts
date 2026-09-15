import type { CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { HandoffGitFacts } from "./brief.js";

/**
 * The slice of WorkspaceGitService a handoff needs. Narrow on purpose: the git
 * half of a brief is the part a successor is told to trust, so it should be
 * testable without standing up a repository.
 */
export interface HandoffGitReader {
  getSnapshot(cwd: string): Promise<{
    git: { isGit: boolean; currentBranch: string | null; baseRef: string | null };
  }>;
  getCheckoutDiff(
    cwd: string,
    compare: { mode: "uncommitted" | "base"; baseRef?: string; includeStructured?: boolean },
  ): Promise<CheckoutDiffResult>;
}

/**
 * Reads the observed half of a handoff brief. Returns null when there is nothing
 * to observe — a non-git directory, or a git read that failed. A brief without a
 * working-tree section is worth far more than a handoff that refused to happen.
 */
export async function readHandoffGitFacts(
  reader: HandoffGitReader,
  cwd: string,
): Promise<HandoffGitFacts | null> {
  try {
    const snapshot = await reader.getSnapshot(cwd);
    if (!snapshot.git.isGit) {
      return null;
    }

    const baseRef = snapshot.git.baseRef;
    const diff = await reader.getCheckoutDiff(cwd, {
      // Without a base ref there is no branch to diff, so fall back to whatever
      // is uncommitted rather than reporting an empty changeset.
      mode: baseRef ? "base" : "uncommitted",
      ...(baseRef ? { baseRef } : {}),
      includeStructured: true,
    });

    return {
      branch: snapshot.git.currentBranch,
      baseRef,
      files: (diff.structured ?? []).map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        isNew: file.isNew,
        isDeleted: file.isDeleted,
      })),
      diffTooLarge: diff.diffTooLarge === true,
    };
  } catch {
    return null;
  }
}
