import type { ExplorerEntry } from "@/stores/session-store";

/**
 * What a client may do with one explorer entry.
 *
 * The daemon lists symlinks it refuses to follow — targets outside the
 * workspace, and links whose target is gone — instead of dropping them, so a
 * blocked link reads as blocked rather than as a file that vanished. Nothing
 * about such a target is readable, so the UI withholds every action that would
 * reach through the link rather than offering one that is certain to fail.
 */
export interface ExplorerEntryCapabilities {
  /** Pressing the row opens the file or expands the directory. */
  canOpen: boolean;
  /** Anything that reads, copies, downloads, or reveals the link's target. */
  canAccessTarget: boolean;
  /** Renaming or deleting the link itself, which never touches the target. */
  canEditInPlace: boolean;
}

export function explorerEntryCapabilities(entry: ExplorerEntry): ExplorerEntryCapabilities {
  if (!entry.unavailable) {
    return { canOpen: true, canAccessTarget: true, canEditInPlace: true };
  }
  return {
    canOpen: false,
    canAccessTarget: false,
    // A broken link still resolves to a path inside the workspace, so the daemon
    // permits editing it. One pointing outside does not, and asking would only
    // surface a boundary error.
    canEditInPlace: entry.unavailable === "broken-link",
  };
}
