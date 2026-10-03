import type { CodeLocation, CodeSymbolLocationsResult } from "@getpaseo/protocol/messages";

/** A symbol someone asked about: where it is and what it is called. */
export interface SymbolQuery {
  /** Workspace-relative path. */
  path: string;
  /** Zero-based. */
  line: number;
  /** Zero-based UTF-16 offset. */
  character: number;
  symbol: string;
}

export interface LocationGroup {
  path: string;
  locations: CodeLocation[];
}

/** Locations arrive sorted by path and position; keep that order within and across files. */
export function groupLocationsByFile(locations: readonly CodeLocation[]): LocationGroup[] {
  const groups: LocationGroup[] = [];
  for (const location of locations) {
    const last = groups.at(-1);
    if (last?.path === location.path) {
      last.locations.push(location);
    } else {
      groups.push({ path: location.path, locations: [location] });
    }
  }
  return groups;
}

export type DefinitionOutcome =
  | { kind: "open"; location: CodeLocation }
  | { kind: "list"; locations: CodeLocation[] }
  | { kind: "none" }
  /** The query was already on the declaration, so the useful answer is where it is used. */
  | { kind: "usages" };

export function definitionOutcome(
  locations: readonly CodeLocation[],
  query: SymbolQuery,
): DefinitionOutcome {
  const openable = locations.filter((location) => location.openable);
  if (openable.length === 0) return { kind: "none" };
  if (openable.length > 1) return { kind: "list", locations: openable };
  const [only] = openable;
  return isAtQuery(only, query) ? { kind: "usages" } : { kind: "open", location: only };
}

function isAtQuery(location: CodeLocation, query: SymbolQuery): boolean {
  const { start, end } = location.range;
  return (
    location.path === query.path &&
    start.line === query.line &&
    end.line === query.line &&
    start.character <= query.character &&
    query.character <= end.character
  );
}

/** Every result other than `ok`, which each caller presents in its own way. */
export type UnavailableResult = Exclude<CodeSymbolLocationsResult, { status: "ok" }>;
