// A minimal ACP agent that can hold a session and answer one prompt.
//
// catalog-acp.cjs stops at session/new, which is enough for catalog tests but not
// for anything that has to create a working agent. This one answers session/prompt
// with a fixed reply so a spec can hand work to a second, launchable provider.
const readline = require("node:readline");

const REPLY = process.argv[2] ?? "Ready.";

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;

  if (request.method === "initialize") {
    send({
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    return;
  }

  if (request.method === "session/new") {
    send({ id: request.id, result: { sessionId: `echo-${Date.now()}` } });
    return;
  }

  if (request.method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: request.params?.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: REPLY },
        },
      },
    });
    send({ id: request.id, result: { stopReason: "end_turn" } });
    return;
  }

  send({ id: request.id, result: {} });
});
