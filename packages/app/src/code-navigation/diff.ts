import type { TFunction } from "i18next";
import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import type { SymbolQuery } from "./results";
import { symbolAt } from "./symbol";

/**
 * Why a symbol in a diff cannot be navigated. The language server reads the file on disk, so only
 * text that is on disk can be asked about: a removed line is not, and neither is the new side of
 * a comparison against a commit rather than the working tree.
 */
export type DiffNavigationBlock = "removed_line" | "not_on_disk";

export interface DiffSymbolTarget {
  query: SymbolQuery;
  blocked: DiffNavigationBlock | null;
}

export function diffSymbolTarget(input: {
  target: ReviewableDiffTarget;
  /** UTF-16 offset within the cell's content. */
  sourceOffset: number;
  /** The diff's new side is the working tree, as in the uncommitted comparison. */
  newSideOnDisk: boolean;
}): DiffSymbolTarget | null {
  const { target } = input;
  const span = symbolAt(target.content, input.sourceOffset);
  if (!span) return null;
  // A context line exists on both sides; its new-side number is where it is on disk.
  const diskLineNumber = target.lineType === "remove" ? null : target.newLineNumber;
  const lineNumber = diskLineNumber ?? target.lineNumber;
  return {
    query: {
      path: target.filePath,
      line: lineNumber - 1,
      character: span.start,
      symbol: span.text,
    },
    blocked: navigationBlock({
      onDisk: diskLineNumber !== null,
      newSideOnDisk: input.newSideOnDisk,
    }),
  };
}

function navigationBlock(input: {
  onDisk: boolean;
  newSideOnDisk: boolean;
}): DiffNavigationBlock | null {
  if (!input.onDisk) return "removed_line";
  if (!input.newSideOnDisk) return "not_on_disk";
  return null;
}

export function describeDiffBlock(block: DiffNavigationBlock, t: TFunction): string {
  return block === "removed_line"
    ? t("panels.codeNavigation.removedLine")
    : t("panels.codeNavigation.notOnDisk");
}
