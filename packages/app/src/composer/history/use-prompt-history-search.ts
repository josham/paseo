import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import type { ComposerKeyPressEvent } from "@/composer/input/input";
import { searchPromptHistory } from "./search";
import type { PromptHistoryStatus } from "./store";

/**
 * Ctrl+R over the prompts already sent in this project.
 *
 * The composer's own text is the query, the way the slash-command popup already
 * works and the way Ctrl+R reuses the shell's line. That keeps one text field on
 * screen and lets whatever you had half-typed seed the search. Enter puts the
 * chosen prompt in the composer rather than sending it: recall is for editing
 * something you sent before, and a search that could fire an agent on one
 * keystroke is the wrong kind of fast.
 */

const MAX_VISIBLE_MATCHES = 50;

function resolveEmptyText(input: {
  status: PromptHistoryStatus;
  hasHistory: boolean;
  t: (key: string) => string;
}): string {
  if (input.status === "unsupported") return input.t("composer.promptHistory.unsupported");
  if (!input.hasHistory) return input.t("composer.promptHistory.emptyHistory");
  return input.t("composer.promptHistory.noMatches");
}

export interface PromptHistorySearchController {
  isOpen: boolean;
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  emptyText: string;
  open: () => boolean;
  close: () => void;
  onKeyPress: (event: ComposerKeyPressEvent) => boolean;
  onSelectOption: (option: AutocompleteOption) => void;
}

export function usePromptHistorySearch(input: {
  enabled: boolean;
  entries: readonly PromptHistoryEntry[];
  status: PromptHistoryStatus;
  query: string;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  focusInput: () => void;
}): PromptHistorySearchController {
  const { enabled, entries, status, query, replaceText, focusInput } = input;
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** What the composer held when search opened, restored if you back out. */
  const restoreTextRef = useRef("");

  const matches = useMemo(
    () => (isOpen ? searchPromptHistory({ query, entries, limit: MAX_VISIBLE_MATCHES }) : []),
    [entries, isOpen, query],
  );

  const options = useMemo<AutocompleteOption[]>(
    () =>
      matches.map((match) => ({
        id: `${match.entry.at}:${match.entry.text}`,
        label: match.preview,
        labelRanges: match.ranges,
      })),
    [matches],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setSelectedIndex(0);
  }, []);

  const open = useCallback(() => {
    if (!enabled) return false;
    restoreTextRef.current = query;
    setSelectedIndex(0);
    setIsOpen(true);
    focusInput();
    return true;
  }, [enabled, focusInput, query]);

  const apply = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      close();
      replaceText(match.entry.text, {
        start: match.entry.text.length,
        end: match.entry.text.length,
      });
      focusInput();
    },
    [close, focusInput, matches, replaceText],
  );

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      apply(options.findIndex((candidate) => candidate.id === option.id));
    },
    [apply, options],
  );

  const onKeyPress = useCallback(
    (event: ComposerKeyPressEvent): boolean => {
      if (!isOpen) return false;

      // Ctrl+R again steps to the next match, the way readline repeats a search.
      if (event.modifiers.ctrl && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        setSelectedIndex((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
        return true;
      }
      if (event.modifiers.alt || event.modifiers.ctrl || event.modifiers.meta) return false;

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        const restored = restoreTextRef.current;
        replaceText(restored, { start: restored.length, end: restored.length });
        focusInput();
        return true;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (matches.length === 0) return true;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((current) => (current + delta + matches.length) % matches.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        apply(selectedIndex);
        return true;
      }
      return false;
    },
    [apply, close, focusInput, isOpen, matches.length, replaceText, selectedIndex],
  );

  const emptyText = resolveEmptyText({ status, hasHistory: entries.length > 0, t });

  return {
    isOpen,
    options,
    selectedIndex: matches.length === 0 ? -1 : selectedIndex,
    emptyText,
    open,
    close,
    onKeyPress,
    onSelectOption,
  };
}
