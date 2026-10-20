import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  FlatList,
  Text,
  View,
  type GestureResponderEvent,
  type ListRenderItem,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { highlightCode, type HighlightStyle, type HighlightToken } from "@getpaseo/highlight";
import { Button } from "@/components/ui/button";
import { splitIdentifiers } from "@/code-navigation/symbol";
import type { SymbolActions } from "@/code-navigation/symbol-actions";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { selectSourcePresentation } from "./presentation";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
  symbolActions: SymbolActions | null;
  /**
   * A long press on a symbol opens its actions, which takes the gesture native text selection
   * uses. While this is on, lines are selectable again and symbols do not respond.
   */
  selectingText: boolean;
  onDoneSelectingText: () => void;
}

interface SourceLine {
  number: number;
  tokens: HighlightToken[];
}

interface LinePiece {
  text: string;
  style: HighlightStyle | null;
  /** UTF-16 offset of the piece within its line. */
  start: number;
  isIdentifier: boolean;
}

export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  size,
  tooLargeMessage,
  symbolActions,
  selectingText,
  onDoneSelectingText,
}: FileSourceViewProps) {
  const presentation = selectSourcePresentation({ size, platform: "native" });
  if (presentation === "unsupported") {
    return (
      <View style={styles.unsupported} testID="file-source-too-large">
        <Text style={styles.unsupportedText}>{tooLargeMessage}</Text>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      {selectingText ? <SelectingTextBar onDone={onDoneSelectingText} /> : null}
      <VirtualizedSource
        content={content}
        filename={filename}
        location={location}
        navigationRevision={navigationRevision}
        presentation={presentation}
        symbolActions={selectingText ? null : symbolActions}
      />
    </View>
  );
}

function SelectingTextBar({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.selectingBar} testID="file-source-selecting-text">
      <Text style={styles.selectingHint}>{t("panels.codeNavigation.selectingHint")}</Text>
      <Button size="sm" variant="ghost" onPress={onDone} testID="file-source-done-selecting">
        {t("panels.codeNavigation.doneSelecting")}
      </Button>
    </View>
  );
}

function VirtualizedSource({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  symbolActions,
}: Pick<
  FileSourceViewProps,
  "content" | "filename" | "location" | "navigationRevision" | "symbolActions"
> & {
  presentation: "highlighted" | "plain";
}) {
  const listRef = useRef<FlatList<SourceLine>>(null);
  const lines = useMemo(() => {
    if (presentation === "highlighted")
      return highlightCode(content, filename).map((tokens, index) => ({
        number: index + 1,
        tokens,
      }));
    return content
      .split("\n")
      .map((text, index) => ({ number: index + 1, tokens: [{ text, style: null }] }));
  }, [content, filename, presentation]);
  useEffect(() => {
    if (!location.lineStart) return;
    listRef.current?.scrollToIndex({
      index: Math.min(location.lineStart - 1, lines.length - 1),
      animated: false,
      viewPosition: 0.5,
    });
  }, [lines.length, location.lineStart, navigationRevision]);
  const renderItem = useCallback<ListRenderItem<SourceLine>>(
    ({ item }) =>
      symbolActions ? (
        <NavigableSourceLine line={item} actions={symbolActions} />
      ) : (
        <SelectableSourceLine line={item} />
      ),
    [symbolActions],
  );
  return (
    <FlatList
      ref={listRef}
      data={lines}
      extraData={symbolActions}
      keyExtractor={sourceLineKey}
      initialNumToRender={24}
      windowSize={9}
      getItemLayout={sourceLineLayout}
      renderItem={renderItem}
    />
  );
}

function SelectableSourceLine({ line }: { line: SourceLine }) {
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{line.number}</Text>
      <Text selectable style={styles.text}>
        {line.tokens.map((token) => (
          <Text key={`${token.style}:${token.text}`} style={syntaxTokenStyleFor(token.style)}>
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/** Each identifier is its own span, so a long press knows exactly which symbol it landed on. */
function NavigableSourceLine({ line, actions }: { line: SourceLine; actions: SymbolActions }) {
  const pieces = useMemo(() => splitLine(line.tokens), [line.tokens]);
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{line.number}</Text>
      <Text style={styles.text}>
        {pieces.map((piece) =>
          piece.isIdentifier ? (
            <IdentifierSpan
              key={piece.start}
              piece={piece}
              lineIndex={line.number - 1}
              actions={actions}
            />
          ) : (
            <Text key={piece.start} style={syntaxTokenStyleFor(piece.style)}>
              {piece.text}
            </Text>
          ),
        )}
      </Text>
    </View>
  );
}

function IdentifierSpan({
  piece,
  lineIndex,
  actions,
}: {
  piece: LinePiece;
  lineIndex: number;
  actions: SymbolActions;
}) {
  const openMenu = useCallback(
    (event: GestureResponderEvent) =>
      actions.openMenu(
        { line: lineIndex, character: piece.start, symbol: piece.text },
        { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
      ),
    [actions, lineIndex, piece.start, piece.text],
  );
  return (
    <Text style={syntaxTokenStyleFor(piece.style)} onLongPress={openMenu} suppressHighlighting>
      {piece.text}
    </Text>
  );
}

function splitLine(tokens: readonly HighlightToken[]): LinePiece[] {
  const pieces: LinePiece[] = [];
  let offset = 0;
  for (const token of tokens) {
    for (const part of splitIdentifiers(token.text)) {
      pieces.push({ ...part, style: token.style, start: offset });
      offset += part.text.length;
    }
  }
  return pieces;
}

function sourceLineKey(line: SourceLine): string {
  return String(line.number);
}

function sourceLineLayout(_data: ArrayLike<SourceLine> | null | undefined, index: number) {
  return { length: 20, offset: index * 20, index };
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  unsupported: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
  selectingBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  selectingHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  line: { flexDirection: "row", minHeight: theme.fontSize.code * 1.45 },
  gutter: {
    width: 56,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  text: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.45,
  },
}));
