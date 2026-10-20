import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { CodeLocation, CodePosition, CodeRange } from "@getpaseo/protocol/messages";
import { URI } from "vscode-uri";
import type { RawLocation } from "./connection.js";

export const MAX_LOCATIONS = 1000;
const MAX_PREVIEW_CHARS = 200;

export interface MapLocationsInput {
  locations: RawLocation[];
  /** Workspace root on the daemon's side. */
  rootPath: string;
  toHostPath: (serverPath: string) => string | null;
}

export interface MappedLocations {
  locations: CodeLocation[];
  originRange: CodeRange | null;
  truncated: boolean;
}

/**
 * Turn what the server answered into locations the file viewer can open: workspace-relative
 * paths where possible, a preview line for the list, and deduplicated in file and line order.
 */
export async function mapLocations(input: MapLocationsInput): Promise<MappedLocations> {
  const unique = dedupe(input.locations);
  const truncated = unique.length > MAX_LOCATIONS;
  const kept = unique.slice(0, MAX_LOCATIONS);

  const hostPaths = kept.map((location) => input.toHostPath(URI.parse(location.uri).fsPath));
  const previews = await readPreviews(kept, hostPaths);
  const locations = kept.map((location, index) => {
    const hostPath = hostPaths[index];
    return {
      path: hostPath ? displayPath(input.rootPath, hostPath) : URI.parse(location.uri).fsPath,
      range: location.range,
      preview: previews[index],
      openable: hostPath !== null,
    };
  });
  locations.sort(compareLocations);

  const originRange = input.locations.find((location) => location.originRange)?.originRange;
  return { locations, originRange: originRange ?? null, truncated };
}

/**
 * Drop definition targets that merely enclose the position asked about. tsserver answers a click
 * on `return` or `export` with the function or module around it, which would put a link on every
 * keyword and jump nowhere useful. A target whose own name span contains the position is kept:
 * that is a click on a declaration's name.
 */
export function dropEnclosingTargets(params: {
  locations: RawLocation[];
  documentUri: string;
  position: CodePosition;
}): RawLocation[] {
  return params.locations.filter((location) => {
    if (location.uri !== params.documentUri || !location.enclosingRange) return true;
    const enclosesPosition = rangeContains(location.enclosingRange, params.position);
    const nameContainsPosition = rangeContains(location.range, params.position);
    return !enclosesPosition || nameContainsPosition;
  });
}

function rangeContains(range: CodeRange, position: CodePosition): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}

function dedupe(locations: RawLocation[]): RawLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayPath(rootPath: string, hostPath: string): string {
  const relativePath = relative(rootPath, hostPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return hostPath;
  }
  return relativePath.split(sep).join("/");
}

async function readPreviews(
  locations: RawLocation[],
  hostPaths: (string | null)[],
): Promise<(string | null)[]> {
  const uniquePaths = [...new Set(hostPaths.filter((path): path is string => path !== null))];
  const linesByPath = new Map<string, string[] | null>();
  await Promise.all(
    uniquePaths.map(async (path) => {
      linesByPath.set(path, await readLines(path));
    }),
  );
  return locations.map((location, index) => {
    const hostPath = hostPaths[index];
    const lines = hostPath ? linesByPath.get(hostPath) : null;
    const line = lines?.[location.range.start.line];
    return line === undefined ? null : line.trim().slice(0, MAX_PREVIEW_CHARS);
  });
}

async function readLines(path: string): Promise<string[] | null> {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/);
  } catch {
    // A preview is decoration: a target the daemon cannot read is still a valid result.
    return null;
  }
}

function compareLocations(a: CodeLocation, b: CodeLocation): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
  return a.range.start.character - b.range.start.character;
}
