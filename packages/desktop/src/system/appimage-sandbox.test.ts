import { describe, expect, it } from "vitest";
import { shouldRelaunchAppImageWithoutSandbox } from "./appimage-sandbox";

const APPIMAGE = "/home/user/Applications/Paseo-x86_64.AppImage";

function decide(overrides: Partial<Parameters<typeof shouldRelaunchAppImageWithoutSandbox>[0]>) {
  return shouldRelaunchAppImageWithoutSandbox({
    platform: "linux",
    appImagePath: APPIMAGE,
    argv: ["/tmp/.mount_Paseo-abc123/Paseo"],
    isPassthroughCli: false,
    alreadyRelaunched: false,
    ...overrides,
  });
}

describe("shouldRelaunchAppImageWithoutSandbox", () => {
  it("re-executes an AppImage launched without the flag", () => {
    // electron-updater relaunches the AppImage directly after installing an update, so this
    // is the shape that used to reach the renderer and SIGTRAP.
    expect(decide({})).toBe(true);
  });

  it("does nothing when the flag is already on argv", () => {
    expect(decide({ argv: ["/tmp/.mount_Paseo-abc123/Paseo", "--no-sandbox"] })).toBe(false);
  });

  it("does nothing outside an AppImage", () => {
    // .deb and .rpm ship a working SUID helper and keep the sandbox on.
    expect(decide({ appImagePath: undefined })).toBe(false);
  });

  it("does nothing off Linux", () => {
    expect(decide({ platform: "darwin" })).toBe(false);
    expect(decide({ platform: "win32" })).toBe(false);
  });

  it("leaves passthrough CLI invocations alone", () => {
    // Re-executing would detach stdio and discard the exit code, and a CLI run opens no
    // window, so it cannot hit the crash this guards against.
    expect(decide({ isPassthroughCli: true })).toBe(false);
  });

  it("never re-executes twice", () => {
    // Belt and braces: if the flag did not survive the hand-off, looping would fork-bomb.
    expect(decide({ alreadyRelaunched: true })).toBe(false);
  });

  it("forwards other arguments unchanged in the decision", () => {
    expect(decide({ argv: ["/tmp/.mount_Paseo-abc123/Paseo", "paseo://open/project"] })).toBe(true);
  });
});
