import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CodeLocation,
  CodeSymbolLocationKind,
  CodeSymbolLocationsResult,
} from "@getpaseo/protocol/messages";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { SymbolQuery } from "./results";

export interface CodeLocationsRequest {
  serverId: string;
  cwd: string;
  kind: CodeSymbolLocationKind;
  query: SymbolQuery;
}

/**
 * Results stay fresh briefly so a list opened right after its query was answered shows that
 * answer instead of asking the language server again.
 */
export const CODE_LOCATIONS_STALE_TIME_MS = 30_000;

export function codeLocationsQueryKey(request: CodeLocationsRequest) {
  const { serverId, cwd, kind, query } = request;
  return ["code-symbol-locations", serverId, cwd, kind, query.path, query.line, query.character];
}

export function fetchCodeLocations(
  client: DaemonClient,
  request: CodeLocationsRequest & { content?: string },
): Promise<CodeSymbolLocationsResult> {
  return client.getCodeSymbolLocations({
    cwd: request.cwd,
    path: request.query.path,
    kind: request.kind,
    position: { line: request.query.line, character: request.query.character },
    content: request.content,
  });
}

export function toFileLocation(location: CodeLocation): WorkspaceFileLocation {
  const { start, end } = location.range;
  return { path: location.path, lineStart: start.line + 1, lineEnd: end.line + 1 };
}
