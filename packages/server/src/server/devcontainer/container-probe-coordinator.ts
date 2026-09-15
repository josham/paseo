import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { ContainerBackend, ContainerRef } from "./container-backend.js";
import { composeProjectNameFor } from "./compose-project.js";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";

/**
 * ContainerProbeCoordinator — runs the new-workspace screen's "what tools does
 * this image have?" probe.
 *
 * A probe starts a throwaway container, lists each provider's models inside it,
 * and removes the container again. Three things make that safe to drive from a
 * dropdown:
 *
 *   - **Disposable identity.** Every probe container is created under its own
 *     `probe:<uuid>` key, so it can never adopt — or stop — a container that
 *     belongs to a workspace, even one on the same directory.
 *   - **De-duplication.** Repeats of an in-flight probe join it instead of
 *     starting a second container.
 *   - **Cancellation.** Picking a different backend supersedes the running
 *     probe, and disconnecting cancels everything the session started. A
 *     cancelled probe kills the CLI and removes whatever it managed to create.
 *
 * Results are returned to the caller rather than written to the shared provider
 * snapshot: the container is gone by the time the client sees them, and the
 * workspaces already using that directory have their own answer.
 */

export interface ContainerProbeResult {
  status: "success" | "cancelled" | "error";
  entries: ProviderSnapshotEntry[];
  error: string | null;
}

export interface ContainerProbeRequest {
  /** The client request this probe answers; also what cancellation names. */
  requestId: string;
  cwd: string;
  containerBackend: string;
  /** Emits one line of container build/start output. */
  onProgress: (line: string) => void;
}

interface InFlightProbe {
  /** `${cwd}\0${containerBackend}` — what makes two requests the same probe. */
  dedupeKey: string;
  cwd: string;
  abort: AbortController;
  promise: Promise<ContainerProbeResult>;
  /** requestId -> progress sink, so a waiter can leave without ending the probe. */
  subscribers: Map<string, (line: string) => void>;
}

export interface ContainerProbeCoordinatorDeps {
  logger: Logger;
  resolveBackend: (id: string) => ContainerBackend | null;
  probeProviders: (input: {
    cwd: string;
    launchStrategy: ProcessLaunchStrategy;
    signal: AbortSignal;
  }) => Promise<ProviderSnapshotEntry[]>;
}

export class ContainerProbeCoordinator {
  private readonly logger: Logger;
  private readonly deps: ContainerProbeCoordinatorDeps;
  private readonly inFlight = new Map<string, InFlightProbe>();
  constructor(deps: ContainerProbeCoordinatorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ module: "container-probe" });
  }

  async probe(request: ContainerProbeRequest): Promise<ContainerProbeResult> {
    const dedupeKey = `${request.cwd} ${request.containerBackend}`;

    // A different backend for the same directory replaces the running probe:
    // its answer is no longer the one being asked for.
    for (const [key, probe] of this.inFlight) {
      if (probe.cwd === request.cwd && key !== dedupeKey) {
        this.cancelProbe(key, "superseded");
      }
    }

    const existing = this.inFlight.get(dedupeKey);
    if (existing) {
      // Same question, already being answered — wait for that container rather
      // than building a second one.
      existing.subscribers.set(request.requestId, request.onProgress);
      try {
        return await existing.promise;
      } finally {
        existing.subscribers.delete(request.requestId);
      }
    }

    const abort = new AbortController();
    const subscribers = new Map([[request.requestId, request.onProgress]]);
    const probe: InFlightProbe = {
      dedupeKey,
      cwd: request.cwd,
      abort,
      subscribers,
      promise: this.runProbe(request, abort.signal, subscribers),
    };
    this.inFlight.set(dedupeKey, probe);
    try {
      return await probe.promise;
    } finally {
      if (this.inFlight.get(dedupeKey) === probe) {
        this.inFlight.delete(dedupeKey);
      }
      subscribers.delete(request.requestId);
    }
  }

  /**
   * Drop a client's interest in a probe. The container keeps building while
   * anyone else is still waiting on the same answer; it is torn down once the
   * last waiter leaves.
   */
  cancelByRequestId(requestId: string): void {
    for (const [key, probe] of this.inFlight) {
      if (!probe.subscribers.delete(requestId)) continue;
      if (probe.subscribers.size === 0) {
        this.cancelProbe(key, "cancelled by client");
      }
      return;
    }
  }

  /** Cancel everything this session started — it has nobody left to answer. */
  dispose(): void {
    for (const key of this.inFlight.keys()) {
      this.cancelProbe(key, "session closed");
    }
  }

  private cancelProbe(key: string, reason: string): void {
    const probe = this.inFlight.get(key);
    if (!probe) return;
    this.logger.info({ cwd: probe.cwd, reason }, "Cancelling container probe");
    this.inFlight.delete(key);
    probe.abort.abort();
  }

  private async runProbe(
    request: ContainerProbeRequest,
    signal: AbortSignal,
    subscribers: Map<string, (line: string) => void>,
  ): Promise<ContainerProbeResult> {
    const backend = this.deps.resolveBackend(request.containerBackend);
    if (!backend) {
      return {
        status: "error",
        entries: [],
        error: `Unknown container backend: ${request.containerBackend}`,
      };
    }

    // Unique per probe: two probes of the same directory, or a probe running
    // alongside a workspace's container, never share an identity.
    const ref: ContainerRef = {
      key: `probe:${randomUUID()}`,
      kind: "probe",
      workspaceFolder: request.cwd,
    };
    // The project belongs to the probe's identity, so it has to be on the ref
    // itself rather than injected at the `up` call: `stop` reads it too, and a
    // teardown that does not know the project falls back to matching every
    // compose container on this folder — which is how a probe came to `docker
    // rm -f` the container VS Code was attached to, and how its own sibling
    // services were left running under a name nothing would ever ask for again.
    //
    // Compose resolves by project, so without one of its own a probe's `up` also
    // lands on the container the workspace is using.
    const probeRef: ContainerRef = { ...ref, composeProject: composeProjectNameFor(ref.key) };

    const emitProgress = (line: string): void => {
      for (const subscriber of subscribers.values()) subscriber(line);
    };

    try {
      const handle = await backend.up({
        ...probeRef,
        onProgress: emitProgress,
        signal,
      });
      signal.throwIfAborted();
      const entries = await this.deps.probeProviders({
        cwd: request.cwd,
        launchStrategy: backend.createStrategy(ref.key, request.cwd, handle),
        signal,
      });
      signal.throwIfAborted();
      return { status: "success", entries, error: null };
    } catch (error) {
      if (signal.aborted) {
        return { status: "cancelled", entries: [], error: null };
      }
      this.logger.warn({ err: error, cwd: request.cwd }, "Container probe failed");
      return { status: "error", entries: [], error: toProbeErrorMessage(error) };
    } finally {
      // The container is scratch either way: on success its answers are already
      // in hand, and on failure or cancellation it is a half-built leftover.
      await backend.stop(probeRef, { remove: true }).catch((error: unknown) => {
        this.logger.warn({ err: error, key: ref.key }, "Failed to remove probe container");
      });
    }
  }
}

function toProbeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
