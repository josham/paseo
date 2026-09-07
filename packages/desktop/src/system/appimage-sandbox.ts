import { spawn } from "node:child_process";

const NO_SANDBOX_FLAG = "--no-sandbox";

// Set on the replacement process so a single re-exec is the most that can ever happen. If
// the flag somehow did not survive the hand-off, looping here would fork-bomb the machine.
export const APPIMAGE_SANDBOX_RELAUNCH_ENV = "PASEO_APPIMAGE_SANDBOX_RELAUNCHED";

/**
 * Chromium reads its sandbox configuration from the real process argv before any JavaScript
 * runs, so `app.commandLine.appendSwitch("no-sandbox")` is too late to take effect: the
 * browser process still advertises `--enable-sandbox` to its children, the renderer tries the
 * SUID chrome-sandbox helper against the /tmp AppImage mount, and dies with SIGTRAP.
 *
 * Only argv works, and no launcher can guarantee it — electron-updater relaunches the
 * AppImage directly after installing an update, bypassing the .desktop entry and any wrapper
 * script. Re-exec once with the flag in place and let the replacement process do the work.
 */
export function shouldRelaunchAppImageWithoutSandbox(input: {
  platform: NodeJS.Platform;
  appImagePath: string | undefined;
  argv: readonly string[];
  isPassthroughCli: boolean;
  alreadyRelaunched: boolean;
}): boolean {
  if (input.platform !== "linux") return false;
  if (!input.appImagePath) return false;
  if (input.alreadyRelaunched) return false;
  // A passthrough CLI invocation never opens a window, so it cannot hit the renderer crash.
  // Re-executing it would detach its stdio and discard its exit code.
  if (input.isPassthroughCli) return false;
  return !input.argv.includes(NO_SANDBOX_FLAG);
}

export function relaunchAppImageWithoutSandbox(input: {
  appImagePath: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): void {
  spawn(input.appImagePath, [NO_SANDBOX_FLAG, ...input.argv.slice(1)], {
    detached: true,
    stdio: "ignore",
    env: { ...input.env, [APPIMAGE_SANDBOX_RELAUNCH_ENV]: "1" },
  }).unref();
}
