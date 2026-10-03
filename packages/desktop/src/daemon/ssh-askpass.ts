import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  createAskpassChannel,
  type AskpassChannel,
  type AskpassRequest,
} from "@getpaseo/server/ssh";
import { sshPromptGrants } from "./ssh-prompt-grants.js";

/**
 * How long a prompt stays on screen before Paseo answers for the user by
 * declining. Shorter than the channel's own backstop below, so the renderer is
 * always told to take the dialog down rather than leaving it up over a
 * connection that has already given up.
 */
const RENDERER_PROMPT_TIMEOUT_MS = 110_000;
const CHANNEL_PROMPT_TIMEOUT_MS = 180_000;

const REQUEST_EVENT = "paseo:event:ssh-password-request";
const RESOLVED_EVENT = "paseo:event:ssh-password-resolved";

export interface SshPasswordRequestEvent {
  requestId: string;
  /** The host being connected to, so the dialog can name it. */
  host: string;
  /** SSH's own prompt — carries the key path or `user@host`. */
  prompt: string;
  kind: AskpassRequest["kind"];
}

/** Prompts waiting on the user, keyed by the id the renderer answers with. */
const pending = new Map<string, (secret: string | null) => void>();

/**
 * Arm credential prompting for one connect the user asked for. Everything else
 * authenticates with a key or fails; see `./ssh-prompt-grants.ts` for why.
 */
export function grantSshInteractivePrompt(args: unknown): void {
  if (typeof args !== "object" || args === null) return;
  const { host, remoteSetup } = args as { host?: unknown; remoteSetup?: unknown };
  if (typeof host !== "string") return;
  sshPromptGrants.grant({ host, remoteSetup: remoteSetup === true });
}

function broadcast(channel: string, payload: unknown): boolean {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(channel, payload);
  }
  return windows.length > 0;
}

/**
 * Answer a prompt from the renderer. A null secret is the user declining,
 * which aborts the connection rather than handing SSH an empty password.
 */
export function submitSshPassword(args: unknown): void {
  if (typeof args !== "object" || args === null) return;
  const { requestId, secret } = args as { requestId?: unknown; secret?: unknown };
  if (typeof requestId !== "string") return;
  const settle = pending.get(requestId);
  if (!settle) return;
  settle(typeof secret === "string" ? secret : null);
}

function promptRenderer(host: string, request: AskpassRequest): Promise<string | null> {
  const requestId = randomUUID();
  const event: SshPasswordRequestEvent = {
    requestId,
    host,
    prompt: request.prompt,
    kind: request.kind,
  };

  // No window means no one to ask. Declining immediately is better than
  // holding the SSH process open for two minutes waiting on nobody.
  if (!broadcast(REQUEST_EVENT, event)) return Promise.resolve(null);

  // Whichever comes first — the user's answer or the deadline — wins, and the
  // renderer is told to take the dialog down either way.
  let settle: (secret: string | null) => void = () => {};
  const answered = new Promise<string | null>((resolve) => {
    settle = resolve;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (secret: string | null): void => {
    // The delete is the guard: only the first caller finds an entry to remove.
    if (!pending.delete(requestId)) return;
    clearTimeout(timer);
    // Declining, or letting the prompt lapse, retracts the whole grant. The
    // user has answered "not now" for this host, and the connection the grant
    // would otherwise still cover would only ask again.
    if (secret === null) sshPromptGrants.revoke(host);
    broadcast(RESOLVED_EVENT, { requestId });
    settle(secret);
  };
  pending.set(requestId, finish);
  timer = setTimeout(() => finish(null), RENDERER_PROMPT_TIMEOUT_MS);

  return answered;
}

/**
 * An SSH_ASKPASS channel whose prompts are answered by Paseo's own UI.
 *
 * Without this, SSH connections run under `BatchMode` and only key or agent
 * authentication works — a password-protected host cannot be reached at all,
 * because SSH has nowhere to display its prompt in a packaged desktop app.
 *
 * Returns null on Windows, where the askpass program (a `/bin/sh` script) will
 * not run, and for any connection the user did not ask for — see
 * `./ssh-prompt-grants.ts`. Both cases keep the key-only behaviour: `ssh` runs
 * under `BatchMode` and fails rather than asking a question nobody is waiting
 * on.
 */
export async function createDesktopAskpassChannel(host: string): Promise<AskpassChannel | null> {
  if (process.platform === "win32") return null;
  if (!sshPromptGrants.isGranted(host)) return null;
  return createAskpassChannel({
    onPrompt: (request) => promptRenderer(host, request),
    promptTimeoutMs: CHANNEL_PROMPT_TIMEOUT_MS,
  });
}
