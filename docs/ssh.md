# SSH remote hosts

Paseo can drive a daemon on another machine over SSH. There are two separate
pieces, and keeping them separate is the whole design:

- **Transport** — forward the remote daemon's port over an SSH connection.
  Touches nothing on the remote host; assumes a daemon is already listening.
- **Remote daemon setup** — install Paseo on the remote host and launch the
  daemon. Runs only when the user explicitly asks for it.

Connecting never implies setup. A host you have not opted in for is only ever
tunnelled to.

## Transport

`ssh -W 127.0.0.1:<daemonPort> <host>` makes the SSH process's stdio the daemon
socket. A local listener accepts one connection, spawns that `ssh`, and pipes
the two together; the daemon URL points at the local port.

- CLI: `packages/cli/src/ssh/ssh-tunnel.ts`
- Desktop main process: `packages/desktop/src/daemon/local-transport.ts`

Both build their arguments with `buildSshTunnelArgs` in
`packages/protocol/src/ssh-transport.ts`, so the flags cannot drift apart.
`ClearAllForwardings=yes` and `ExitOnForwardFailure=yes` mean a host whose
`~/.ssh/config` sets up unrelated forwards cannot quietly change what the
tunnel does. Everything else in that config — `IdentityFile`, `ProxyJump`,
`User`, `Port` — applies as usual, because `-p` is only passed when the user
set a port explicitly.

The daemon is reached as `127.0.0.1` **on the remote host**, so it never has to
listen on a public interface.

## Naming a host

`ssh://[user@]host[:sshPort][?options]`, parsed by `parseSshTransportUri`.

| Option       | Meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `daemonPort` | Port the remote daemon listens on (default 6767)            |
| `install`    | `1` to let Paseo install and launch the daemon on this host |
| `remoteHome` | Remote `PASEO_HOME` (default `~/.paseo`)                    |
| `installDir` | Where Paseo may install itself (default `~/.paseo/cli`)     |
| `version`    | `@getpaseo/cli` version to install                          |

Any other parameter is an error rather than a silently ignored option. The last
three require `install=1`: they only describe a setup that was asked for.

In the desktop app the same opt-in is the **Install and start Paseo on this
host** checkbox in Add host → Remote SSH. It is stored on the connection as
`remoteDaemon`, so a host set up once keeps starting itself on later
reconnects.

## Remote daemon setup

`ensureRemoteDaemon` (`packages/server/src/ssh/ensure-remote-daemon.ts`) opens a
second SSH connection — the tunnel's stdio is already spoken for by `-W` — and
pipes a POSIX shell script to `exec /bin/sh` on the remote host. The script is
built by `buildEnsureScript` in `packages/protocol/src/ssh-lifecycle.ts` and:

1. Returns immediately if the daemon port is already listening.
2. Fails early if the host's Node is too old to run Paseo.
3. Prefers a `paseo` already on `PATH`.
4. Otherwise installs or upgrades a copy under `installDir`.
5. Launches the daemon with `--no-relay --no-mcp`.
6. Waits up to 30s for the port to answer, then exits.

Four things about this are load-bearing:

**The script arrives on stdin, not as the remote command.** sshd runs a remote
command through the user's login shell, which may be fish or tcsh and would
fail to parse a POSIX script. `exec /bin/sh` is three words every shell agrees
on. As a bonus the script never appears in the remote process list.

**Paseo never launches a binary it did not install.** If the host already
provides `paseo`, that one is used. Installing a second copy would let two
different builds fight over one `PASEO_HOME` and one port.

**The Node check probes the flag, not a version number.** `packages/cli/bin/paseo`
is a shebang carrying `--disable-warning=DEP0040`, which Node rejects outright
before 20.11 — and the published package declares no `engines`, so npm installs
onto an old runtime happily and the daemon then dies instantly with
`node: bad option`. The script runs the flag itself rather than parsing
`node -v` against a constant that would drift. It runs _after_ the
already-listening check, so a host that is already serving a daemon is never
asked to satisfy it.

**Nothing has to stay connected.** The daemon is detached, so the setup
connection exits as soon as the port answers. On Linux the launch is wrapped in
`systemd-run --user --scope` (see `packages/cli/src/commands/daemon/local-daemon.ts`)
because logind with `KillUserProcesses=yes` otherwise kills the daemon along
with the SSH session that started it.

Failures come back as exit codes from `ENSURE_EXIT`, which
`describeEnsureFailure` turns into an actionable message — "Node.js is required
on build-box", not "exit code 10". When the daemon launches but never listens,
that message carries the daemon's own stderr: it died on startup, so it never
got far enough to write the log a pointer would send you to.

## Passwords and passphrases

Plain `ssh` under `BatchMode=yes` can only use an agent or an unencrypted key:
there is nowhere to show a prompt. That made password-protected hosts
unreachable from the desktop app entirely.

`createAskpassChannel` (`packages/server/src/ssh/askpass-channel.ts`) fixes this
without shelling out to `zenity`/`kdialog`/`osascript`. It writes a tiny relay
program into a private `mkdtemp` directory (mode 0700) and points
`SSH_ASKPASS` at it. The program forwards SSH's prompt over a unix socket to
Paseo and prints the answer on stdout, which is the only channel SSH will take
a secret from. Naming an askpass program is also what drops `BatchMode=yes`
from the argument list.

The prompt is answered by:

- the CLI, with a `@clack/prompts` password prompt on the terminal;
- the desktop app, in `SshPasswordPromptHost` — mounted at the app root, not
  inside the modal the connect started from, since the answer is needed for as
  long as the connection takes and the user may navigate away.

That component renders through its own `createPortal`, using neither shared
dialog primitive, because it lands on top of whatever the user connected from.
Add host → Remote SSH is itself a `Modal`, so the collision is the normal case,
not the edge case.

`AdaptiveModalSheet` portals into an overlay root pinned at `z-index: 1`, below
the `9999` that react-native-web's `Modal` uses — so a prompt raised over the
chooser paints underneath it, visible but unanswerable.

Using a second `Modal` fixes the stacking and then **hangs the renderer**. Each
`Modal` installs a `ModalFocusTrap` that refocuses itself whenever focus lands
outside its subtree, and its re-entrancy guard only covers re-entering the _same_
trap. Two of them ping-pong focus forever on the main thread: 100% CPU, no
response to keyboard, and the debugger cannot even evaluate `1+1`. Note that
JSDOM cannot reproduce this — its focus model is too weak — so it has to be
caught in a real browser.

SSH's own prompt text is shown verbatim, because it is what says _which_ key or
_which_ account is being asked about.

**Declining is not an empty password.** SSH ignores the askpass program's exit
status and simply retries, so a dismissed dialog would come straight back. The
channel exposes an `AbortSignal` instead, and the caller tears the connection
down at once.

**One password, two connections.** Setup and tunnel are two `ssh` processes.
The channel replays an answer it already has to a _different_ process, so the
user is asked once. It never replays within one process: a repeated prompt
there means the last answer was wrong, and replaying it would burn the
remaining attempts on a password already known to be bad. Each `ssh` child is
tagged with a session id via `askpassEnv()` to tell the two apart.

**Host keys are confirmed, not typed.** With `BatchMode` off, OpenSSH routes
the "authenticity of host … (yes/no)" question through askpass as well.
`classifyAskpassPrompt` recognizes it and the UI shows the fingerprint with a
confirm button rather than a masked field.

Askpass is skipped on Windows, where the relay wrapper (a `/bin/sh` script)
will not run, and in the CLI when there is no terminal — a script gets the old
fail-fast `BatchMode` behaviour rather than hanging on a prompt nobody can see.

### Only when the user asks

The desktop prompts only for a connect the user started. Everything else runs
under `BatchMode`.

Without that rule a saved password host is a loop it cannot win. The runtime
reconnects on its own — at startup, on app resume, and on every backoff tick —
and each attempt would spawn its own `ssh`, its own askpass directory under
`/tmp`, and its own modal, then hold all three open for the ~110s the dialog
stands. Left alone for a few minutes that is a handful of live `ssh` processes,
eight or more channel directories, and a stack of prompts for a password the
user may not even have.

`packages/desktop/src/daemon/ssh-prompt-grants.ts` holds the permission.
Pressing Connect — in Add host → Remote SSH, or on the host's Connections page —
calls `grant_ssh_prompt`, which opens a window for that host;
`createDesktopAskpassChannel` returns null outside one, so `ssh` gets no
`SSH_ASKPASS` and therefore keeps `BatchMode=yes`.

The window is time-boxed, not counted. One press of Connect is not one `ssh`:
the app probes the host to learn its server id, the runtime then opens the
connection it keeps, and either may retry. A use count would break the ordinary
path the moment it was off by one, where an over-long window only risks a prompt
the user was already expecting. It is sized to the connection's own budget
(`sshConnectTimeoutMs`) doubled, and declining a prompt closes it early.

A connection that fails for want of a credential is tagged with
`SSH_AUTH_REQUIRED_PREFIX` rather than surfacing `ssh` stderr the user cannot
act on. The app matches that with `isSshAuthRequiredMessage` and shows the
host's Connections page a Connect button in place of the error.
