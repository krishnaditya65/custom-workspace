import * as Y from "yjs";

// -----------------------------------------------------------------------
// undo-scope.ts
//
// Extracted as a small, pure, framework-free helper (no ProseMirror, no
// Solid, no network) specifically so the "selective per-user undo" logic
// is unit-testable without mounting a full editor - see undo-scope.spec.ts.
//
// The core idea: a `Y.UndoManager` scoped to `trackedOrigins: new
// Set([ydoc.clientID])` only records/undoes transactions whose origin is
// this client's own clientID. Any transaction applied with a different
// origin (e.g. a remote peer's update arriving over the Hocuspocus
// WebSocket, which y-prosemirror/HocuspocusProvider tag with that peer's
// own origin) is invisible to this UndoManager - so pressing Ctrl/Cmd+Z
// never undoes a collaborator's edit, only your own. That's "selective
// per-user undo".
// -----------------------------------------------------------------------

/**
 * Builds the `trackedOrigins` set used to scope a `Y.UndoManager` to a
 * single client's own edits. Exists as its own function (rather than an
 * inline literal) purely so tests can assert on its output directly.
 */
export function makeTrackedOrigins(ydoc: Y.Doc): Set<unknown> {
  return new Set<unknown>([ydoc.clientID]);
}

/**
 * Constructs a `Y.UndoManager` scoped to `fragment`, tracking only
 * transactions whose origin is `ydoc.clientID` (i.e. this client's own
 * local edits, including those made via y-prosemirror's ySyncPlugin,
 * which tags local ProseMirror transactions with the doc's own
 * clientID-derived binding origin by default when no other origin is
 * supplied).
 *
 * This is what CollabEditor.tsx wires into y-prosemirror's `yUndoPlugin`
 * so Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z only ever undo/redo the local user's
 * own changes.
 */
export function makeUndoManager(
  ydoc: Y.Doc,
  fragment: Y.AbstractType<any>,
): Y.UndoManager {
  return new Y.UndoManager(fragment, {
    trackedOrigins: makeTrackedOrigins(ydoc),
  });
}
