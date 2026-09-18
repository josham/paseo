import path from "node:path";
import { describe, expect, it } from "vitest";

import { unpackedAsarPath } from "./devcontainer-service.js";

describe("asar dev container CLI resolution", () => {
  it("rewrites a path inside app.asar to the unpacked copy beside it", () => {
    const packed = path.join(
      path.sep,
      "opt",
      "Paseo",
      "resources",
      "app.asar",
      "node_modules",
      "@devcontainers",
      "cli",
      "devcontainer.js",
    );

    expect(unpackedAsarPath(packed)).toBe(
      path.join(
        path.sep,
        "opt",
        "Paseo",
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "@devcontainers",
        "cli",
        "devcontainer.js",
      ),
    );
  });

  it("returns null outside an asar, which is every non-packaged run", () => {
    expect(
      unpackedAsarPath(
        path.join(
          path.sep,
          "home",
          "dev",
          "paseo",
          "node_modules",
          "@devcontainers",
          "cli",
          "devcontainer.js",
        ),
      ),
    ).toBeNull();
  });

  it("does not match a directory merely named like the archive", () => {
    // `app.asar.unpacked` contains the literal "app.asar", so a naive indexOf without
    // the separators would rewrite an already-unpacked path a second time.
    const already = path.join(
      path.sep,
      "opt",
      "Paseo",
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@devcontainers",
      "cli",
      "devcontainer.js",
    );
    expect(unpackedAsarPath(already)).toBeNull();
  });
});
