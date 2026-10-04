import type { AgentProfileApplyTarget } from "./use-agent-profile-picker";
import {
  reconcileMaterializedProfileMode,
  type MaterializedAgentProfile,
} from "./materialize-profile";

export type ProfileApplication =
  | { kind: "draft"; profile: MaterializedAgentProfile }
  /** Change the running agent in place. Provider is unchanged by definition. */
  | { kind: "apply"; profile: MaterializedAgentProfile }
  /** The profile names another provider, which a running agent cannot become. */
  | { kind: "handoff"; profile: MaterializedAgentProfile }
  /** The running provider has not published its modes yet. */
  | { kind: "wait" };

/**
 * Decides what selecting a profile means for the surface it was selected on.
 *
 * A running agent cannot change the process it is, so a profile from another
 * provider can only be honored by handing the work to a new agent. That case
 * deliberately skips mode reconciliation: the mode belongs to the profile's own
 * provider, and checking it against the provider being left behind would strip a
 * mode the successor can actually honor.
 */
export function resolveProfileApplication(input: {
  profile: MaterializedAgentProfile;
  target: AgentProfileApplyTarget;
}): ProfileApplication {
  if (input.target.kind === "draft") {
    return { kind: "draft", profile: input.profile };
  }

  if (input.profile.provider !== input.target.currentProvider) {
    return { kind: "handoff", profile: input.profile };
  }

  const reconciled = reconcileMaterializedProfileMode(input.profile, input.target.availableModeIds);
  return reconciled ? { kind: "apply", profile: reconciled } : { kind: "wait" };
}
