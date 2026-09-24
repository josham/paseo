import type { TFunction } from "i18next";
import type { UnavailableResult } from "./results";

/** What to tell the user when the host could not answer a code navigation query. */
export function describeUnavailable(result: UnavailableResult, t: TFunction): string {
  switch (result.status) {
    case "unsupported_language":
      return t("panels.codeNavigation.unsupportedLanguage");
    case "server_not_installed":
      return t("panels.codeNavigation.serverNotInstalled", {
        commands: result.commands.join(t("panels.codeNavigation.orSeparator")),
      });
    case "unavailable":
      return describeUnavailableReason(result.reason, t);
    case "failed":
      return t("panels.codeNavigation.failed", { message: result.message });
  }
}

function describeUnavailableReason(
  reason: Extract<UnavailableResult, { status: "unavailable" }>["reason"],
  t: TFunction,
): string {
  switch (reason) {
    case "disabled":
      return t("panels.codeNavigation.disabled");
    case "not_a_workspace":
      return t("panels.codeNavigation.notAWorkspace");
    case "container_not_running":
      return t("panels.codeNavigation.containerNotRunning");
  }
}
