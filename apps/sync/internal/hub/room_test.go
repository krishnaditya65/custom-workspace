package hub

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// fakePersister records every SaveSnapshot call so tests can assert on write
// count and content without a real Postgres connection.
type fakePersister struct {
	mu    sync.Mutex
	calls [][][]byte
}

func (f *fakePersister) SaveSnapshot(_ context.Context, _ string, blobs [][]byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([][]byte, len(blobs))
	copy(cp, blobs)
	f.calls = append(f.calls, cp)
	return nil
}

// LoadLatestSnapshot is a no-op so *fakePersister also satisfies DocumentStore
// for tests (TestDisconnectFlushesImmediatelyWithoutWaitingFullDebounce) that
// construct a real Hub rather than a bare Room.
func (f *fakePersister) LoadLatestSnapshot(_ context.Context, _ string) ([][]byte, error) {
	return nil, nil
}

func (f *fakePersister) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestDebouncedFlushCoalescesRapidUpdates proves the core write-behind claim
// from the system design: "commits a compressed binary snapshot every 10
// seconds ... Saving every single keystroke would destroy the database." Ten
// rapid updates within the debounce window must produce exactly one write.
func TestDebouncedFlushCoalescesRapidUpdates(t *testing.T) {
	fp := &fakePersister{}
	room := newRoom("doc:test", "doc-1", "ws-1", 50*time.Millisecond, fp, silentLogger())

	for i := 0; i < 10; i++ {
		room.appendUpdate([]byte{byte(i)})
		time.Sleep(5 * time.Millisecond) // well inside the 50ms debounce window
	}

	if got := fp.callCount(); got != 0 {
		t.Fatalf("expected no flush yet (still inside debounce window), got %d calls", got)
	}

	time.Sleep(80 * time.Millisecond) // let the debounce timer fire
	if got := fp.callCount(); got != 1 {
		t.Fatalf("want exactly 1 debounced flush after 10 rapid updates, got %d", got)
	}
	if got := len(fp.calls[0]); got != 10 {
		t.Fatalf("want all 10 blobs in the single flush, got %d", got)
	}
}

// TestFlushIsNoOpWhenClean proves a debounce tick with no new updates since
// the last flush does not perform a redundant write.
func TestFlushIsNoOpWhenClean(t *testing.T) {
	fp := &fakePersister{}
	room := newRoom("doc:test", "doc-1", "ws-1", time.Hour, fp, silentLogger())

	if err := room.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if got := fp.callCount(); got != 0 {
		t.Fatalf("want 0 calls on a clean room, got %d", got)
	}

	room.appendUpdate([]byte{1})
	if err := room.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := room.Flush(context.Background()); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	if got := fp.callCount(); got != 1 {
		t.Fatalf("want exactly 1 call (second Flush should be a no-op, room is clean again), got %d", got)
	}
}

// TestDisconnectFlushesImmediatelyWithoutWaitingFullDebounce proves the other
// half of the write-behind rule: "...or when the last user disconnects."
func TestDisconnectFlushesImmediatelyWithoutWaitingFullDebounce(t *testing.T) {
	fp := &fakePersister{}
	h := New(fp, nil, time.Hour, silentLogger()) // 1h debounce: only the disconnect path should ever flush
	room := newRoom("doc:test", "doc-1", "ws-1", time.Hour, fp, silentLogger())
	h.rooms["doc:test"] = room

	room.appendUpdate([]byte{9, 9, 9})
	h.ReleaseIfEmpty(room) // simulates the last client's close() path

	if got := fp.callCount(); got != 1 {
		t.Fatalf("want immediate flush on last-client-disconnect, got %d calls", got)
	}
}

// TestSnapshotBlobsIsASafeCopy ensures a caller mutating the returned slice
// can't corrupt the room's internal log — snapshotBlobs feeds directly into
// what gets sent over the wire to newly-joined clients.
func TestSnapshotBlobsIsASafeCopy(t *testing.T) {
	fp := &fakePersister{}
	room := newRoom("doc:test", "doc-1", "ws-1", time.Hour, fp, silentLogger())
	room.appendUpdate([]byte{1, 2, 3})

	blobs := room.snapshotBlobs()
	blobs[0][0] = 0xFF // mutate the copy

	fresh := room.snapshotBlobs()
	if fresh[0][0] != 1 {
		t.Fatalf("internal log was mutated via snapshotBlobs, want isolated copy")
	}
}
