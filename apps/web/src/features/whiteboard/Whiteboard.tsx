import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { authState } from "../../lib/auth-store";

// -----------------------------------------------------------------------
// Whiteboard.tsx - "infinite shared whiteboard".
//
// *** RENDERING ARCHITECTURE NOTE (read before touching perf) ***
// This renders with plain Canvas2D (`CanvasRenderingContext2D`), NOT
// WebGL/PixiJS. That's a deliberate, documented simplification versus the
// target architecture (a PixiJS `Application` with one `Graphics`/`Sprite`
// object per shape, GPU-batched). Canvas2D redraws every shape imperatively
// on every relevant update (an awareness change, a Y.Map shape mutation, or
// a viewport pan/zoom), which is plenty fast for small-to-moderate shape
// counts but starts to show frame drops somewhere around a few hundred
// concurrent shapes since there's no batching/culling beyond the simple
// viewport check below.
//
// The documented upgrade path once you cross that threshold: replace the
// canvas element + `renderShapes()` below with a PixiJS `Application`
// whose stage holds one `Graphics` (or `Sprite`, for pre-rasterized
// shapes) child per shape id, updated in place instead of redrawn from
// scratch, with PixiJS handling GPU batching/culling. The reason
// `renderShapes(ctx, shapes, viewport)` is pulled out as its own pure
// function (rather than inlined in the render loop) is specifically so
// that swap is localized to one function body - the Yjs sync, awareness,
// and tool-state code around it does not need to change at all.
// -----------------------------------------------------------------------

export type ShapeType = "rectangle" | "ellipse" | "sticky" | "pen";

export interface Shape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  points?: number[]; // flat [x0,y0,x1,y1,...] for freehand pen strokes
  text?: string; // sticky-note content
}

export interface Viewport {
  x: number; // world-space pan offset
  y: number;
  zoom: number;
}

interface RemoteCursor {
  clientId: number;
  name: string;
  color: string;
  x: number;
  y: number;
}

/**
 * Pure render function - isolated on purpose (see file header). Draws every
 * shape in `shapes` into `ctx`, applying `viewport`'s pan/zoom transform.
 * No Yjs/awareness/DOM-event code lives in here: swapping this out for a
 * PixiJS render path only requires replicating this function's contract
 * (shapes + viewport in, pixels out).
 */
export function renderShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  viewport: Viewport,
): void {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // World -> screen transform: translate by -pan, then scale by zoom.
  ctx.translate(width / 2, height / 2);
  ctx.scale(viewport.zoom, viewport.zoom);
  ctx.translate(-viewport.x, -viewport.y);

  for (const shape of shapes) {
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = 2 / viewport.zoom;

    switch (shape.type) {
      case "rectangle":
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
        break;
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(
          shape.x + shape.w / 2,
          shape.y + shape.h / 2,
          Math.abs(shape.w) / 2,
          Math.abs(shape.h) / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        break;
      }
      case "sticky": {
        ctx.globalAlpha = 0.85;
        ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#222";
        ctx.font = `${14 / viewport.zoom}px sans-serif`;
        wrapText(ctx, shape.text ?? "", shape.x + 8, shape.y + 20, shape.w - 16, 16 / viewport.zoom);
        break;
      }
      case "pen": {
        if (!shape.points || shape.points.length < 4) break;
        ctx.beginPath();
        ctx.moveTo(shape.points[0], shape.points[1]);
        for (let i = 2; i < shape.points.length; i += 2) {
          ctx.lineTo(shape.points[i], shape.points[i + 1]);
        }
        ctx.stroke();
        break;
      }
    }
  }

  ctx.restore();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(" ");
  let line = "";
  let cursorY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}

function hashToHue(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export default function Whiteboard(props: { boardId: string; wsUrl: string }) {
  let canvasEl: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | undefined;
  let provider: HocuspocusProvider | undefined;
  let shapesMap: Y.Map<Shape> | undefined;

  const [shapes, setShapes] = createSignal<Shape[]>([]);
  const [viewport, setViewport] = createSignal<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = createSignal<ShapeType>("rectangle");
  const [remoteCursors, setRemoteCursors] = createSignal<RemoteCursor[]>([]);
  const [drawing, setDrawing] = createSignal(false);

  let currentShapeId: string | null = null;
  let panStart: { x: number; y: number; vpX: number; vpY: number } | null = null;
  let isPanning = false;

  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const currentViewport = viewport();
    const rect = canvasEl!.getBoundingClientRect();
    const offsetX = sx - rect.left - rect.width / 2;
    const offsetY = sy - rect.top - rect.height / 2;
    return {
      x: offsetX / currentViewport.zoom + currentViewport.x,
      y: offsetY / currentViewport.zoom + currentViewport.y,
    };
  }

  function redraw() {
    if (!ctx || !canvasEl) return;
    renderShapes(ctx, shapes(), viewport());
  }

  onMount(() => {
    const user = authState().user;
    const token = authState().accessToken ?? "";
    const userId = user?.id ?? "anonymous";
    const userName = user?.name ?? user?.email ?? "Anonymous";
    const color = `hsl(${hashToHue(userId)}, 70%, 50%)`;

    const ydoc = new Y.Doc();
    const indexeddbProvider = new IndexeddbPersistence(`board:${props.boardId}`, ydoc);

    // Same Hocuspocus sync pattern as CollabEditor.tsx, just a different
    // doc name prefix (`board:` vs `doc:`) per the documented contract, and
    // shape state lives in a Y.Map instead of a Y.XmlFragment since a
    // whiteboard's data model is "a bag of shapes by id" rather than a
    // linear rich-text structure.
    provider = new HocuspocusProvider({
      url: props.wsUrl,
      name: `board:${props.boardId}`,
      token,
      document: ydoc,
    });

    provider.awareness?.setLocalStateField("user", { id: userId, name: userName, color });

    shapesMap = ydoc.getMap<Shape>("shapes");

    function syncShapesFromDoc() {
      setShapes(Array.from(shapesMap!.values()));
    }
    shapesMap.observe(syncShapesFromDoc);
    syncShapesFromDoc();

    function readCursors() {
      const states = provider!.awareness?.getStates() ?? new Map();
      const cursors: RemoteCursor[] = [];
      states.forEach((state: any, clientId: number) => {
        if (clientId === ydoc.clientID) return;
        const remoteUser = state.user;
        const pos = state.position;
        if (remoteUser && pos) {
          cursors.push({ clientId, name: remoteUser.name, color: remoteUser.color, x: pos.x, y: pos.y });
        }
      });
      setRemoteCursors(cursors);
    }
    provider.awareness?.on("change", readCursors);
    readCursors();

    // Resize canvas to its container and set up the render loop: redraw
    // whenever shapes or viewport change (Solid's reactivity drives this
    // rather than a rAF loop, since redraws are cheap and infrequent
    // compared to a game-style render loop - see file header re: perf
    // ceiling).
    function resize() {
      if (!canvasEl) return;
      const parent = canvasEl.parentElement;
      canvasEl.width = parent?.clientWidth ?? 800;
      canvasEl.height = parent?.clientHeight ?? 600;
      redraw();
    }
    ctx = canvasEl!.getContext("2d") ?? undefined;
    resize();
    window.addEventListener("resize", resize);

    createEffect(() => {
      // Track both signals so any change triggers a redraw.
      shapes();
      viewport();
      redraw();
    });

    onCleanup(() => {
      window.removeEventListener("resize", resize);
      shapesMap?.unobserve(syncShapesFromDoc);
      provider?.awareness?.off("change", readCursors);
      provider?.destroy();
      indexeddbProvider.destroy();
    });
  });

  function handlePointerDown(e: PointerEvent) {
    if (e.button === 1 || e.shiftKey) {
      // Middle-click or shift-drag pans the infinite canvas.
      isPanning = true;
      const currentViewport = viewport();
      panStart = { x: e.clientX, y: e.clientY, vpX: currentViewport.x, vpY: currentViewport.y };
      return;
    }

    const world = screenToWorld(e.clientX, e.clientY);
    const id = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    currentShapeId = id;
    setDrawing(true);

    const currentTool = tool();
    const shape: Shape =
      currentTool === "pen"
        ? { id, type: "pen", x: world.x, y: world.y, w: 0, h: 0, color: "#3b82f6", points: [world.x, world.y] }
        : currentTool === "sticky"
          ? { id, type: "sticky", x: world.x, y: world.y, w: 160, h: 120, color: "#fde68a", text: "" }
          : { id, type: currentTool, x: world.x, y: world.y, w: 0, h: 0, color: "#3b82f6" };

    shapesMap?.set(id, shape);
  }

  function handlePointerMove(e: PointerEvent) {
    // Broadcast this user's world-space cursor position via awareness.
    // This XY feed is exactly what the spatial-audio gain calculator
    // (src/features/spatial-audio/gain.ts) would consume - `computeGain(myPos,
    // theirPos)` - to attenuate a huddle participant's audio based on how
    // far apart two users' cursors are on the board, even though this app
    // doesn't wire real audio tracks to it (see Huddle.tsx for where
    // LiveKit tracks would need to plug in for that to become real).
    const world = screenToWorld(e.clientX, e.clientY);
    provider?.awareness?.setLocalStateField("position", { x: world.x, y: world.y });

    if (isPanning && panStart) {
      const dx = (e.clientX - panStart.x) / viewport().zoom;
      const dy = (e.clientY - panStart.y) / viewport().zoom;
      setViewport((vp) => ({ ...vp, x: panStart!.vpX - dx, y: panStart!.vpY - dy }));
      return;
    }

    if (!drawing() || !currentShapeId || !shapesMap) return;
    const existing = shapesMap.get(currentShapeId);
    if (!existing) return;

    if (existing.type === "pen") {
      shapesMap.set(currentShapeId, {
        ...existing,
        points: [...(existing.points ?? []), world.x, world.y],
      });
    } else {
      shapesMap.set(currentShapeId, {
        ...existing,
        w: world.x - existing.x,
        h: world.y - existing.y,
      });
    }
  }

  function handlePointerUp() {
    isPanning = false;
    panStart = null;
    setDrawing(false);
    currentShapeId = null;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setViewport((vp) => ({ ...vp, zoom: Math.min(4, Math.max(0.2, vp.zoom * factor)) }));
  }

  return (
    <div class="whiteboard">
      <div class="whiteboard__toolbar">
        <For each={["rectangle", "ellipse", "sticky", "pen"] as ShapeType[]}>
          {(t) => (
            <button classList={{ active: tool() === t }} onClick={() => setTool(t)}>
              {t}
            </button>
          )}
        </For>
      </div>

      <div class="whiteboard__surface">
        <canvas
          ref={canvasEl}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onWheel={handleWheel}
        />
        <For each={remoteCursors()}>
          {(cursor) => {
            // Project the remote cursor's world position back to screen
            // space for display, using the local viewport transform. Wrapped
            // in a createMemo (rather than a plain computed variable) so it
            // stays reactive to `viewport()` changes (pan/zoom) even though
            // <For>'s per-item callback itself only re-runs when the
            // `remoteCursors()` array's identity for this item changes.
            const screen = createMemo(() => {
              const currentViewport = viewport();
              return {
                x: (cursor.x - currentViewport.x) * currentViewport.zoom + (canvasEl?.clientWidth ?? 0) / 2,
                y: (cursor.y - currentViewport.y) * currentViewport.zoom + (canvasEl?.clientHeight ?? 0) / 2,
              };
            });
            return (
              <div
                class="whiteboard__remote-cursor"
                style={{ left: `${screen().x}px`, top: `${screen().y}px`, "border-color": cursor.color }}
              >
                {cursor.name}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
