/**
 * Naming a Docker Compose project after something of ours instead of the
 * workspace folder.
 *
 * Compose derives a project name from the directory the compose file sits under,
 * which is why a compose container is shared by every workspace on a checkout
 * and why two checkouts with the same directory name resolve to one container.
 * Passing a name of our own is the only way out; the dev container CLI has no
 * flag for it and honours `COMPOSE_PROJECT_NAME`.
 */

/**
 * Compose accepts lowercase letters, digits, dashes and underscores, and wants a
 * letter or digit first. Workspace keys (`wks_3f3cc…`, `probe:<uuid>`) are close
 * but not always inside that, so everything else is folded to a dash.
 */
export function composeProjectNameFor(key: string): string {
  const sanitized = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    // A leading dash or underscore is not a legal start.
    .replace(/^[^a-z0-9]+/, "");
  // The prefix is what makes these recognisable in `docker compose ls`, and it
  // also guarantees a legal first character for a key that sanitized to nothing.
  return `paseo-${sanitized}`;
}
