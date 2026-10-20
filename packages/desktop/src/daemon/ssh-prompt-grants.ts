import { sshConnectTimeoutMs, validateSshHost } from "@getpaseo/protocol/ssh-transport";

/**
 * Which SSH hosts may currently put a credential question in front of the user.
 *
 * A prompt is only reasonable when someone is expecting it. The runtime reaches
 * a remote host on its own schedule — at startup, on app resume, and on every
 * reconnect backoff tick — and each of those attempts used to raise its own
 * modal and hold an `ssh` process and an askpass socket open behind it for as
 * long as the dialog stood. On a saved password host that is a loop nobody can
 * win: prompts stack up, processes accumulate, and none of it was asked for.
 *
 * So prompting is opt-in per host. Pressing Connect opens a window for that
 * host; outside one, `ssh` runs under `BatchMode` and fails into an error the
 * app offers to act on.
 */
export interface SshPromptGrantsDeps {
  now(): number;
}

export interface SshPromptGrants {
  /**
   * Open the prompting window for a host the user just asked to connect to.
   *
   * A window rather than a use count, because one press of Connect is not one
   * `ssh`: the app probes the host to learn its server id, the runtime then
   * opens the connection it keeps, and either may retry. Counting those would
   * break the ordinary path as soon as the count was off by one, where an
   * over-long window only risks a prompt the user was already expecting.
   *
   * Sized to the connection's own budget, doubled to span the probe and the
   * connection behind it.
   */
  grant(input: { host: string; remoteSetup?: boolean }): void;
  /**
   * Close a host's window early. Declining a prompt does this: the user has
   * answered "not now", and the attempts still inside the window would only ask
   * again.
   */
  revoke(host: string): void;
  /** Whether `host` may prompt right now. */
  isGranted(host: string): boolean;
}

export function createSshPromptGrants(
  deps: SshPromptGrantsDeps = { now: () => Date.now() },
): SshPromptGrants {
  const expiryByHost = new Map<string, number>();

  return {
    grant({ host, remoteSetup }) {
      let normalized: string;
      try {
        normalized = validateSshHost(host);
      } catch {
        return;
      }
      const budgetMs = sshConnectTimeoutMs(remoteSetup === true ? { remoteDaemon: {} } : {});
      expiryByHost.set(normalized, deps.now() + budgetMs * 2);
    },

    revoke(host) {
      expiryByHost.delete(host);
    },

    isGranted(host) {
      const expiresAt = expiryByHost.get(host);
      if (expiresAt === undefined) return false;
      if (expiresAt <= deps.now()) {
        expiryByHost.delete(host);
        return false;
      }
      return true;
    },
  };
}

/** The registry the desktop's own askpass channel consults. */
export const sshPromptGrants = createSshPromptGrants();
