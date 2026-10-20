import { describe, expect, it } from "vitest";
import {
  buildSshSessionArgs,
  buildSshTunnelArgs,
  isSshAuthFailureStderr,
  isSshAuthRequiredMessage,
  markSshAuthRequired,
  parseSshTransportUri,
  sshAskpassEnv,
  stripSshAuthRequiredPrefix,
  validateSshHost,
} from "./ssh-transport.js";

describe("SSH transport", () => {
  it("parses SSH targets with Paseo's default daemon port", () => {
    expect(parseSshTransportUri("ssh://deploy@example.com:2222")).toEqual({
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 6767,
    });
  });

  it("accepts an explicit remote daemon port", () => {
    expect(parseSshTransportUri("ssh://build-box?daemonPort=7777")).toEqual({
      host: "build-box",
      daemonPort: 7777,
    });
  });

  it("passes IPv6 hosts to OpenSSH without URI brackets", () => {
    expect(parseSshTransportUri("ssh://deploy@[2001:db8::1]:2222")).toEqual({
      host: "deploy@2001:db8::1",
      sshPort: 2222,
      daemonPort: 6767,
    });
  });

  it("tunnels without touching the remote host unless install is asked for", () => {
    expect(parseSshTransportUri("ssh://build-box").remoteDaemon).toBeUndefined();
  });

  it("opts into remote install only on an explicit flag", () => {
    expect(parseSshTransportUri("ssh://build-box?install=1")).toEqual({
      host: "build-box",
      daemonPort: 6767,
      remoteDaemon: {},
    });
  });

  it("carries the remote paths and version the user pinned", () => {
    expect(
      parseSshTransportUri(
        "ssh://build-box?install=1&remoteHome=%2Fsrv%2Fpaseo&installDir=%2Fopt%2Fpaseo&version=0.7.2",
      ).remoteDaemon,
    ).toEqual({
      remoteHome: "/srv/paseo",
      installDir: "/opt/paseo",
      version: "0.7.2",
    });
  });

  it.each([
    "http://build-box",
    "ssh://build-box/path",
    "ssh://build-box?unknown=true",
    "ssh://build-box?daemonPort=0",
    "ssh://user:secret@build-box",
    "ssh://build-box?install=0",
    "ssh://build-box?remoteHome=/srv/paseo",
    "ssh://build-box?install=1&version=0.7.2&version=0.7.3",
  ])("rejects invalid target %s", (target) => {
    expect(() => parseSshTransportUri(target)).toThrow();
  });

  it("builds a non-interactive stdio tunnel and preserves SSH config", () => {
    expect(
      buildSshTunnelArgs({
        host: "deploy@build-box",
        sshPort: 2222,
        daemonPort: 7777,
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:7777",
      "deploy@build-box",
    ]);
  });

  it("drops BatchMode when an askpass program can answer the prompt", () => {
    const args = buildSshTunnelArgs(
      { host: "build-box", daemonPort: 6767 },
      { askpassPath: "/tmp/askpass.sh" },
    );
    expect(args).not.toContain("BatchMode=yes");
    expect(args).toEqual([
      "-T",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-W",
      "127.0.0.1:6767",
      "build-box",
    ]);
  });

  it("leaves stdio free for a remote command instead of forwarding a port", () => {
    expect(
      buildSshSessionArgs(
        { host: "deploy@build-box", sshPort: 2222, daemonPort: 6767 },
        "exec /bin/sh",
      ),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "deploy@build-box",
      "exec /bin/sh",
    ]);
  });

  it("points ssh at the askpass program and gives it a display to believe in", () => {
    expect(sshAskpassEnv({ PATH: "/usr/bin" }, "/tmp/askpass.sh")).toEqual({
      PATH: "/usr/bin",
      SSH_ASKPASS: "/tmp/askpass.sh",
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
    });
  });

  it("keeps the display the user already has", () => {
    expect(sshAskpassEnv({ DISPLAY: ":1" }, "/tmp/askpass.sh").DISPLAY).toBe(":1");
  });

  it.each(["", "-oProxyCommand=bad", "bad host"])("rejects unsafe SSH host %j", (host) => {
    expect(() => validateSshHost(host)).toThrow();
  });
});

describe("SSH authentication failures", () => {
  it.each([
    "testuser@example.com: Permission denied (publickey,password).",
    "Host key verification failed.",
    "Received disconnect from 10.0.0.4 port 22:2: Too many authentication failures",
    "example.com: No supported authentication methods available",
  ])("recognizes %j as a missing credential", (stderr) => {
    expect(isSshAuthFailureStderr(stderr)).toBe(true);
  });

  it.each([
    "ssh: connect to host example.com port 22: Connection refused",
    "channel 0: open failed: connect failed: Connection refused",
    "kex_exchange_identification: read: Connection reset by peer",
  ])("leaves %j alone", (stderr) => {
    expect(isSshAuthFailureStderr(stderr)).toBe(false);
  });

  it("survives the wrapping the client puts around it", () => {
    const marked = markSshAuthRequired("Permission denied (publickey,password).");
    expect(isSshAuthRequiredMessage(`Connection failed: ${marked}`)).toBe(true);
  });

  it("marks a detail once, however many times it is passed through", () => {
    const once = markSshAuthRequired("Permission denied.");
    expect(markSshAuthRequired(once)).toBe(once);
  });

  it("takes the marker back out for display", () => {
    const marked = markSshAuthRequired("Permission denied (publickey,password).");
    expect(stripSshAuthRequiredPrefix(marked)).toBe("Permission denied (publickey,password).");
  });

  it.each([null, undefined, "Connection refused"])("does not see a marker in %j", (message) => {
    expect(isSshAuthRequiredMessage(message)).toBe(false);
  });
});
