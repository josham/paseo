/** A symbol in the open document, as the viewer found it under a pointer or the caret. */
export interface SymbolPosition {
  /** Zero-based. */
  line: number;
  /** Zero-based UTF-16 offset of the symbol's first character. */
  character: number;
  symbol: string;
}

/** What a source view can ask for once it knows which symbol was meant. */
export interface SymbolActions {
  goToDefinition(position: SymbolPosition): void;
  findUsages(position: SymbolPosition): void;
  /** Open the symbol's action menu at a point in page coordinates. */
  openMenu(position: SymbolPosition, point: { x: number; y: number }): void;
}
