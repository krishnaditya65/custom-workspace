package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Persister is the subset of store.Store that Room needs, extracted as an
// interface so write-behind debounce logic can be unit tested with a fake
// (see room_test.go) instead of a real Postgres connection.
type Persister interface {
	SaveSnapshot(ctx context.Context, documentID string, blobs [][]byte) error
}

// Room holds the in-memory state for one collaborative document ("doc:<id>")
// or whiteboard ("board:<id>"): the connected clients and the ordered log of
// raw Yjs update blobs applied since the room was loaded (see store.Store for
// why blobs are kept discrete rather than merged). A Room is created lazily on
// first connection and torn down when its last client disconnects, after a
// final synchronous flush — mirroring Hocuspocus's onLoadDocument /
// afterUnloadDocument lifecycle from the original Node design.
type Room struct {
	ID          string
	DocumentID  string
	WorkspaceID string

	mu      sync.Mutex
	clients map[*Client]struct{}
	log     [][]byte
	dirty   bool

	debounce     time.Duration
	flushTimer   *time.Timer
	pendingFlush bool

	store  Persister
	logger *slog.Logger
}

func newRoom(id, documentID, workspaceID string, debounce time.Duration, st Persister, logger *slog.Logger) *Room {
	return &Room{
		ID:          id,
		DocumentID:  documentID,
		WorkspaceID: workspaceID,
		clients:     make(map[*Client]struct{}),
		debounce:    debounce,
		store:       st,
		logger:      logger,
	}
}

// snapshotBlobs returns a copy of the current log for sending to a newly
// joined client (each blob replayed as its own syncStep2 message, see hub.go).
func (r *Room) snapshotBlobs() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([][]byte, len(r.log))
	for i, b := range r.log {
		out[i] = append([]byte(nil), b...) // deep copy — caller must not be able to mutate our log
	}
	return out
}

// appendUpdate records a new update blob and (re)starts the write-behind
// debounce timer. Mirrors the write-behind strategy from the system design:
// "commits a compressed binary snapshot every 10 seconds or when the last
// user disconnects" — DEBOUNCE_MS is configurable via SNAPSHOT_DEBOUNCE_MS so
// tests can use a short interval instead of waiting 10 real seconds.
func (r *Room) appendUpdate(update []byte) {
	r.mu.Lock()
	r.log = append(r.log, append([]byte(nil), update...))
	r.dirty = true
	if r.flushTimer != nil {
		r.flushTimer.Stop()
	}
	r.flushTimer = time.AfterFunc(r.debounce, r.flushAsync)
	r.mu.Unlock()
}

func (r *Room) flushAsync() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Flush(ctx); err != nil {
		r.logger.Error("room: debounced flush failed", "room", r.ID, "err", err)
	}
}

// Flush persists the current log synchronously if there are unflushed changes.
// Called on the debounce timer, and immediately (bypassing the timer) when the
// last client disconnects, so no edits are lost between the final disconnect
// and the next 10s tick.
func (r *Room) Flush(ctx context.Context) error {
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return nil
	}
	blobs := make([][]byte, len(r.log))
	copy(blobs, r.log)
	r.dirty = false
	if r.flushTimer != nil {
		r.flushTimer.Stop()
	}
	r.mu.Unlock()

	return r.store.SaveSnapshot(ctx, r.DocumentID, blobs)
}

// AddClient registers a newly-connected client with the room.
func (r *Room) AddClient(c *Client) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[c] = struct{}{}
	return len(r.clients)
}

// removeClient returns the number of remaining clients after removal.
func (r *Room) removeClient(c *Client) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, c)
	return len(r.clients)
}

func (r *Room) broadcastLocal(from *Client, payload []byte) {
	r.mu.Lock()
	targets := make([]*Client, 0, len(r.clients))
	for c := range r.clients {
		if c != from {
			targets = append(targets, c)
		}
	}
	r.mu.Unlock()
	for _, c := range targets {
		c.send(payload)
	}
}

func (r *Room) broadcastAll(payload []byte) {
	r.broadcastLocal(nil, payload)
}
