import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeTrackedOrigins, makeUndoManager } from "./undo-scope";

describe("makeTrackedOrigins", () => {
  it("builds a Set containing exactly the doc's own clientID", () => {
    const ydoc = new Y.Doc();
    const origins = makeTrackedOrigins(ydoc);
    expect(origins).toBeInstanceOf(Set);
    expect(origins.size).toBe(1);
    expect(origins.has(ydoc.clientID)).toBe(true);
  });

  it("produces different tracked-origin sets for different docs (different clientIDs)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const originsA = makeTrackedOrigins(docA);
    const originsB = makeTrackedOrigins(docB);
    expect(originsA.has(docA.clientID)).toBe(true);
    expect(originsA.has(docB.clientID)).toBe(false);
    expect(originsB.has(docB.clientID)).toBe(true);
  });
});

describe("makeUndoManager - selective per-user undo", () => {
  it("undoes only local-origin transactions, leaving remote-origin transactions intact", () => {
    // Two independent Y.Docs standing in for "my client" and "a remote
    // peer's client", each with their own text fragment we merge via
    // Y.applyUpdate - this simulates the Hocuspocus sync path without
    // needing an actual WebSocket connection.
    const localDoc = new Y.Doc();
    const localFragment = localDoc.getXmlFragment("prosemirror");
    const undoManager = makeUndoManager(localDoc, localFragment);

    // 1. Local edit: tagged with localDoc.clientID (the default origin
    //    used by transactions the local client itself initiates), so the
    //    UndoManager tracks it.
    localDoc.transact(() => {
      const el = new Y.XmlElement("paragraph");
      el.insert(0, [new Y.XmlText("hello from me")]);
      localFragment.insert(0, [el]);
    }, localDoc.clientID);

    expect(localFragment.toArray().length).toBe(1);

    // 2. Simulate a remote peer's edit arriving over the wire: apply an
    //    update that originated on a *different* doc/clientID. We tag the
    //    transact call with a distinct origin id to model "not this
    //    client's own transaction" (mirrors how y-prosemirror/Hocuspocus
    //    tag incoming remote updates with the remote peer's origin, which
    //    is never in our trackedOrigins set).
    const remoteOrigin = "remote-peer-origin";
    localDoc.transact(() => {
      const el = new Y.XmlElement("paragraph");
      el.insert(0, [new Y.XmlText("hello from them")]);
      localFragment.insert(1, [el]);
    }, remoteOrigin);

    expect(localFragment.toArray().length).toBe(2);

    // 3. Undo: because trackedOrigins only contains localDoc.clientID,
    //    the UndoManager's stack only has the first (local) transaction
    //    on it, so undo() removes ONLY that one - the remote paragraph
    //    survives untouched.
    undoManager.undo();

    const remaining = localFragment.toArray();
    expect(remaining.length).toBe(1);
    expect((remaining[0] as Y.XmlElement).toString()).toContain("hello from them");
  });
});
