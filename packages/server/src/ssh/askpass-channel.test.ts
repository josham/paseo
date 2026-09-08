import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAskpassChannel,
  type AskpassChannel,
  type AskpassRequest,
} from "./askpass-channel.js";

const PASSWORD_PROMPT = "deploy@build-box's password: ";
const PASSPHRASE_PROMPT = "Enter passphrase for key '/home/deploy/.ssh/id_ed25519': ";

let channel: AskpassChannel | null = null;

afterEach(() => {
  channel?.close();
  channel = null;
});

/**
 * Run the askpass program the way `ssh` does, and read the secret it prints.
 * Asynchronous on purpose: the channel's socket server lives in this process,
 * so a blocking child would deadlock against the answer it is waiting for.
 */
async function askSsh(
  open: AskpassChannel,
  prompt: string,
  env: Record<string, string | undefined>,
): Promise<{ secret: string | null }> {
  return new Promise((resolve) => {
    execFile(open.askpassPath, [prompt], { env }, (error, stdout) => {
      resolve({ secret: error ? null : stdout });
    });
  });
}

describe("askpass channel", () => {
  it("hands SSH the secret the prompt handler returned", async () => {
    const asked: AskpassRequest[] = [];
    const open = (channel = await createAskpassChannel({
      onPrompt: (request) => {
        asked.push(request);
        return Promise.resolve("hunter2");
      },
    }));

    expect(await askSsh(open, PASSWORD_PROMPT, open.askpassEnv(process.env))).toEqual({
      secret: "hunter2",
    });
    expect(asked).toEqual([{ prompt: PASSWORD_PROMPT, kind: "password" }]);
  });

  it("tells a key passphrase apart from an account password", async () => {
    const asked: AskpassRequest[] = [];
    const open = (channel = await createAskpassChannel({
      onPrompt: (request) => {
        asked.push(request);
        return Promise.resolve("hunter2");
      },
    }));

    await askSsh(open, PASSPHRASE_PROMPT, open.askpassEnv(process.env));

    expect(asked).toEqual([{ prompt: PASSPHRASE_PROMPT, kind: "passphrase" }]);
  });

  it("treats a host-key fingerprint as something to confirm, not a secret to type", async () => {
    const asked: AskpassRequest[] = [];
    const open = (channel = await createAskpassChannel({
      onPrompt: (request) => {
        asked.push(request);
        return Promise.resolve("yes");
      },
    }));
    const prompt =
      "The authenticity of host 'build-box (10.0.0.4)' can't be established.\n" +
      "ED25519 key fingerprint is SHA256:abc123.\n" +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";

    expect(await askSsh(open, prompt, open.askpassEnv(process.env))).toEqual({ secret: "yes" });
    expect(asked).toEqual([{ prompt, kind: "confirm" }]);
  });

  it("answers a second ssh process without asking the user again", async () => {
    let asked = 0;
    const open = (channel = await createAskpassChannel({
      onPrompt: () => {
        asked += 1;
        return Promise.resolve("hunter2");
      },
    }));

    await askSsh(open, PASSWORD_PROMPT, open.askpassEnv(process.env));
    const replayed = await askSsh(open, PASSWORD_PROMPT, open.askpassEnv(process.env));

    expect(replayed).toEqual({ secret: "hunter2" });
    expect(asked).toBe(1);
  });

  it("asks again when the same ssh process re-prompts, because the answer was wrong", async () => {
    let asked = 0;
    const open = (channel = await createAskpassChannel({
      onPrompt: () => {
        asked += 1;
        return Promise.resolve(`hunter${asked}`);
      },
    }));
    const sshEnv = open.askpassEnv(process.env);

    expect(await askSsh(open, PASSWORD_PROMPT, sshEnv)).toEqual({ secret: "hunter1" });
    expect(await askSsh(open, PASSWORD_PROMPT, sshEnv)).toEqual({ secret: "hunter2" });
    expect(asked).toBe(2);
  });

  it("aborts the connection when the user declines instead of offering an empty password", async () => {
    const open = (channel = await createAskpassChannel({
      onPrompt: () => Promise.resolve(null),
    }));

    expect(await askSsh(open, PASSWORD_PROMPT, open.askpassEnv(process.env))).toEqual({
      secret: null,
    });
    expect(open.signal.aborted).toBe(true);
  });

  it("declines rather than hanging SSH when nobody answers in time", async () => {
    const open = (channel = await createAskpassChannel({
      onPrompt: () => new Promise<string | null>(() => {}),
      promptTimeoutMs: 50,
    }));

    expect(await askSsh(open, PASSWORD_PROMPT, open.askpassEnv(process.env))).toEqual({
      secret: null,
    });
    expect(open.signal.aborted).toBe(true);
  });
});
