// Which Paseo Edge build this is — a fork-only file; upstream has no such thing.
//
// The Edge release workflow rewrites the literal below from the edge-v* tag it is
// building (see .github/workflows/edge-linux-release.yml). Every other build — upstream's,
// or a local dev run — keeps "dev", and the About screen shows no Edge row at all.
//
// It cannot ride on a package.json version the way resolveAppVersion() does. Those numbers
// are upstream's and the daemon reports them too, so rewriting one would make the host
// page's isVersionMismatch(app, daemon) warn against every daemon on upstream numbering,
// including the stock mobile client's view of a shared daemon.
export const EDGE_BUILD_VERSION = "dev";

/**
 * The Edge release version, or null when this build did not come from an edge-v* tag.
 */
export function parseEdgeBuildVersion(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || value === "dev") {
    return null;
  }

  return value;
}

export function resolveEdgeBuildVersion(): string | null {
  return parseEdgeBuildVersion(EDGE_BUILD_VERSION);
}
