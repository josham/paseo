import { useCallback, useRef } from "react";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import type { ComposerKeyPressEvent } from "@/composer/input/input";
import {
  IDLE_PROMPT_RECALL,
  recallNext,
  recallPrevious,
  shouldRecallNext,
  shouldRecallPrevious,
  type PromptRecallState,
  type PromptRecallStep,
} from "./recall";

export interface PromptRecallController {
  /** True when the key was consumed as history navigation. */
  onKeyPress: (event: ComposerKeyPressEvent) => boolean;
  /** Ends recall, so the next ArrowUp starts again from the newest prompt. */
  reset: () => void;
}

/**
 * ArrowUp and ArrowDown in the composer, walking the prompts already sent in
 * this project. The composer owns the text; this owns where in the list we are
 * and puts the caret at the end of whatever it applies, so a second ArrowUp is
 * still on the first line and keeps walking back.
 */
export function usePromptRecall(input: {
  enabled: boolean;
  entries: readonly PromptHistoryEntry[];
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
}): PromptRecallController {
  const { enabled, entries, replaceText } = input;
  const stateRef = useRef<PromptRecallState>(IDLE_PROMPT_RECALL);
  /**
   * What recall last wrote. Any other text in the composer means the user typed
   * since, and their edit is the new draft.
   */
  const appliedTextRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    stateRef.current = IDLE_PROMPT_RECALL;
    appliedTextRef.current = null;
  }, []);

  const onKeyPress = useCallback(
    (event: ComposerKeyPressEvent): boolean => {
      if (!enabled) return false;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      const { alt, ctrl, meta, shift } = event.modifiers;
      if (alt || ctrl || meta || shift) return false;

      const { text, selection } = event.input;
      if (appliedTextRef.current !== null && appliedTextRef.current !== text) {
        reset();
      }
      const state = stateRef.current;
      const texts = entries.map((entry) => entry.text);

      let step: PromptRecallStep | null = null;
      if (event.key === "ArrowUp") {
        if (shouldRecallPrevious({ text, selection })) {
          step = recallPrevious({ state, entries: texts, text });
        }
      } else if (shouldRecallNext({ state, text, selection })) {
        step = recallNext({ state, entries: texts });
      }
      if (!step) return false;

      event.preventDefault();
      stateRef.current = step.state;
      appliedTextRef.current = step.text;
      replaceText(step.text, { start: step.text.length, end: step.text.length });
      return true;
    },
    [enabled, entries, replaceText, reset],
  );

  return { onKeyPress, reset };
}
