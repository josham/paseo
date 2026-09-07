import { runGitCommand } from "../../utils/run-git-command.js";

/**
 * Whether a worktree can be linked by relative path, which is what makes it
 * usable from inside a container.
 *
 * A worktree's `.git` file and its admin directory's `gitdir` file normally
 * hold absolute host paths, so inside a container the link dangles and the
 * agent's own git answers `fatal: not a git repository`. Created with
 * `--relative-paths` they hold relative ones instead, and
 * `devcontainer up --mount-git-worktree-common-dir` mounts the git directory
 * where those resolve.
 *
 * The catch is that relative links are a property of the *repository*: git
 * 2.48 added them, and enabling them writes `extensions.relativeWorktrees`,
 * which older git refuses to open at all —
 * `fatal: unknown repository extensions found: relativeworktrees`. That is not
 * scoped to the container, or even to the worktree: every workspace on that
 * repository lives with it, the main checkout and the host's own git included.
 *
 * So the first question is not whether the two gits can read a relative link,
 * but whether one is needed at all. It is not when the container mounts the
 * workspace at its host path — the absolute links already resolve there, and
 * marking the repository would buy nothing and cost every older git that
 * touches it. Only when the container remaps the path is the host's git version
 * asked, and only then is the repository marked.
 */

/** Relative worktree links, and the extension they set, arrived in git 2.48. */
const MIN_MAJOR = 2;
const MIN_MINOR = 48;
const GIT_VERSION_TIMEOUT_MS = 10_000;

let hostSupport: Promise<boolean> | null = null;

/** `git version 2.48.1` → `{ major: 2, minor: 48 }`. */
export function parseGitVersion(output: string): { major: number; minor: number } | null {
  const match = /git version (\d+)\.(\d+)/u.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function versionSupportsRelativeWorktrees(output: string): boolean {
  const version = parseGitVersion(output);
  if (!version) return false;
  return version.major > MIN_MAJOR || (version.major === MIN_MAJOR && version.minor >= MIN_MINOR);
}

/**
 * Whether the container will hold the workspace at its host path, read out of a
 * `devcontainer read-configuration` result for that same host folder.
 *
 * The CLI resolves the config the way `up` does — substitution, `extends`,
 * compose — and reports what the container ends up with: `workspaceFolder` is
 * the path it will work in, `workspaceMount` the bind that puts the files
 * there. Both have to name the host folder, because they are set separately and
 * routinely disagree: a config that asks for `${localWorkspaceFolder}` and
 * nothing else gets that folder as its working directory and the files mounted
 * at `/workspaces/<name>` anyway.
 *
 * A compose project reports no `workspaceMount` — the mount is in the compose
 * file, which the CLI does not resolve here — so there `workspaceFolder` is the
 * whole answer. That is the case this exists for.
 *
 * Only a config that mounts the workspace itself can answer yes, because the
 * CLI's own mount always targets `/workspaces/<name>`. That is the same thing
 * that makes the answer safe: `--mount-git-worktree-common-dir` mounts the git
 * directory only alongside that default mount, so a container reaching this
 * point is mounting the common dir itself or not at all, and the relative form
 * would have bought it nothing.
 *
 * Anything unreadable answers false, which keeps the relative form. That works
 * in either container, so an unclear answer costs the extension rather than the
 * agent's git.
 */
export function readConfigurationKeepsHostPath(stdout: string, hostFolder: string): boolean {
  // The CLI logs to stderr and prints one JSON object on stdout, but scan
  // backwards for it anyway: a stray banner on stdout must not decide this.
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let workspace: { workspaceFolder?: unknown; workspaceMount?: unknown };
    try {
      workspace = JSON.parse(line)?.workspace ?? {};
    } catch {
      continue; // Not JSON — keep scanning backwards
    }
    const host = normalizeFolder(hostFolder);
    const { workspaceFolder, workspaceMount } = workspace;
    if (typeof workspaceFolder !== "string") return false;
    if (normalizeFolder(workspaceFolder) !== host) return false;
    if (workspaceMount === undefined) return true;
    if (typeof workspaceMount !== "string") return false;
    return mountTarget(workspaceMount) === host;
  }
  return false;
}

/** `type=bind,source=/a,target=/b` → `/b`. Null when it names no target. */
function mountTarget(mount: string): string | null {
  for (const part of mount.split(",")) {
    const [key, ...value] = part.split("=");
    if (key.trim() === "target") return normalizeFolder(value.join("="));
  }
  return null;
}

/** Trailing separators only. The paths being compared come from one resolver. */
function normalizeFolder(folder: string): string {
  return folder.replace(/[\\/]+$/u, "");
}

/** The daemon's own git. Cached — it does not change while we run. */
export async function hostGitSupportsRelativeWorktrees(): Promise<boolean> {
  hostSupport ??= runGitCommand(["--version"], {
    cwd: process.cwd(),
    timeout: GIT_VERSION_TIMEOUT_MS,
  })
    .then((result) => versionSupportsRelativeWorktrees(result.stdout))
    .catch(() => false);
  return hostSupport;
}
