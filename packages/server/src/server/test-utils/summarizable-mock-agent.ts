import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import type { AgentMode, AgentModelDefinition } from "../agent/agent-sdk-types.js";

/**
 * The mock provider, with a catalog structured generation can actually resolve.
 *
 * Providers for structured generation are chosen by model-id substring
 * (DEFAULT_STRUCTURED_GENERATION_PROVIDERS), and none of the mock's stream model
 * ids match. A test that needs a summarizer — the handoff brief's DECLARED
 * section, for one — otherwise gets silence rather than a failure.
 */
export class SummarizableMockAgentClient extends MockLoadTestAgentClient {
  override async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return {
      models: [
        { provider: "mock", id: "gpt-5.4-mini", label: "Mock summarizer", isDefault: true },
        { provider: "mock", id: "ten-second-stream", label: "Ten second stream" },
      ],
      modes: [],
    };
  }
}
