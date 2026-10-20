/**
 * Walking back through prompts you already sent, the way a shell walks its
 * history. Pure state: the composer owns the text, this owns the position in
 * the list and the draft that was displaced to get there.
 */

export interface PromptRecallState {
  /** Index into the history list, newest first. -1 means not recalling. */
  index: number;
  /** The composer's own text, put back when you walk forward past the newest entry. */
  draft: string;
}

export const IDLE_PROMPT_RECALL: PromptRecallState = { index: -1, draft: "" };

export function isRecalling(state: PromptRecallState): boolean {
  return state.index >= 0;
}

export interface PromptRecallStep {
  state: PromptRecallState;
  text: string;
}

/**
 * Arrow keys move the caret first and only reach history at the edges, so a
 * recalled multi-line prompt can still be edited line by line. Matches
 * `up-line-or-history`: the first line goes back, the last line goes forward.
 */
export function isCaretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes("\n");
}

export function isCaretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes("\n");
}

export interface PromptRecallSelection {
  start: number;
  end: number;
}

function isCollapsed(selection: PromptRecallSelection): boolean {
  return selection.start === selection.end;
}

/** True when ArrowUp should reach history instead of moving the caret. */
export function shouldRecallPrevious(input: {
  text: string;
  selection: PromptRecallSelection;
}): boolean {
  return isCollapsed(input.selection) && isCaretOnFirstLine(input.text, input.selection.start);
}

/**
 * ArrowDown only walks forward out of a recalled prompt. With nothing recalled
 * there is nothing ahead of the draft, so the key keeps its normal meaning.
 */
export function shouldRecallNext(input: {
  state: PromptRecallState;
  text: string;
  selection: PromptRecallSelection;
}): boolean {
  return (
    isRecalling(input.state) &&
    isCollapsed(input.selection) &&
    isCaretOnLastLine(input.text, input.selection.end)
  );
}

/** Null when there is nothing older to show, leaving the composer untouched. */
export function recallPrevious(input: {
  state: PromptRecallState;
  entries: readonly string[];
  text: string;
}): PromptRecallStep | null {
  const nextIndex = input.state.index + 1;
  if (nextIndex >= input.entries.length) return null;
  const draft = isRecalling(input.state) ? input.state.draft : input.text;
  return {
    state: { index: nextIndex, draft },
    text: input.entries[nextIndex],
  };
}

/** Walking forward past the newest entry restores the draft and ends recall. */
export function recallNext(input: {
  state: PromptRecallState;
  entries: readonly string[];
}): PromptRecallStep | null {
  if (!isRecalling(input.state)) return null;
  const nextIndex = input.state.index - 1;
  if (nextIndex < 0) {
    return { state: IDLE_PROMPT_RECALL, text: input.state.draft };
  }
  const text = input.entries[nextIndex];
  if (text === undefined) return null;
  return { state: { index: nextIndex, draft: input.state.draft }, text };
}
