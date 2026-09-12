# Dev Containers

A workspace can run its agents and terminals inside a container instead of on the host. The user picks a **container backend** per workspace; `null` means Host (no isolation) and is the default. Today the only backend is `devcontainer`, which shells out to [`@devcontainers/cli`](https://github.com/devcontainers/cli) and Docker.

## The pieces

| Piece                                         | Responsibility                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devcontainer/container-backend.ts`           | `ContainerBackend` interface — lifecycle (`up`/`stop`/`restart`/`rebuild`), availability, config detection, `ContainerInfo` for the UI                          |
| `devcontainer/devcontainer-service.ts`        | The one implementation: runs `devcontainer up`, parses its JSON result, inspects the container                                                                  |
| `devcontainer/container-backend-registry.ts`  | Backend ID → backend. `listAvailable(cwd)` feeds the workspace's backend picker                                                                                 |
| `devcontainer/launch-strategy.ts`             | `ProcessLaunchStrategy` — the seam every spawn goes through. `LocalLaunchStrategy` spawns on the host; `ContainerExecLaunchStrategy` execs into the environment |
| `devcontainer/launch-strategy-registry.ts`    | Which workspace has which strategy, plus the pending-activation gate agents and terminals await                                                                 |
| `devcontainer/container-probe-coordinator.ts` | The new-workspace screen's probe: throwaway container, provider entries, cancellation and de-duplication                                                        |

Adding a backend means implementing `ContainerBackend`, including a `createStrategy` that returns a `ContainerExecSpec`. Nothing outside `devcontainer/` knows about Docker.

## Container identity

Every container carries the key it belongs to, so the in-memory key and the container's real identity can never disagree:

```
devcontainer.local_folder = <workspace folder>     # what the CLI would infer
devcontainer.config_file  = <devcontainer.json>    # what the CLI would infer
paseo.container           = <workspaceId | probe:<uuid>>
paseo.owner               = workspace | probe
paseo.config_hash         = <hash of devcontainer.json + the build files it names>
```

`--id-label` **replaces** the labels the CLI infers from the workspace folder, so the folder ones are re-supplied verbatim — other devcontainer tooling still recognises the container, and label filters are subset matches. The Paseo labels are what adoption queries on (`docker ps --filter label=paseo.container=<key> --filter label=devcontainer.local_folder=<folder>`), which is what makes the following true:

- Two workspaces on the same directory get two containers instead of silently sharing one — for an image or Dockerfile config. A **compose** config is shared whatever these labels say, because compose owns identity there: see [A compose project is shared](#a-compose-project-is-shared).
- A probe cannot adopt — or stop — a workspace's container, even for the same directory. Before this, probing a directory that already had a running workspace container would `docker stop` it out from under the running agents.
- Abandoned probe containers are identifiable, so the daemon can reap them at startup.

The cost: these labels are a CLI convention we reproduce rather than a documented contract, and VS Code opening the same folder no longer deterministically lands on the same container as Paseo. `real backend: a probe and a workspace on the same directory get separate containers` is the test that fails if the convention changes.

## What runs where

| Work                                     | Where it runs | Why                                                                                            |
| ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Agent processes                          | Container     | The point of the feature                                                                       |
| Terminals                                | Container     | Same shell the agent sees                                                                      |
| Agent-requested commands (ACP terminals) | Container     | The agent asks for them in its own workspace                                                   |
| Provider catalog / model probes          | Container     | The container's tool version is the one that will run, so the host's model list would be wrong |
| Git                                      | **Host**      | See below                                                                                      |
| Container lifecycle itself               | Host          | `devcontainer up`, `docker stop`, `docker inspect`                                             |

### Git runs on the host

`runGitCommand` never routes through a launch strategy. The workspace folder is bind-mounted, so host git operates on exactly the same files, and:

- Worktree lifecycle (add/remove) happens before any container exists.
- Credentials, SSH agent, and the user's git config live on the host.
- A stopped container would otherwise mean no branch, no status and no Changes view at all.

If you are tempted to make git container-aware, that is the list to answer first.

### The agent's git, which is a different question

Paseo's git running on the host says nothing about the agent's. An agent is a shell inside the container and will run `git status`, `git diff` and `git commit` of its own accord. For a plain clone that works — `.git` is a real directory inside the mount, and nothing in it names the host. For a **linked worktree** it does not, because a worktree is three paths pointing at each other and two of them are absolute:

```
wt/.git                          →  /repo/main/.git/worktrees/wt   ← absolute
main/.git/worktrees/wt/commondir →  ../..                          ← relative
main/.git/worktrees/wt/gitdir    →  /repo/wt/.git                  ← absolute, points back
```

Only the workspace folder is mounted, so the first dangles and the agent gets `fatal: not a git repository`.

`devcontainer up --mount-git-worktree-common-dir` mounts the git directory where the relative link resolves — `main/.git` at `/workspaces/main/.git`, for a worktree mounted at `/workspaces/wt`. It does nothing at all when it does not apply: no warning, no error, `outcome: success`, git still dead. Two things switch it off, and only one of them is documented:

- The worktree's links are **not** relative.
- The config mounts the workspace **itself** — an explicit `workspaceMount`, or a compose project. The git mount rides on the CLI's own default mount and is dropped with it. Verified by inspecting the mounts of containers started both ways.

So the decision is made at creation, from three facts:

- **Is this a worktree?** The new-workspace request says so — it is what the user chose in the isolation picker. Nothing stats the directory for it, which would also read a submodule's `.git` file as a worktree's.
- **Does the container keep the workspace at its host path?** Then absolute links already resolve inside it and nothing else is asked. Only a config that mounts the workspace itself can, since the CLI's own mount targets `/workspaces/<name>` — which is also why the answer is safe: such a container was never getting the CLI's git mount, so relative links would have bought it nothing. `devcontainer read-configuration` answers without starting anything, read on the source checkout because the worktree does not exist yet: `workspaceFolder` is where the container works, `workspaceMount` where the files land, and **both** have to name the host folder. They disagree more often than not — a config asking for `${localWorkspaceFolder}` and nothing else gets that folder as its working directory and the files under `/workspaces/<name>` anyway. A compose project reports no mount, because compose owns it, so there the folder is the whole answer.
- **Can git read relative links?** Only the **host's** git is checked. That looks like an omission and is not: linking one worktree relatively marks the whole _repository_ with `extensions.relativeWorktrees`, so the choice is not per-container. Every workspace on that repository lives with it — sibling worktrees, the main checkout, and whichever containers each of them runs in — so asking one image would answer for all of them.

If the workspace has a container backend that remaps the workspace path, and the host's git is 2.48+, the worktree is created with `--relative-paths`; a worktree's container starts with `--mount-git-worktree-common-dir` either way. Otherwise it is created the ordinary way — which is what a path-preserving container wants, and which for a remapped one leaves the agent's git seeing nothing, as before.

**What an old git in the image does then.** It refuses the repository outright:

```
fatal: unknown repository extensions found:
	relativeworktrees
```

and it refuses it for **every workspace on that repository**, not only the worktree — including a plain non-worktree workspace on the main checkout, and the user's own git on the host. A separate clone is unaffected, because the extension is per-repository and clones do not inherit it.

This is the cost of the feature being repo-wide, and it is why the path question is asked first. Debian bookworm ships git 2.39, trixie 2.47, and bookworm-backports has no git package at all, so an image on any of them is below the line and cannot be argued up to it. A container that keeps the host path gives the agent a working git without the extension; only one that remaps the path is worth marking the repository for, and there an image that old could not have used a relative worktree anyway.

**Worktrees are also locked.** `git worktree prune` deletes the admin directory (HEAD, index, reflog) of any worktree whose `gitdir` names a missing path, and `git gc` runs it on a three-month timer. A container mounts one worktree, so every _sibling_ reads as missing from inside it — an agent running `git gc` there would delete another workspace's state, and `git worktree repair` cannot undo it. `git worktree lock` at creation makes that impossible.

The lock cuts both ways, because prune is also how a _stale_ registration gets healed: a worktree whose directory went away without git being told keeps its branch pinned, and restore depends on clearing it. So the paths that heal one call `unlockStaleWorktrees` first, which unlocks only entries whose directory is already gone. Removing a Paseo worktree by hand now takes `git worktree remove -f -f` or an unlock; the lock reason says so.

## Gotchas that cost real time

- **`docker exec` argument order.** `exec [OPTIONS] CONTAINER COMMAND [ARG...]`. Every flag has to precede the container ID; anything after it is the command. `ContainerExecSpec` splits `optionArgs` from `targetArgs` so assembly can't get this wrong — don't flatten it back into one array.
- **`-i` or nothing works.** Agent processes are driven over stdin. Without `-i` the process sees EOF immediately and exits, which surfaces as "stream ended before terminal result" rather than anything about stdin.
- **`-t` only for terminals.** A TTY on a piped agent process breaks its stdout framing. `wrapCommand({ interactive: true })` adds it; `spawn` never does.
- **`-e KEY` (no `=value`) unsets a variable only while `docker` itself has no `KEY`.** When the exec binary's own environment has `KEY`, Docker copies that value into the container instead. Paseo sets some variables to `undefined` to clear them (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, …), and the container may set them itself, so they travel as a bare `-e KEY` and `resolveExecClientEnv` removes each one from the environment `docker` runs with. That environment is otherwise the daemon's, so without the removal the container receives the daemon's value of every key the caller removed.
- **The pty's cwd is a host path.** For a container terminal, node-pty spawns `docker` on the host; the container-side directory travels in `-w`. Handing the pty a container path makes it fail to spawn.
- **The agent must be on the container's PATH.** Whether it is installed in the image or arrives through a bind mount is the image's business — Paseo only asks the container to resolve the name. The daemon's `process.execPath`, an SDK's bundled `cli.js`, and a `which`-resolved host binary are host paths and are never used for an isolated launch. Claude specifically: `pathToClaudeCodeExecutable` is set to whatever the container resolved, which has no JS extension either way, so the SDK treats it as a native binary and passes only CLI flags.
- **"Not on the PATH" while the terminal runs it fine.** `docker exec` starts a bare process, so its PATH is only what the image declares — often just `/usr/local/bin:/usr/bin`. A terminal runs a _shell_, which adds whatever `~/.profile` and `~/.bashrc` put there, and that is where `~/.local/bin`, nvm, and most per-user installs live. So `resolveExecutable` asks the environment's own login shell (`-lic`, then `-ic`, then plain `-c`), and returns the **absolute path** it prints — which also means the launch itself no longer depends on the exec's PATH. Startup files that print banners are handled by marking the answer line rather than reading whatever came out last.
- **`resolveExecutable` checks before launching.** Cached per command for the container's lifetime, but **only on success**: a container still finishing its start would otherwise be remembered as "agent missing" until it was rebuilt. Without the check at all, a missing agent surfaces as `exited with code 127` plus a runtime message about `crun`, which says nothing about what to fix.
- **The agent's own subprocesses still get the image's PATH.** Only the agent binary is resolved through the shell. A tool the agent shells out to that lives in a startup-file PATH entry will not be found, even though the same command works in a container terminal.
- **`isAvailable()` takes the launch strategy, it is never skipped.** A provider that gates on a binary answers for the container; one that gates on something else — an opt-in env var, a disabled provider — still gets to say no. Skipping the check for isolated launches (an earlier attempt at the same problem) let a dev-only provider whose `fetchCatalog` never resolves into the new-workspace probe, which then took the full 60s catalog timeout instead of ~3s.
- **"Provider 'claude' is not available" names a symptom, not a cause.** `isAvailable()` returns a bare boolean, so a missing binary, a workspace path `docker exec -w` cannot enter, and a container that never came up all reach the user as that one sentence. Two things make it diagnosable: the container check logs the exec failure it swallowed, and the snapshot manager logs which copy of the tool it asked about (`scope`, `cwd`, `isolated`) whenever a provider goes unavailable. Read `daemon.log` before anything else — and note that `provider diagnostic` probes the **host**, so it will report `Status: Ready` while every container probe is failing.
- **The agent authenticates inside the container.** `~/.claude`, `~/.codex` and friends are the container's, not the host's. Mount or provision them in devcontainer.json.
- **Share credentials by mounting the directory, never the file.** Docker binds a single file by inode, and providers rewrite credentials atomically — temp file, then rename — on every token refresh and on `/login`. The rename gives the host path a new inode, and the mount still resolves the old one, so the two copies drift apart permanently. What that looks like: the container's token stops refreshing, and `/login` on the host appears to do nothing because the container cannot see the file it wrote. Mounting `~/.claude` follows the rename; mounting `~/.claude/.credentials.json` does not. Sharing one OAuth session between host and container also means two independent writers refreshing it, so a container with its own login is the calmer arrangement.
- **The terminal shell comes from the container.** `resolveDefaultShell()` asks the environment for `$SHELL`, falling back to the user's passwd login shell and then to `/bin/sh`. Set `containerEnv.SHELL` in devcontainer.json to pick a specific one. The host's `$SHELL` is never used for a container terminal — `/opt/homebrew/bin/fish` doesn't exist in a Debian image.

## Environment variables

`resolveContainerEnvEntries` decides what crosses the boundary:

- **Explicit overlays** (`envOverlay`) always cross, including `undefined` values, which unset.
- **Base env entries cross only when the caller changed them** relative to the daemon's own `process.env` — an added API key, a deleted `NODE_OPTIONS`, `PASEO_AGENT_ID`. An unchanged value carries no intent.
- **`PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`, …** never cross. The image owns them; overriding `PATH` breaks command resolution immediately.

Host environment variables reach the container the way the Dev Container spec intends: `containerEnv` in devcontainer.json, which can pull from the host with `${localEnv:NAME}`. Paseo does not smuggle the daemon's environment past that. Three things decide whether a credential put there actually reaches an agent:

- **`containerEnv`, not `remoteEnv`.** `containerEnv` is baked into the container's own environment, so the bare `docker exec` behind an agent inherits it. `remoteEnv` never lands in that environment, so it never arrives.
- **No shell is in the path.** An agent execs the provider binary directly and reads no `/etc/profile.d`, no `~/.bashrc` and no `BASH_ENV`. A secret exported by a shell startup file therefore reaches a container _terminal_ and not the agent. A wrapper script around the binary that reads the secret itself is what bridges the two — and keeps the value out of `docker inspect`, which `containerEnv` does not.
- **`${localEnv:NAME}` resolves against the daemon's environment**, not your shell's: the daemon is what runs `devcontainer up`. For a systemd-managed daemon, that means whatever its `EnvironmentFile` holds.

## Reaching the daemon from inside

The daemon binds `127.0.0.1` by default, which inside a container means the container itself. Two features depend on reaching back:

- The agent MCP endpoint (`/mcp/agents`)
- Terminal activity reporting (`PASEO_TERMINAL_ACTIVITY_URL`)

`ContainerExecLaunchStrategy.resolveDaemonUrl()` rewrites a loopback URL to the container's default gateway (captured as `hostGatewayAddress` at `up` time). That only helps if the daemon is actually listening on something other than loopback — bind it to `0.0.0.0` to enable these features for container workspaces. When there is no reachable address, `AgentManager` **drops** the injected MCP server and logs a warning rather than handing the agent a URL that costs it a full tool-call timeout per call.

## A stopped container is not an error

`ContainerNotRunningError` separates two readings of "this workspace wants a
container and there isn't one":

- **Agent and terminal creation refuse.** Running them anyway would put them
  outside the container the user asked for.
- **A catalog refresh reports the providers as `unavailable`.** The container's
  tool list is unknown until it starts, which is not a failure the user can act
  on — and marking every provider `error` turns the model picker red for a
  workspace that is merely stopped.

Relatedly, a snapshot refresh is answered for whichever workspace owns the
directory, so the new-workspace screen has to say which environment it means:
`refresh_providers_snapshot_request` with `containerBackend: null` asks for the
host explicitly. Without it, pointing that screen at a directory that already
holds a stopped container-backed workspace answers for _that_ workspace.

## No fallback to the host

If a container is required and not running, agent and terminal creation **fail**. They never quietly run on the host — the user asked for isolation, and silently not providing it is worse than an error. Concretely:

- `awaitStrategy` blocks on a pending activation and rejects if it never arrives.
- Every failure path calls `deactivateContainer`, which resolves waiters. A path that forgets leaves agent creation hanging forever.
- A provider that doesn't honor the launch strategy is refused on container workspaces via the `supportsIsolatedLaunch` capability. OpenCode does not honor it yet; Claude, Codex, OMP, Pi, and ACP providers do.

## The new-workspace probe

Picking a container backend for a workspace that doesn't exist yet raises a question only the container can answer: which providers are installed, and what models do they offer? The daemon answers it by building a throwaway container, listing each provider inside it, and removing the container again (`ContainerProbeCoordinator`).

Things worth knowing before touching it:

- **The probe response is the whole answer.** `container.probe.response` carries the provider entries, and the client writes them straight into the snapshot cache the model picker reads. It must not follow up with a snapshot refresh: the probe container is already gone, so that refresh would resolve to the host and overwrite good container results with host ones (or with an error per provider).
- **The shared snapshot is never written.** A probe uses a private snapshot key, so workspaces already open on that directory keep their own provider list.
- **Everything here is cwd-scoped, not workspace-scoped.** No workspace record exists yet, and none is needed: the model picker reads the snapshot by `cwd` (`useAgentFormState` → `useProvidersSnapshot({ cwd })`), which is where the probe's entries are applied. Note that `ProviderSnapshotManager`'s `scope: "workspace"` means "scoped to a cwd" as opposed to global/home scope — it does not imply a workspace exists. The probe must use it because that is the only scope carrying a `launchStrategy`; global scope would silently probe the host. The one thing that genuinely needs a workspace record is resolving which container to use, which is why the probe passes its strategy in directly instead of going through the cwd → workspaceId → backend resolver.
- **`isAvailable()` is skipped for isolated launches.** It inspects the host, so for a container it answers about the wrong machine — a tool present only in the image would read as missing. Fetching the catalog inside the container is the test instead.
- **Probes are cancellable and de-duplicated.** Picking a different backend supersedes the running probe, an identical request joins it rather than building a second container, and disconnecting cancels everything the session started. Cancellation kills the CLI and removes whatever it built.
- **Progress is streamed.** `devcontainer up` output arrives as `container.probe.progress` events while it runs, because a first build takes minutes.
- **The client debounces** dropdown changes and caches per `(cwd, backend)`, so toggling Host ↔ Dev Container doesn't re-probe.

Probe containers are deliberately **not** adopted by the workspace that gets created afterwards. Labels are immutable, so a container created as `paseo.owner=probe` would be serving a workspace while claiming to be scratch — the next daemon start would fail to find it, build a second one, and orphan the first. The cost is that the container is built twice; `postCreateCommand` re-runs on the workspace's own container.

## Lifecycle

- Containers **outlive the daemon**. On restart, `isAlreadyRunning` finds one by its `paseo.container` + `devcontainer.local_folder` labels and adopts it instead of rebuilding — same as VS Code's behavior. Both labels are matched: the key alone would also find a container created for that key against a different folder. A compose container may carry neither label; see [A compose project is shared](#a-compose-project-is-shared).
- `up()` re-inspects a cached handle before reusing it, because containers get stopped or rebuilt from outside Paseo.
- **Restart and rebuild reopen the workspace's agents.** A live session holds the strategy it opened with, and that strategy names the container by ID, so after a rebuild its next turn would fail with `No such container`. The reopen resumes from the provider's transcript, which a rebuild keeps only if the config mounts it at the path the agent wrote it to (see [Transcripts live where the agent ran](#transcripts-live-where-the-agent-ran)).
- **Each agent's runtime is stopped before the container goes.** Killed along with it instead, the provider reported an unexplained `exit code 137` turn failure on an agent the user had only asked to rebuild around, ten seconds after the SIGTERM that PID 1 ignores. `AgentSession.stopRuntime` is optional; a provider that does not implement it keeps the old behaviour.
- **Archiving a workspace stops its container**, as does switching the workspace off that backend. Unarchiving starts it again.
- Availability (`devcontainer` + `docker` on PATH) is cached for 60s. Docker is routinely started after the daemon, so a negative answer must not stick for the process lifetime.
- Probe containers are removed when their probe ends, and any that survive a daemon crash are reaped at the next startup (`removeAbandonedProbeContainers`).
- **Staleness is judged on the build inputs, and on the container itself.** `getConfigHash` folds in the Dockerfile and compose files `devcontainer.json` names, because editing those changes what a container would be while the config's own bytes stay identical. That hash is stamped on the container as `paseo.config_hash`, and the check prefers what the container says it was built from over the hash persisted on the workspace — a workspace records its hash at creation and then adopts whatever container already existed, so the record can agree with the config while the container predates both. A container carrying no stamp was built elsewhere, and there the persisted hash is all there is. The config directory is watched, and a change emits `container.config_changed` so the client can offer a rebuild.
- **`devcontainer up` output goes to `daemon.log`** for every start, restart and rebuild, at info. Only probes stream it to a client, so without this a build of any length left nothing behind but the line saying it had finished.
- **Container details for the UI are captured when the container starts**, not queried per read. The workspace badge and the sidebar's container icon show backend, image, container name, user and start time, and a workspace descriptor is rebuilt on every workspace update — so a descriptor that queried the runtime, or that emitted an update once its answer arrived, would loop and burn a `docker inspect` per cycle. `getContainerInfo(key)` is a synchronous read of what `up` recorded.

## A compose project is shared

Paseo keys containers by workspace id, and for an image or Dockerfile config that
is the whole story: each workspace gets its own container. A **compose** config
does not work that way, and the difference is not Paseo's to choose. The CLI names
the project after the workspace folder — `${basename(folder)}_devcontainer`, unless
the compose file declares a top-level `name:` — and from there compose owns
identity. Two things follow.

**Every workspace on one checkout shares a container.** The workspace id buys no
isolation here. That is also what VS Code does, and usually what is wanted: one
database for one checkout.

**Two checkouts whose folders share a name resolve to the same project**, so `up`
hands back the container already serving the first one, mounts and all — an agent
would run against another workspace's files while every surface reports it attached
to this one. `assertContainerServesFolder` compares the `devcontainer.local_folder`
label on what came back against the folder that was asked for and refuses on a
mismatch, naming the folder actually being served. The naming is checked after the
fact rather than predicted, because the derivation belongs to the CLI while the
label on the container in hand is a fact. Fix it by renaming the directory or
giving the project its own `name:`.

A compose container may also carry **none of Paseo's labels**, because `up` reuses
whatever compose already had and only the creator's `--id-label`s are on it —
a container built by VS Code or a bare `devcontainer up` has no `paseo.container`.
`findRunningContainerId` falls back to matching the folder for a container compose
owns, guarded to one that is unclaimed or already this key's, so adoption and
`stop` stop missing it.

**A rebuild recreates the whole project**, not just the workspace's service. Data
in a named volume survives, since nothing here runs `down -v`; a service with an
anonymous volume loses it. Worth knowing before adding a service that keeps state.

## Transcripts live where the agent ran

Providers keep session transcripts outside the workspace: Claude in
`~/.claude/projects/<encoded-cwd>`, omp in its session directory. Paseo reads
them to list importable sessions and to replay a resumed conversation.

For a container workspace those files are the **container's**. Two things about
them differ from the host, and both matter:

- They are under the **container's HOME**, which is its user's, not yours.
- Claude's directory name encodes the **cwd the agent saw** — `/workspaces/app`,
  not `/home/you/app` — so even a mounted `~/.claude` would not line up.

`LaunchFileSystem` (`devcontainer/launch-filesystem.ts`) is the seam: the host
implementation is plain `node:fs`, the container one runs the equivalent POSIX
commands (`find`/`stat`, `cat`, `head -c`, `tail -c`, `rm -rf`) through the
workspace's launch strategy. Listing is a single `find … -exec stat` rather than
a walk plus one exec per file. Claude, omp and Pi all read through it, so their
import lists, replayed history, and Claude's ephemeral-transcript sweep all
address the environment the agent actually ran in.

### Files a provider is configured through

The same seam writes, for the mirror-image reason. Pi is configured by paths it
opens itself — `--mcp-config` and `--extension`, the latter carrying the system
prompt — and the daemon's `/tmp` is not the container's, so a host temp file
would be a path Pi cannot open. `makeTempDir` and `writeFile` put them where Pi
will look (`mktemp -d`, then `mkdir -p && cat >` over stdin). Two rules hold
there:

- **Writes throw where reads answer null.** A config file that never landed
  surfaces much later as an agent that quietly lost half its tools.
- **Credentials get their mode in the same command.** The MCP config names the
  daemon's endpoint and auth token, so `writeFile` takes a `mode` and the
  container path chmods in the same `sh -c` — never a window where it is
  world-readable between two execs.

Pi's _global_ config is read the same way: `~/.pi/agent/mcp.json` is merged
into the generated one, and for a container workspace it is the container's
copy under the container's HOME, not the daemon's.

Both are local disks; what differs is the cost of reaching one. A host read is
a `readFileSync` (~1ms); a container read is a process spawn (~75ms measured
against podman). That is why Claude's history load became async — 75ms of
blocked event loop per resumed session, in a constructor, would stall every
other session on the daemon — and why the listing is a single `find` rather
than a walk plus a stat per file.

Async would normally leave a standing hazard — `persistedHistory` and the
rewind anchors not yet populated when the constructor returns, and a reader
that forgets to wait seeing an empty history rather than an error. Instead the
load happens **before the session escapes its factory**:
`ClaudeAgentClient.resumeSession` awaits `hydratePersistedHistory()`, and the
one path that swaps the session id mid-life (`rebindConversationSession`, via
rewind's now-awaitable `setSessionId`) awaits its own reload. There is no
window in which a caller holds a session whose history is still arriving, so
no reader needs to remember anything.

## Testing

`packages/server/src/server/container-management.test.ts` holds both layers:

- Unit tests with a mock backend for session wiring, status, and the strategy's own logic.
- `dockerTest(...)` cases that run a real `devcontainer up` against `alpine:latest` and assert commands actually execute inside the container. They skip when Docker isn't on PATH.

The real-container tests are the ones that catch exec-argument and environment mistakes; the unit tests cannot.

For provider-side work there is a third option:
`devcontainer/test-utils/fake-isolated-strategy.ts` reports `isIsolated`, maps
paths the way a container does, and runs the resulting POSIX commands on the
host. Most container support is a question of _which_ environment a provider
addresses — where it spawns, where it writes the files the agent opens, where
it looks for transcripts — and that is answerable without a runtime. Pi's
container tests use it; what it cannot tell you is whether a real image
behaves the same, which is what the docker-gated tests are for.

## Known gaps

- **OpenCode** doesn't route through the launch strategy, and can't with the current seam: it isn't a subprocess Paseo spawns but a shared HTTP server (`opencode serve --port N`) that every workspace multiplexes over by passing `directory`. Containerizing it means a server per container, a way for the daemon to reach a port inside it, container paths in `directory`, and its `$PASEO_HOME/opencode-home` state moving too. Container workspaces refuse it for agent runs, and its importable-session list comes back empty there rather than offering the host's sessions.
- **Shell integration and the bundled `paseo` hook CLI** are injected into the host-side environment (`buildTerminalEnvironment` prepends host paths), so a container terminal doesn't get zsh integration or the hook CLI on its PATH.
- **Provider catalogs are fetched for every configured provider** during a probe, so a machine with several configured providers pays several in-container spawns per probe. Fetching only the selected provider's catalog would need the probe container to survive, which option B deliberately gives up.
- **The provider snapshot is keyed by cwd**, so two workspaces sharing a directory with different backends overwrite each other's provider list. Fixing it properly means keying snapshots by workspace, which is a refactor beyond the container feature. The probe itself no longer contributes to this: it never writes the shared snapshot.
- **A subdirectory workspace mounts the whole repository.** The devcontainer CLI's `--mount-workspace-git-root` defaults to **true**, and Paseo does not override it, so pointing a workspace at `repo/packages/app` mounts `repo` at `/workspaces/repo` and sets the workspace folder to `/workspaces/repo/packages/app` inside it. That is how git works in those containers — and it is more of the host than the workspace folder. `ContainerExecSpec.hostWorkspaceFolder` is still the workspace cwd, so `resolveCwd` treats a sibling directory as outside the workspace and falls back to the workspace folder, even though the sibling is genuinely present in the container.
- **Build progress reaches no client outside the probe flow.** `up`, `restart` and `rebuild` log the CLI's output to `daemon.log`, but emit nothing, so a user watching a first build sees a spinner for minutes with no way to tell slow from stuck. The probe path's `container.probe.progress` is the shape a fix would take, plus a feature gate for it.
- **A compose workspace cannot be isolated from the other workspaces on its checkout.** Identity belongs to compose, which derives it from the directory name. Paseo could take that over by generating a compose file carrying a `name:` of its own and handing the pair to the CLI through `--override-config`, which does work — at the cost of duplicating every sibling service and every project-scoped volume, so a fresh and empty database per workspace. It would have to be opt-in, and is not built.
- **A worktree created inside a container is registered with container paths.** The admin directory persists in the host repo, but its `gitdir` names a path only the container had, so the host reads it as prunable and refuses to check that branch out (`already used by worktree at /workspaces/…`). If the worktree also landed outside the mount, its files are gone with the container. Paseo has no record of it either way.
