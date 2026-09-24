import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceCodeLocationsTabTarget } from "@/workspace-tabs/model";

/**
 * Show results in the Explorer sidebar. It keeps the list beside the code without taking
 * workspace focus, so a picked result opens in the main pane the way a Files click does, and the
 * list stays put for the next one.
 */
export function openCodeLocationsInExplorer(input: {
  workspaceKey: string;
  target: WorkspaceCodeLocationsTabTarget;
}): void {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.showExplorerSidebar(input.workspaceKey);
  store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
}
