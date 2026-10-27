package protocol

import (
	"bytes"
	"testing"

	"github.com/gormalone/custom-workspace/sync/internal/lib0"
)

func TestDecodeSyncStep2(t *testing.T) {
	update := []byte{1, 2, 3, 4}
	msg := EncodeSyncStep2(update)
	env, err := Decode(msg)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.Type != MessageSync || env.SyncType != SyncStep2 {
		t.Fatalf("wrong types: %+v", env)
	}
	if !bytes.Equal(env.Payload, update) {
		t.Errorf("payload mismatch: %x vs %x", env.Payload, update)
	}
}

func TestDecodeSyncUpdate(t *testing.T) {
	update := []byte("some yjs update bytes")
	msg := EncodeSyncUpdate(update)
	env, err := Decode(msg)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.SyncType != SyncUpdate {
		t.Fatalf("want SyncUpdate, got %d", env.SyncType)
	}
	if !bytes.Equal(env.Payload, update) {
		t.Errorf("payload mismatch")
	}
}

func TestEncodeSyncStep1EmptyIsValidStateVector(t *testing.T) {
	msg := EncodeSyncStep1Empty()
	env, err := Decode(msg)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.SyncType != SyncStep1 {
		t.Fatalf("want SyncStep1, got %d", env.SyncType)
	}
	// A valid empty Yjs state vector is the single byte 0x00 ("0 clients"),
	// NOT a zero-length payload — see the doc comment on emptyStateVector for
	// why a real 0-byte payload crashes a genuine Yjs client's decoder.
	if !bytes.Equal(env.Payload, []byte{0x00}) {
		t.Errorf("want a valid empty state vector ([0x00]), got %x", env.Payload)
	}
}

// buildAwarenessPayload hand-encodes an awareness update the way y-protocols'
// encodeAwarenessUpdate does, so decodeAwareness can be tested against a
// realistic wire payload without depending on a JS runtime.
func buildAwarenessPayload(t *testing.T, entries []AwarenessUpdate) []byte {
	t.Helper()
	inner := lib0.NewEncoder()
	inner.WriteVarUint(uint64(len(entries)))
	for _, e := range entries {
		inner.WriteVarUint(e.ClientID)
		inner.WriteVarUint(e.Clock)
		inner.WriteVarString(e.State)
	}
	return inner.Bytes()
}

func TestDecodeAwareness(t *testing.T) {
	want := []AwarenessUpdate{
		{ClientID: 42, Clock: 1, State: `{"cursor":{"x":1,"y":2}}`},
		{ClientID: 7, Clock: 3, State: "null"},
	}
	payload := buildAwarenessPayload(t, want)
	msg := EncodeAwareness(payload)

	env, err := Decode(msg)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.Type != MessageAwareness {
		t.Fatalf("want MessageAwareness, got %d", env.Type)
	}
	if len(env.Awareness) != len(want) {
		t.Fatalf("want %d entries, got %d", len(want), len(env.Awareness))
	}
	for i, e := range want {
		if env.Awareness[i] != e {
			t.Errorf("entry %d: want %+v, got %+v", i, e, env.Awareness[i])
		}
	}
	// RawAwareness must be relayed byte-identical so clients can decode it
	// with their own (richer) awareness parser without any lossy re-encoding.
	if !bytes.Equal(env.RawAwareness, payload) {
		t.Errorf("RawAwareness was not preserved verbatim")
	}
}

func TestEncodeAwarenessRemoval(t *testing.T) {
	msg := EncodeAwarenessRemoval([]uint64{5, 9})
	env, err := Decode(msg)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(env.Awareness) != 2 {
		t.Fatalf("want 2 entries, got %d", len(env.Awareness))
	}
	for i, id := range []uint64{5, 9} {
		if env.Awareness[i].ClientID != id || env.Awareness[i].State != "null" {
			t.Errorf("entry %d: want clientID=%d state=null, got %+v", i, id, env.Awareness[i])
		}
	}
}

func TestDecodeUnknownMessageTypeDoesNotError(t *testing.T) {
	e := lib0.NewEncoder()
	e.WriteVarUint(99) // not a type this server understands (forward-compat)
	env, err := Decode(e.Bytes())
	if err != nil {
		t.Fatalf("unexpected error on forward-compatible unknown type: %v", err)
	}
	if env.Type != 99 {
		t.Errorf("want type 99, got %d", env.Type)
	}
}
