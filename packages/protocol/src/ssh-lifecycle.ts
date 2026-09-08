/**
 * Bringing a Paseo daemon up on a remote SSH host.
 *
 * The transport in `./ssh-transport.js` deliberately assumes the daemon is
 * already running: it forwards a port and nothing else. This module is the
 * separate, explicit step that installs and launches the daemon, expressed as
 * a single POSIX shell script so it can run over one SSH connection without
 * needing anything on the remote host but `sh` and Node.
 *
 * Only string building lives here, so the CLI and the Electron main process —
 * which cannot import each other — can share it through `@getpaseo/protocol`.
 * The process side lives in `@getpaseo/server/ssh`.
 */

/** Remote `PASEO_HOME` when the host config does not name one. */
export const DEFAULT_SSH_REMOTE_HOME = "~/.paseo";
/** Where Paseo installs its own copy of the CLI when the host has none. */
export const DEFAULT_SSH_INSTALL_DIR = "~/.paseo/cli";

/** Everything the ensure script needs to know about a remote host. */
export interface SshRemoteDaemonSpec {
  /** Hostname as passed to `ssh`, used only in user-facing messages here. */
  host: string;
  /** Port the remote daemon should listen on. */
  daemonPort: number;
  /** Remote `PASEO_HOME`. */
  remoteHome: string;
  /** Remote directory Paseo may install into. */
  installDir: string;
  /** `@getpaseo/cli` version to install when the host has no Paseo. */
  version: string;
}

export interface SshRemoteDaemonSpecInput {
  host: string;
  daemonPort: number;
  remoteHome?: string;
  installDir?: string;
  version?: string;
}

/** Apply the remote-lifecycle defaults in one place. */
export function resolveRemoteDaemonSpec(input: SshRemoteDaemonSpecInput): SshRemoteDaemonSpec {
  return {
    host: input.host,
    daemonPort: input.daemonPort,
    remoteHome: input.remoteHome?.trim() || DEFAULT_SSH_REMOTE_HOME,
    installDir: input.installDir?.trim() || DEFAULT_SSH_INSTALL_DIR,
    version: input.version?.trim() || "latest",
  };
}

/**
 * Quote a value for safe interpolation into a POSIX shell script. Everything
 * the ensure script embeds — hostnames, paths, version specs — comes from user
 * config, so it must survive quotes, `$`, backticks, and spaces intact.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Render a path as a single shell word. `~`-relative paths become `"$HOME"`
 * followed by a single-quoted remainder, so the tilde expands but nothing in
 * the rest of the path can be reinterpreted by the shell.
 */
export function shellPath(value: string): string {
  if (value === "~") return `"$HOME"`;
  if (value.startsWith("~/")) return `"$HOME"/${shellQuote(value.slice(2))}`;
  return shellQuote(value);
}

/**
 * Exit codes the ensure script reports back through SSH. They are the contract
 * between {@link buildEnsureScript} and {@link describeEnsureFailure}.
 */
export const ENSURE_EXIT = {
  ready: 0,
  nodeMissing: 10,
  installFailed: 11,
  notReady: 12,
  npmMissing: 13,
  nodeTooOld: 14,
} as const;

/**
 * Structured markers the ensure script writes to stderr. `PROGRESS:` lines are
 * human-facing status text and may be reworded freely; `READY:` is the machine
 * contract that says the daemon is accepting connections. Keeping the two
 * separate means rewording user-facing status cannot silently break readiness
 * detection.
 */
export const PROGRESS_MARKER = "PROGRESS:";
export const READY_MARKER = "READY:";
/** Carries the remote `node -v` back so the failure can name what was found. */
export const NODE_VERSION_MARKER = "NODE_VERSION:";

/**
 * The flag in `packages/cli/bin/paseo`'s shebang. Node rejects an unknown
 * `--` option outright, so a runtime without it cannot start Paseo at all.
 * Added in Node 20.11.
 */
const NODE_CAPABILITY_FLAG = "--disable-warning=DEP0040";
/** Named in the failure message, since the probe itself cannot say it. */
const MINIMUM_NODE_VERSION = "20.11";

/**
 * The command `ssh` runs on the remote host.
 *
 * sshd executes a remote command as `<user's shell> -c "<command>"`, using the
 * shell from the password database. That is not a login shell, but it *is* the
 * user's shell binary — so a host where someone has `chsh`'d to fish or tcsh
 * would try to parse our POSIX script with fish or tcsh and fail outright.
 *
 * Wrapping the script as `/bin/sh -c '<script>'` does not help: the outer
 * string still goes through that shell, and neither fish nor csh can carry the
 * quotes and newlines the script contains. So the command is reduced to three
 * words with no metacharacters at all — every shell agrees on what that
 * means — and the script itself is piped in over stdin.
 *
 * Two things fall out of this for free: nothing needs shell-escaping on the way
 * in, and the script no longer shows up in the remote host's process list,
 * where any other user could read it.
 */
export const REMOTE_SHELL_COMMAND = "exec /bin/sh";

/** How long the remote script waits for the daemon to start listening. */
export const REMOTE_READY_TIMEOUT_MS = 30_000;
// Whole seconds: POSIX `sleep` only guarantees integer arguments, and BusyBox
// builds without FANCY_SLEEP reject "0.5".
const REMOTE_POLL_INTERVAL_MS = 1_000;

/**
 * Build a single self-contained shell script that ensures a Paseo daemon is
 * running on the remote host. The script:
 *
 * 1. Returns immediately if the daemon port is already listening
 * 2. Prefers a `paseo` already on `PATH` (global npm, system package manager)
 * 3. Fails early if the host's Node is too old to run Paseo's launcher
 * 4. Otherwise installs — or upgrades — a Paseo-managed copy under `installDir`
 * 5. Launches the daemon detached
 * 6. Waits for the port to accept connections, then exits
 *
 * Preferring a `PATH` install matters for correctness, not just disk: if we
 * installed a second copy, a user on the remote host could start *their*
 * daemon from the system binary while we run a different build against the
 * same `PASEO_HOME`, and the two would fight over the port and the agent
 * state. Paseo only ever installs or upgrades inside `installDir` — never a
 * binary it did not put there.
 *
 * The script is piped to a remote `/bin/sh` over the SSH connection's stdin
 * rather than passed as the remote command, so the user's own shell never has
 * to parse it. See {@link REMOTE_SHELL_COMMAND}.
 *
 * It exits as soon as the daemon is listening. Nothing about the tunnel
 * depends on this connection staying up: the daemon is detached, and the data
 * path is a separate `ssh -W` forward. On failure it exits with a code from
 * {@link ENSURE_EXIT}, which `ssh` reports as its own exit code.
 */
export function buildEnsureScript(spec: SshRemoteDaemonSpec): string {
  const home = shellPath(spec.remoteHome);
  const installDir = shellPath(spec.installDir);
  const host = spec.host;
  const wanted = spec.version.trim() || "latest";
  const maxPolls = Math.floor(REMOTE_READY_TIMEOUT_MS / REMOTE_POLL_INTERVAL_MS);

  // Exits 0 if the port accepts a connection, 1 otherwise. Node is the only
  // runtime we can rely on (Paseo itself needs it), so the check uses it
  // rather than nc or bash-isms that vary across remote hosts.
  const portCheck = `node -e 'const n=require("net");const s=n.connect({port:${spec.daemonPort},host:"127.0.0.1"});s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},3000)'`;

  return [
    // Wrapped in a function so `sh` has to read the whole body before running
    // any of it: a connection that dies mid-write then runs nothing at all
    // rather than half an install.
    `ensure_daemon() {`,
    `  paseo_home=${home}`,
    `  paseo_dir=${installDir}`,
    `  paseo_want=${shellQuote(wanted)}`,
    ``,
    `  if ! command -v node >/dev/null 2>&1; then`,
    `    echo "${PROGRESS_MARKER}Node.js is required on ${host} to run the Paseo daemon." >&2`,
    `    return ${ENSURE_EXIT.nodeMissing}`,
    `  fi`,
    ``,
    `  # 1. Already running? Whatever owns the port keeps it; never double-start.`,
    `  if ${portCheck}; then`,
    `    echo "${PROGRESS_MARKER}Remote daemon is already running." >&2`,
    `    echo "${READY_MARKER}running" >&2`,
    `    return 0`,
    `  fi`,
    ``,
    `  # 2. Paseo's launcher is a shebang carrying a flag older Node rejects, so`,
    `  #    a too-old runtime dies instantly with a cryptic parse error. Probing`,
    `  #    the flag itself beats hardcoding a version we would have to keep in`,
    `  #    sync. Deliberately after the check above: a host that is already`,
    `  #    serving a daemon needs nothing from us.`,
    `  if ! node ${NODE_CAPABILITY_FLAG} -e '' >/dev/null 2>&1; then`,
    `    paseo_node=$(node -v 2>/dev/null || echo unknown)`,
    `    echo "${PROGRESS_MARKER}Node.js on ${host} is $paseo_node, too old to run Paseo." >&2`,
    `    echo "${NODE_VERSION_MARKER}$paseo_node" >&2`,
    `    return ${ENSURE_EXIT.nodeTooOld}`,
    `  fi`,
    ``,
    `  # 3. Prefer a paseo the host already provides (global npm, system package`,
    `  #    manager, nix, ...) so we never run a second, conflicting daemon.`,
    `  paseo_bin=$(command -v paseo 2>/dev/null || true)`,
    `  if [ -n "$paseo_bin" ]; then`,
    `    echo "${PROGRESS_MARKER}Using the Paseo already installed on ${host} ($paseo_bin)." >&2`,
    `  else`,
    `    paseo_bin="$paseo_dir/node_modules/.bin/paseo"`,
    `    # 4. Install or upgrade the copy Paseo manages under its own directory.`,
    `    paseo_have=""`,
    `    if [ -x "$paseo_bin" ]; then`,
    `      paseo_have=$(cd "$paseo_dir" && node -p "require('./node_modules/@getpaseo/cli/package.json').version" 2>/dev/null || true)`,
    `    fi`,
    `    if [ "$paseo_have" = "$paseo_want" ]; then`,
    `      echo "${PROGRESS_MARKER}Paseo $paseo_want is already installed on ${host}." >&2`,
    `    else`,
    `      if ! command -v npm >/dev/null 2>&1; then`,
    `        echo "${PROGRESS_MARKER}npm is required on ${host} to install Paseo." >&2`,
    `        return ${ENSURE_EXIT.npmMissing}`,
    `      fi`,
    `      if [ -n "$paseo_have" ]; then`,
    `        echo "${PROGRESS_MARKER}Updating Paseo on ${host} from $paseo_have to $paseo_want…" >&2`,
    `      else`,
    `        echo "${PROGRESS_MARKER}Installing Paseo $paseo_want on ${host}…" >&2`,
    `      fi`,
    `      mkdir -p "$paseo_dir"`,
    `      if ! npm install --prefix "$paseo_dir" "@getpaseo/cli@$paseo_want" </dev/null >&2; then`,
    // A source checkout or an unpublished beta has no registry entry. Falling
    // back keeps "connect from a dev build" working instead of hard-failing.
    `        if [ "$paseo_want" = latest ]; then`,
    `          echo "${PROGRESS_MARKER}Failed to install Paseo on ${host}." >&2`,
    `          return ${ENSURE_EXIT.installFailed}`,
    `        fi`,
    `        echo "${PROGRESS_MARKER}Paseo $paseo_want is not published; installing the latest release instead…" >&2`,
    `        if ! npm install --prefix "$paseo_dir" "@getpaseo/cli@latest" </dev/null >&2; then`,
    `          echo "${PROGRESS_MARKER}Failed to install Paseo on ${host}." >&2`,
    `          return ${ENSURE_EXIT.installFailed}`,
    `        fi`,
    `      fi`,
    `      echo "${PROGRESS_MARKER}Paseo installed on ${host}." >&2`,
    `    fi`,
    `  fi`,
    ``,
    `  # 5. Launch the daemon. Output goes to stderr so it lands in the`,
    `  #    diagnostics we surface on failure; stdin is closed because this`,
    `  #    script is itself arriving on stdin and a child that reads it would`,
    `  #    swallow the rest of the script.`,
    `  echo "${PROGRESS_MARKER}Launching the Paseo daemon on ${host}…" >&2`,
    `  mkdir -p "$paseo_home"`,
    `  "$paseo_bin" daemon start --home "$paseo_home" --port ${spec.daemonPort} --no-relay --no-mcp </dev/null >&2`,
    ``,
    `  # 6. Wait for the port to accept connections.`,
    `  echo "${PROGRESS_MARKER}Waiting for the remote daemon to become ready…" >&2`,
    `  paseo_i=0`,
    `  while [ $paseo_i -lt ${maxPolls} ]; do`,
    `    if ${portCheck}; then`,
    `      echo "${PROGRESS_MARKER}Remote daemon is ready." >&2`,
    `      echo "${READY_MARKER}launched" >&2`,
    `      return 0`,
    `    fi`,
    `    sleep ${REMOTE_POLL_INTERVAL_MS / 1000}`,
    `    paseo_i=$((paseo_i + 1))`,
    `  done`,
    `  echo "${PROGRESS_MARKER}The daemon was launched on ${host} but never started listening." >&2`,
    `  return ${ENSURE_EXIT.notReady}`,
    `}`,
    // Preserve the exit code: `ensure_daemon && exit 0` would collapse every
    // failure to 1 and lose the reason.
    `ensure_daemon; exit $?`,
  ].join("\n");
}

/**
 * Describe a failure that came from `ssh` itself rather than the ensure
 * script. SSH exits 255 for auth, connection, host-key, and DNS failures; its
 * stderr is the only useful diagnostic, so it is surfaced verbatim.
 */
export function describeSshFailure(host: string, exitCode: number | null, stderr: string): string {
  const detail = stderr.trim();
  if (exitCode === 255) {
    return `SSH connection to ${host} failed.${detail ? `\n${detail}` : ""}`;
  }
  if (detail) {
    return `Failed to start the Paseo daemon on ${host}.\n${detail}`;
  }
  return `Failed to start the Paseo daemon on ${host} (exit code ${exitCode ?? "unknown"}).`;
}

/**
 * Turn an ensure-script exit code into an actionable message. Nothing else
 * knows what a non-zero exit meant, so every remote-launch failure the user
 * sees is worded here.
 */
/** Pull the remote `node -v` out of the stderr the ensure script produced. */
function readNodeVersion(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(NODE_VERSION_MARKER)) {
      const value = trimmed.slice(NODE_VERSION_MARKER.length).trim();
      if (value && value !== "unknown") return value;
    }
  }
  return null;
}

export function describeEnsureFailure(input: {
  spec: SshRemoteDaemonSpec;
  exitCode: number | null;
  stderr: string;
}): string {
  const { spec } = input;
  const stderr = input.stderr.trim();
  switch (input.exitCode) {
    case ENSURE_EXIT.nodeMissing:
      return (
        `Node.js is required on ${spec.host} to run the Paseo daemon. ` +
        `Install Node.js (https://nodejs.org) on the remote host and retry.`
      );
    case ENSURE_EXIT.npmMissing:
      return (
        `npm is required on ${spec.host} to install Paseo. ` +
        `Install npm there, or install Paseo on the remote host yourself and retry.`
      );
    case ENSURE_EXIT.installFailed:
      return `Failed to install Paseo on ${spec.host}.${stderr ? `\n${stderr}` : ""}`;
    case ENSURE_EXIT.nodeTooOld: {
      const found = readNodeVersion(stderr);
      return (
        `Node.js on ${spec.host}${found ? ` is ${found}, which` : ""} is too old to run Paseo. ` +
        `Install Node.js ${MINIMUM_NODE_VERSION} or newer on the remote host and retry.`
      );
    }
    case ENSURE_EXIT.notReady:
      return (
        `The Paseo daemon was launched on ${spec.host} but did not start listening on port ` +
        `${spec.daemonPort} within ${REMOTE_READY_TIMEOUT_MS / 1000}s.` +
        // The daemon's own output is the diagnosis when it died on startup —
        // and in that case it never got far enough to write a log to point at.
        `${stderr ? `\n${stderr}` : ` Check ${spec.remoteHome}/daemon.log on the remote host.`}`
      );
    default:
      return describeSshFailure(spec.host, input.exitCode, stderr);
  }
}
