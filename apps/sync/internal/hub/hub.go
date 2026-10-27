package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/gormalone/custom-workspace/sync/internal/redisbus"
)

// DocumentStore is everything Hub needs from storage: Persister (used per-Room
// for write-behind flushes) plus the ability to hydrate a brand new Room from
// its latest snapshot. store.Store satisfies this; tests can supply a fake.
type DocumentStore interface {
	Persister
	LoadLatestSnapshot(ctx context.Context, documentID string) ([][]byte, error)
}

// Hub owns every live Room on this instance and bridges local broadcasts to
// the Redis pub/sub bus for cross-instance fan-out (see redisbus.Bus doc).
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room

	store    DocumentStore
	bus      *redisbus.Bus
	debounce time.Duration
	logger   *slog.Logger
}

func New(st DocumentStore, bus *redisbus.Bus, debounce time.Duration, logger *slog.Logger) *Hub {
	h := &Hub{rooms: make(map[string]*Room), store: st, bus: bus, debounce: debounce, logger: logger}
	if bus != nil {
		bus.Subscribe(context.Background(), h.onRemoteMessage)
	}
	return h
}

// onRemoteMessage is invoked for every pub/sub event published by another
// instance. It rebroadcasts to this instance's local clients only — the
// originating instance already handled its own local clients directly.
func (h *Hub) onRemoteMessage(m redisbus.Message) {
	h.mu.Lock()
	room, ok := h.rooms[m.RoomID]
	h.mu.Unlock()
	if !ok {
		return // no local clients care about this room right now
	}
	if m.Kind == "update" {
		room.appendUpdate(m.Data) // keep our in-memory log consistent for future joiners
	}
	room.broadcastAll(m.Data)
}

// GetOrLoadRoom returns the in-memory Room for a document, loading its latest
// snapshot from Postgres on first access (equivalent to Hocuspocus's
// onLoadDocument hook in the original Node design).
func (h *Hub) GetOrLoadRoom(ctx context.Context, roomID, documentID, workspaceID string) (*Room, error) {
	h.mu.Lock()
	if room, ok := h.rooms[roomID]; ok {
		h.mu.Unlock()
		return room, nil
	}
	h.mu.Unlock()

	blobs, err := h.store.LoadLatestSnapshot(ctx, documentID)
	if err != nil {
		return nil, err
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[roomID]; ok {
		return room, nil // another goroutine loaded it first
	}
	room := newRoom(roomID, documentID, workspaceID, h.debounce, h.store, h.logger)
	room.log = blobs
	h.rooms[roomID] = room
	return room, nil
}

// ReleaseIfEmpty flushes and evicts a room once its last client has left,
// mirroring afterUnloadDocument: the final write-behind flush point.
func (h *Hub) ReleaseIfEmpty(room *Room) {
	h.mu.Lock()
	remaining := len(room.clients)
	if remaining == 0 {
		delete(h.rooms, room.ID)
	}
	h.mu.Unlock()

	if remaining == 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := room.Flush(ctx); err != nil {
			h.logger.Error("hub: final flush on unload failed", "room", room.ID, "err", err)
		}
	}
}

// Publish fans a local event out to other instances via Redis, if configured.
func (h *Hub) Publish(roomID, kind string, data []byte) {
	if h.bus == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.bus.Publish(ctx, roomID, kind, data); err != nil {
		h.logger.Warn("hub: redis publish failed", "err", err)
	}
}
