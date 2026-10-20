import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * Tell the desktop that the connect about to happen is one the user asked for,
 * so SSH may put a password or host-key question in front of them.
 *
 * Nothing else may. Startup, app resume and reconnect backoff all reach a
 * remote host on their own schedule, and a credential prompt from one of those
 * is a dialog nobody is waiting on — on a saved password host, a stream of
 * them. Those attempts authenticate with a key or fail into an error tagged
 * `SSH_AUTH_REQUIRED_PREFIX`, which the app turns into an offer to connect.
 *
 * Call this immediately before the connect it covers: the grant is spent by the
 * next connections to that host, and expires either way.
 *
 * Best-effort by design — outside Electron there is no SSH transport to grant.
 */
export async function grantSshPrompt(input: {
  host: string;
  remoteSetup?: boolean;
}): Promise<void> {
  try {
    await invokeDesktopCommand("grant_ssh_prompt", {
      host: input.host,
      remoteSetup: input.remoteSetup ?? false,
    });
  } catch {
    // No desktop bridge, or an older main process that has no such command.
  }
}
