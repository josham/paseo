import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import type { SymbolActions, SymbolPosition } from "@/code-navigation/symbol-actions";
import { symbolAt } from "@/code-navigation/symbol";

interface SymbolHit extends SymbolPosition {
  from: number;
  to: number;
}

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-paseo-symbol-link" });

/**
 * The word under the pointer while Cmd/Ctrl is held. It is drawn from the text alone, at once,
 * so the affordance never waits on the language server.
 */
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setLink)) {
        next = effect.value
          ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const linkTheme = EditorView.baseTheme({
  ".cm-paseo-symbol-link": { textDecoration: "underline", cursor: "pointer" },
});

function symbolAtPosition(view: EditorView, position: number): SymbolHit | null {
  const line = view.state.doc.lineAt(position);
  const span = symbolAt(line.text, position - line.from);
  if (!span) return null;
  return {
    line: line.number - 1,
    character: span.start,
    symbol: span.text,
    from: line.from + span.start,
    to: line.from + span.end,
  };
}

function symbolAtPointer(view: EditorView, event: MouseEvent): SymbolHit | null {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  return position === null ? null : symbolAtPosition(view, position);
}

function symbolAtCaret(view: EditorView): SymbolHit | null {
  return symbolAtPosition(view, view.state.selection.main.head);
}

function isNavigationModifier(event: MouseEvent | KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function showLink(view: EditorView, hit: SymbolHit | null): void {
  const current = view.state.field(linkField).iter();
  const currentFrom = current.value ? current.from : null;
  const currentTo = current.value ? current.to : null;
  if (currentFrom === (hit?.from ?? null) && currentTo === (hit?.to ?? null)) return;
  view.dispatch({ effects: setLink.of(hit ? { from: hit.from, to: hit.to } : null) });
}

/**
 * Go to definition on Cmd/Ctrl+click and F12, Find usages on Shift+F12, and the symbol menu on
 * right click. `getActions` is read on every event so the view, created once, always reaches the
 * pane's current handlers; it returns null while the host cannot navigate, and then nothing here
 * intercepts anything.
 */
export function codeNavigationExtension(getActions: () => SymbolActions | null): Extension {
  function runAtCaret(action: "goToDefinition" | "findUsages") {
    return (view: EditorView) => {
      const actions = getActions();
      const hit = actions ? symbolAtCaret(view) : null;
      if (!actions || !hit) return false;
      actions[action](hit);
      return true;
    };
  }

  return [
    linkField,
    linkTheme,
    Prec.high(
      keymap.of([
        { key: "F12", run: runAtCaret("goToDefinition") },
        { key: "Shift-F12", run: runAtCaret("findUsages") },
      ]),
    ),
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const hit =
          getActions() && isNavigationModifier(event) ? symbolAtPointer(view, event) : null;
        showLink(view, hit);
        return false;
      },
      mouseleave(_event, view) {
        showLink(view, null);
        return false;
      },
      keyup(event, view) {
        if (!isNavigationModifier(event)) showLink(view, null);
        return false;
      },
      mousedown(event, view) {
        const actions = getActions();
        if (!actions || event.button !== 0 || !isNavigationModifier(event)) return false;
        const hit = symbolAtPointer(view, event);
        if (!hit) return false;
        // Cmd/Ctrl+click would otherwise add a cursor; navigation takes the gesture instead.
        event.preventDefault();
        showLink(view, null);
        actions.goToDefinition(hit);
        return true;
      },
      contextmenu(event, view) {
        const actions = getActions();
        const hit = actions ? symbolAtPointer(view, event) : null;
        if (!actions || !hit) return false;
        event.preventDefault();
        actions.openMenu(hit, { x: event.clientX, y: event.clientY });
        return true;
      },
    }),
  ];
}
