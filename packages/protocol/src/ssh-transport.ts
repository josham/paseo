export const DEFAULT_SSH_DAEMON_PORT = 6767;

/**
 * Opt-in remote install and launch. Absent — the default — means Paseo only
 * forwards a port and expects a daemon to already be listening behind it.
 * Present means the user explicitly asked Paseo to set the host up; see
 * `./ssh-lifecycle.js` for what that runs.
 */
export interface SshRemoteDaemonOptions {
  remoteHome?: string;
  installDir?: string;
  version?: string;
}

export interface SshTransportTarget {
  host: string;
  sshPort?: number;
  daemonPort: number;
  remoteDaemon?: SshRemoteDaemonOptions;
}

/**
 * Per-connection SSH behaviour that is not part of the target itself.
 *
 * `askpassPath` is what makes password-protected hosts usable: SSH only reads
 * a secret from an `SSH_ASKPASS` program's stdout, and it only looks for one
 * when `BatchMode` is off — so naming a program here drops `BatchMode=yes`.
 */
export interface SshConnectionOptions {
  askpassPath?: string;
}

/**
 * How long an SSH connection may take before it is called a failure.
 *
 * The local budgets elsewhere assume a socket that is either there or not.
 * SSH can instead be waiting on a person: the askpass dialog gives the user
 * nearly two minutes to type a password, and cutting the connection out from
 * under an open dialog would be a bug the user sees as "it never asked me".
 */
export const SSH_CONNECT_TIMEOUT_MS = 150_000;

/**
 * A host being set up for the first time also has to install Paseo and wait
 * for a daemon to start, on top of any prompt. `npm install` on a small VPS is
 * the slow part.
 */
export const SSH_REMOTE_SETUP_TIMEOUT_MS = 330_000;

export function sshConnectTimeoutMs(target: { remoteDaemon?: SshRemoteDaemonOptions }): number {
  return target.remoteDaemon ? SSH_REMOTE_SETUP_TIMEOUT_MS : SSH_CONNECT_TIMEOUT_MS;
}

export function validatePort(value: string | number, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

export function validateSshHost(host: string): string {
  const normalized = host.trim();
  if (!normalized) throw new Error("SSH host is required");
  if (/\s/u.test(normalized) || normalized.startsWith("-")) {
    throw new Error("SSH host is invalid");
  }
  return normalized;
}

/**
 * Query parameters an `ssh://` host URI understands. Everything else is
 * rejected, so a typo is a clear error rather than a silently ignored option.
 */
const SSH_URI_OPTIONS = new Set(["daemonPort", "install", "remoteHome", "installDir", "version"]);

const REMOTE_DAEMON_OPTIONS = ["remoteHome", "installDir", "version"] as const;

function readSingle(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new Error(`${key} may only be specified once`);
  return values[0];
}

/**
 * Read the remote install/launch options, which stay off unless `install=1`
 * says otherwise. Requiring the explicit flag keeps "connect to this host" and
 * "set this host up" separate: tunnelling never installs anything by itself.
 */
function parseRemoteDaemonOptions(params: URLSearchParams): SshRemoteDaemonOptions | undefined {
  const install = readSingle(params, "install");
  const enabled = install === "1" || install === "true";
  if (install !== undefined && !enabled) {
    throw new Error("install must be 1 or true");
  }
  const options: SshRemoteDaemonOptions = {};
  for (const key of REMOTE_DAEMON_OPTIONS) {
    const value = readSingle(params, key)?.trim();
    if (value === undefined || value === "") continue;
    if (!enabled) throw new Error(`${key} requires install=1`);
    options[key] = value;
  }
  return enabled ? options : undefined;
}

export function parseSshTransportUri(value: string): SshTransportTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Invalid SSH host URI", { cause: error });
  }

  if (url.protocol !== "ssh:" || url.password || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Invalid SSH host URI");
  }
  if (url.hash) throw new Error("SSH host URI does not support fragments");

  for (const key of url.searchParams.keys()) {
    if (!SSH_URI_OPTIONS.has(key)) throw new Error(`Unsupported SSH host option: ${key}`);
  }
  const daemonPorts = url.searchParams.getAll("daemonPort");
  if (daemonPorts.length > 1) throw new Error("daemonPort may only be specified once");
  const remoteDaemon = parseRemoteDaemonOptions(url.searchParams);

  const urlHostname = url.hostname;
  const hostname = validateSshHost(
    urlHostname.startsWith("[") && urlHostname.endsWith("]")
      ? urlHostname.slice(1, -1)
      : urlHostname,
  );
  const username = decodeURIComponent(url.username);
  const host = validateSshHost(username ? `${username}@${hostname}` : hostname);
  return {
    host,
    ...(url.port ? { sshPort: validatePort(url.port, "SSH port") } : {}),
    daemonPort:
      daemonPorts[0] === undefined
        ? DEFAULT_SSH_DAEMON_PORT
        : validatePort(daemonPorts[0], "Daemon port"),
    ...(remoteDaemon ? { remoteDaemon } : {}),
  };
}

function buildSshCommonArgs(
  target: SshTransportTarget,
  options: SshConnectionOptions | undefined,
  extraOptions: string[],
): string[] {
  const args = ["-T"];
  // BatchMode fails auth fast instead of hanging on a prompt nobody can see.
  // With an askpass program there *is* somewhere to show the prompt, and
  // BatchMode would suppress it, so the two are mutually exclusive.
  if (!options?.askpassPath) args.push("-o", "BatchMode=yes");
  args.push("-o", "ConnectTimeout=10", ...extraOptions);
  if (target.sshPort !== undefined) {
    args.push("-p", String(validatePort(target.sshPort, "SSH port")));
  }
  return args;
}

/** `ssh -W`: stdio becomes the daemon socket. The data path. */
export function buildSshTunnelArgs(
  target: SshTransportTarget,
  options?: SshConnectionOptions,
): string[] {
  const host = validateSshHost(target.host);
  const daemonPort = validatePort(target.daemonPort, "Daemon port");
  const args = buildSshCommonArgs(target, options, [
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
  ]);
  args.push("-W", `127.0.0.1:${daemonPort}`, host);
  return args;
}

/**
 * `ssh <host> <command>`: an ordinary remote command with stdin free, which
 * the remote-daemon setup step needs so it can pipe its script in. Distinct
 * from {@link buildSshTunnelArgs}, where stdio is already spoken for by `-W`.
 */
export function buildSshSessionArgs(
  target: SshTransportTarget,
  command: string,
  options?: SshConnectionOptions,
): string[] {
  const host = validateSshHost(target.host);
  const args = buildSshCommonArgs(target, options, []);
  args.push(host, command);
  return args;
}

/**
 * The subset of `process.env` this module touches, spelled without `@types/node`
 * so the protocol package stays importable from the app's bundler.
 */
export type SshProcessEnv = Record<string, string | undefined>;

/**
 * Environment for an `ssh` child that should prompt through `askpassPath`.
 *
 * OpenSSH only consults `SSH_ASKPASS` when it believes a display exists.
 * `SSH_ASKPASS_REQUIRE=force` covers modern OpenSSH; setting `DISPLAY` covers
 * builds old enough to still check it.
 */
export function sshAskpassEnv(baseEnv: SshProcessEnv, askpassPath: string): SshProcessEnv {
  return {
    ...baseEnv,
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: baseEnv.DISPLAY ?? ":0",
  };
}

/**
 * Marker on a failure detail meaning "this host wanted a credential Paseo was
 * not allowed to ask for".
 *
 * A credential prompt has to be something the user is expecting, so only a
 * connection the user started may raise one; see the grant in the desktop's
 * `ssh-askpass`. Every other attempt runs under `BatchMode` and fails here
 * instead, and the app turns this marker into an offer to connect rather than
 * into raw `ssh` stderr.
 */
export const SSH_AUTH_REQUIRED_PREFIX = "ssh_auth_required: ";

/**
 * OpenSSH's own words for "I had no credential I could use here". OpenSSH
 * ships no translations, so matching the English is safe.
 */
const SSH_AUTH_FAILURE_PATTERNS = [
  /permission denied/iu,
  /host key verification failed/iu,
  /too many authentication failures/iu,
  /no supported authentication methods available/iu,
];

/** Whether `ssh` stderr says the connection failed for want of a credential. */
export function isSshAuthFailureStderr(stderr: string): boolean {
  return SSH_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function markSshAuthRequired(detail: string): string {
  return detail.startsWith(SSH_AUTH_REQUIRED_PREFIX)
    ? detail
    : `${SSH_AUTH_REQUIRED_PREFIX}${detail}`;
}

/**
 * `includes` rather than `startsWith`: by the time the app sees this the
 * client has usually wrapped the detail in a message of its own.
 */
export function isSshAuthRequiredMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes(SSH_AUTH_REQUIRED_PREFIX);
}

/** The same message with the marker taken back out, for display. */
export function stripSshAuthRequiredPrefix(message: string): string {
  return message.split(SSH_AUTH_REQUIRED_PREFIX).join("");
}
