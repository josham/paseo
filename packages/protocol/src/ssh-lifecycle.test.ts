import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEnsureScript,
  describeEnsureFailure,
  ENSURE_EXIT,
  NODE_VERSION_MARKER,
  PROGRESS_MARKER,
  resolveRemoteDaemonSpec,
  shellPath,
} from "./ssh-lifecycle.js";

const spec = resolveRemoteDaemonSpec({ host: "build-box", daemonPort: 6767 });

/** Run the ensure script the way SSH does: piped to `sh` on stdin. */
function runEnsureScript(script: string, env: Record<string, string>) {
  try {
    execFileSync("/bin/sh", {
      input: script,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? null, stderr: failure.stderr ?? "" };
  }
}

describe("remote daemon spec", () => {
  it("fills in the paths and version a host did not pin", () => {
    expect(resolveRemoteDaemonSpec({ host: "build-box", daemonPort: 7777 })).toEqual({
      host: "build-box",
      daemonPort: 7777,
      remoteHome: "~/.paseo",
      installDir: "~/.paseo/cli",
      version: "latest",
    });
  });

  it("keeps the host's own paths and version", () => {
    expect(
      resolveRemoteDaemonSpec({
        host: "build-box",
        daemonPort: 6767,
        remoteHome: "/srv/paseo",
        installDir: "/opt/paseo",
        version: "0.7.2",
      }),
    ).toEqual({
      host: "build-box",
      daemonPort: 6767,
      remoteHome: "/srv/paseo",
      installDir: "/opt/paseo",
      version: "0.7.2",
    });
  });
});

describe("remote paths", () => {
  it("expands a leading tilde outside the quotes so the remote shell resolves it", () => {
    expect(shellPath("~/.paseo")).toBe(`"$HOME"/'.paseo'`);
    expect(shellPath("~")).toBe(`"$HOME"`);
  });

  it("keeps a quote in a path from ending the quoting", () => {
    expect(shellPath("/srv/josh's paseo")).toBe(`'/srv/josh'\\''s paseo'`);
  });
});

describe("ensure script", () => {
  it("is valid POSIX shell even with awkward paths", () => {
    const script = buildEnsureScript(
      resolveRemoteDaemonSpec({
        host: "build-box",
        daemonPort: 6767,
        remoteHome: "/srv/josh's paseo",
        installDir: "~/paseo cli",
        version: "0.7.2",
      }),
    );
    expect(() => execFileSync("/bin/sh", ["-n"], { input: script, stdio: "pipe" })).not.toThrow();
  });

  it("stops with an actionable message when the host has no Node.js", () => {
    const result = runEnsureScript(buildEnsureScript(spec), { PATH: "" });
    expect(result.status).toBe(ENSURE_EXIT.nodeMissing);
    expect(result.stderr).toContain(
      `${PROGRESS_MARKER}Node.js is required on build-box to run the Paseo daemon.`,
    );
  });
});

describe("a Node too old to run Paseo", () => {
  let shimDir: string | null = null;

  afterEach(() => {
    if (shimDir) rmSync(shimDir, { recursive: true, force: true });
    shimDir = null;
  });

  /**
   * A `node` that behaves like 18.x: it runs, but rejects the
   * `--disable-warning` flag in Paseo's launcher shebang, and reports nothing
   * listening on the daemon port.
   */
  function installOldNodeShim(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-node-shim-"));
    shimDir = dir;
    const shim = path.join(dir, "node");
    const body = [
      "#!/bin/sh",
      'case "$1" in',
      "  -v) echo v18.20.4; exit 0 ;;",
      "  --disable-warning=*) exit 9 ;;",
      "esac",
      "exit 1",
      "",
    ].join("\n");
    writeFileSync(shim, body, { mode: 0o755 });
    chmodSync(shim, 0o755);
    return dir;
  }

  it("stops before installing anything, naming the version it found", () => {
    const result = runEnsureScript(buildEnsureScript(spec), { PATH: installOldNodeShim() });

    expect(result.status).toBe(ENSURE_EXIT.nodeTooOld);
    expect(result.stderr).toContain(
      `${PROGRESS_MARKER}Node.js on build-box is v18.20.4, too old to run Paseo.`,
    );
    expect(result.stderr).toContain(`${NODE_VERSION_MARKER}v18.20.4`);
    // Nothing should be downloaded onto a host that cannot run it.
    expect(result.stderr).not.toContain("Installing Paseo");
  });
});

describe("failure messages", () => {
  it("tells the user what to install when Node.js is missing", () => {
    expect(
      describeEnsureFailure({
        spec,
        exitCode: ENSURE_EXIT.nodeMissing,
        stderr: "",
      }),
    ).toBe(
      "Node.js is required on build-box to run the Paseo daemon. " +
        "Install Node.js (https://nodejs.org) on the remote host and retry.",
    );
  });

  it("tells the user which Node the host has and what Paseo needs", () => {
    expect(
      describeEnsureFailure({
        spec,
        exitCode: ENSURE_EXIT.nodeTooOld,
        stderr: `${NODE_VERSION_MARKER}v18.20.4\n`,
      }),
    ).toBe(
      "Node.js on build-box is v18.20.4, which is too old to run Paseo. " +
        "Install Node.js 20.11 or newer on the remote host and retry.",
    );
  });

  it("shows why the daemon died rather than pointing at a log it never wrote", () => {
    const message = describeEnsureFailure({
      spec,
      exitCode: ENSURE_EXIT.notReady,
      stderr: "node: bad option: --disable-warning=DEP0040\n",
    });

    expect(message).toContain("node: bad option: --disable-warning=DEP0040");
    expect(message).not.toContain("daemon.log");
  });

  it("falls back to the log when the daemon left nothing on stderr", () => {
    expect(describeEnsureFailure({ spec, exitCode: ENSURE_EXIT.notReady, stderr: "" })).toContain(
      "Check ~/.paseo/daemon.log on the remote host.",
    );
  });

  it("surfaces ssh's own stderr for an authentication failure", () => {
    expect(
      describeEnsureFailure({
        spec,
        exitCode: 255,
        stderr: "Permission denied (publickey).\n",
      }),
    ).toBe("SSH connection to build-box failed.\nPermission denied (publickey).");
  });
});
