import { describe, expect, it } from "vitest";
import {
  SSH_CONNECT_TIMEOUT_MS,
  SSH_REMOTE_SETUP_TIMEOUT_MS,
} from "@getpaseo/protocol/ssh-transport";
import { createSshPromptGrants } from "./ssh-prompt-grants";

function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createSshPromptGrants", () => {
  it("refuses a host nobody asked to connect to", () => {
    const grants = createSshPromptGrants(createClock());
    expect(grants.isGranted("build-box")).toBe(false);
  });

  it("covers the probe, the connection behind it, and their retries", () => {
    const grants = createSshPromptGrants(createClock());
    grants.grant({ host: "build-box" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(grants.isGranted("build-box")).toBe(true);
    }
  });

  it("grants one host at a time", () => {
    const grants = createSshPromptGrants(createClock());
    grants.grant({ host: "build-box" });
    expect(grants.isGranted("other-box")).toBe(false);
  });

  it("lapses once the connect it was meant for is long over", () => {
    const clock = createClock();
    const grants = createSshPromptGrants(clock);
    grants.grant({ host: "build-box" });

    clock.advance(SSH_CONNECT_TIMEOUT_MS * 2);
    expect(grants.isGranted("build-box")).toBe(false);
  });

  it("gives a host being installed the longer setup budget", () => {
    const clock = createClock();
    const grants = createSshPromptGrants(clock);
    grants.grant({ host: "build-box", remoteSetup: true });

    // Past what a plain connect would get, still inside an install.
    clock.advance(SSH_CONNECT_TIMEOUT_MS * 2);
    expect(grants.isGranted("build-box")).toBe(true);

    clock.advance(SSH_REMOTE_SETUP_TIMEOUT_MS * 2);
    expect(grants.isGranted("build-box")).toBe(false);
  });

  it("closes the window when the user declines", () => {
    const grants = createSshPromptGrants(createClock());
    grants.grant({ host: "build-box" });

    expect(grants.isGranted("build-box")).toBe(true);
    grants.revoke("build-box");
    expect(grants.isGranted("build-box")).toBe(false);
  });

  it("ignores a host string ssh would reject", () => {
    const grants = createSshPromptGrants(createClock());
    grants.grant({ host: "-oProxyCommand=touch /tmp/pwned" });
    expect(grants.isGranted("-oProxyCommand=touch /tmp/pwned")).toBe(false);
  });
});
