import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/**
 * How long a line stands before it is treated as finished business. Output
 * arrives continuously while the CLI works, so this only expires after the
 * operation itself has stopped producing any.
 */
const LINE_TTL_MS = 20_000;

/**
 * The latest line of `devcontainer up` output for a workspace's own container.
 *
 * A first build pulls an image and runs lifecycle scripts for minutes. Without
 * this the user has a spinner and no way to tell a slow build from a stuck one —
 * the complaint that prompted it.
 *
 * Only the latest line is kept, which is also all the daemon sends: a build is
 * thousands of lines and nothing here is a log viewer. Older daemons send none,
 * so the line stays null and the caller needs no feature check.
 *
 * The line expires on a timer rather than on a status change, because a rebuild
 * leaves `containerStatus` at "running" the whole time it works — the status
 * cannot say when there is something to watch, and it is the rebuild case the
 * user most wants to watch.
 */
export function useContainerLifecycleProgress(input: {
  client: DaemonClient | null;
  workspaceId: string | null;
  /** False for a workspace with no container at all, which can produce none. */
  enabled: boolean;
}): string | null {
  const { client, workspaceId, enabled } = input;
  const [line, setLine] = useState<string | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!client || !workspaceId || !enabled) {
      setLine(null);
      return;
    }
    const unsubscribe = client.onContainerLifecycleProgress(workspaceId, (progress) => {
      setLine(progress.line);
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = setTimeout(() => setLine(null), LINE_TTL_MS);
    });
    return () => {
      unsubscribe();
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = null;
      setLine(null);
    };
  }, [client, workspaceId, enabled]);

  return line;
}
