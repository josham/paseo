const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$]/u;

export interface SymbolSpan {
  /** UTF-16 offset of the first character. */
  start: number;
  /** UTF-16 offset one past the last character. */
  end: number;
  text: string;
}

/**
 * The identifier under a UTF-16 offset in one line of source. A position just past the end of a
 * word counts as that word, so a caret after `foo` or a click on its right edge still finds it.
 *
 * This only names what was clicked, for menu titles and the underline; the language server
 * decides what the symbol is.
 */
export function symbolAt(line: string, character: number): SymbolSpan | null {
  const offset = Math.max(0, Math.min(character, line.length));
  let anchor = offset;
  if (!isIdentifierCharacter(line, anchor)) {
    if (anchor === 0 || !isIdentifierCharacter(line, anchor - 1)) return null;
    anchor -= 1;
  }
  let start = anchor;
  while (start > 0 && isIdentifierCharacter(line, start - 1)) start -= 1;
  let end = anchor + 1;
  while (end < line.length && isIdentifierCharacter(line, end)) end += 1;
  return { start, end, text: line.slice(start, end) };
}

function isIdentifierCharacter(line: string, index: number): boolean {
  const character = line[index];
  return character !== undefined && IDENTIFIER_CHARACTER.test(character);
}

/**
 * Split a run of highlighted text at identifier boundaries, so each identifier can be its own
 * pressable span. Highlight tokens are style runs, not words: `foo bar` in one colour is a single
 * token, and a press on it could not say which word was meant.
 */
export function splitIdentifiers(text: string): { text: string; isIdentifier: boolean }[] {
  const pieces: { text: string; isIdentifier: boolean }[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+/gu)) {
    pieces.push({ text: match[0], isIdentifier: IDENTIFIER_CHARACTER.test(match[0][0]) });
  }
  return pieces;
}
