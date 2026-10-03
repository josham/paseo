import { describe, expect, test } from "vitest";

import { resolveDaemonLaunchCommand } from "./local-daemon.js";

// The detection itself asks the machine, so what is worth pinning is the shape of
// the launch it produces: a wrapper has to keep the daemon's own argv intact, or
// the supervisor entrypoint is invoked with the wrong arguments and the failure
// only shows up as a daemon that never becomes ready.
describe("resolveDaemonLaunchCommand", () => {
  const execPath = "/usr/bin/node";
  const args = ["--import", "tsx", "/repo/packages/server/scripts/supervisor-entrypoint.ts"];

  test("runs the daemon directly when there is no systemd scope to use", () => {
    expect(resolveDaemonLaunchCommand({ execPath, args, useSystemdScope: false })).toEqual({
      command: execPath,
      args,
    });
  });

  test("wraps the same argv in a transient scope when there is", () => {
    const launch = resolveDaemonLaunchCommand({ execPath, args, useSystemdScope: true });

    expect(launch.command).toBe("systemd-run");
    // --user so it lands in the caller's own manager rather than the system one,
    // --scope so the daemon keeps running as itself instead of being forked into
    // a service, and --collect so a scope whose daemon died is cleaned up rather
    // than left failed under a name that cannot be reused.
    expect(launch.args.slice(0, 4)).toEqual(["--user", "--scope", "--quiet", "--collect"]);
    // The daemon's own command line survives the wrapping, in order.
    expect(launch.args.slice(4)).toEqual([execPath, ...args]);
  });
});
