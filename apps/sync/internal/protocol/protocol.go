// Package protocol implements the y-websocket wire protocol on top of lib0
// framing: the sync sub-protocol (y-protocols/sync) and the awareness
// sub-protocol (y-protocols/awareness). Every message on the socket is one
// binary WebSocket frame containing a single top-level message.
package protocol

import (
	"github.com/gormalone/custom-workspace/sync/internal/lib0"
)

// Top-level message types (y-websocket MESSAGE_SYNC / MESSAGE_AWARENESS).
const (
	MessageSync      uint64 = 0
	MessageAwareness uint64 = 1
)

// Sync sub-message types (y-protocols/sync).
const (
	SyncStep1  uint64 = 0 // payload: sender's state vector (opaque to this server)
	SyncStep2  uint64 = 1 // payload: an update bringing the peer up to date
	SyncUpdate uint64 = 2 // payload: an incremental update to apply & relay
)

// Envelope is a decoded top-level message. Payload is left as opaque bytes for
// Sync messages (this server never inspects Yjs update contents, only relays
// and archives them — see docs/ARCHITECTURE.md) and is parsed into Updates for
// Awareness messages, since the server DOES need client IDs from those to clean
// up stale cursors on disconnect.
type Envelope struct {
	Type         uint64
	SyncType     uint64 // valid when Type == MessageSync
	Payload      []byte // raw bytes to relay/store verbatim for MessageSync
	Awareness    []AwarenessUpdate
	RawAwareness []byte // original bytes, relayed verbatim to other clients
}

type AwarenessUpdate struct {
	ClientID uint64
	Clock    uint64
	State    string // JSON-encoded state, or "null" for "this client went away"
}

// Decode parses one top-level protocol message.
func Decode(msg []byte) (*Envelope, error) {
	d := lib0.NewDecoder(msg)
	typ, err := d.ReadVarUint()
	if err != nil {
		return nil, err
	}
	env := &Envelope{Type: typ}
	switch typ {
	case MessageSync:
		syncType, err := d.ReadVarUint()
		if err != nil {
			return nil, err
		}
		payload, err := d.ReadVarUint8Array()
		if err != nil {
			return nil, err
		}
		env.SyncType = syncType
		env.Payload = payload
	case MessageAwareness:
		payload, err := d.ReadVarUint8Array()
		if err != nil {
			return nil, err
		}
		env.RawAwareness = payload
		env.Awareness, err = decodeAwareness(payload)
		if err != nil {
			return nil, err
		}
	}
	return env, nil
}

func decodeAwareness(payload []byte) ([]AwarenessUpdate, error) {
	d := lib0.NewDecoder(payload)
	n, err := d.ReadVarUint()
	if err != nil {
		return nil, err
	}
	updates := make([]AwarenessUpdate, 0, n)
	for i := uint64(0); i < n; i++ {
		clientID, err := d.ReadVarUint()
		if err != nil {
			return nil, err
		}
		clock, err := d.ReadVarUint()
		if err != nil {
			return nil, err
		}
		state, err := d.ReadVarString()
		if err != nil {
			return nil, err
		}
		updates = append(updates, AwarenessUpdate{ClientID: clientID, Clock: clock, State: state})
	}
	return updates, nil
}

// EncodeSyncStep1Empty builds a syncStep1 message carrying our state vector.
// This server does not maintain a real Yjs state vector (see
// ARCHITECTURE.md), so it always advertises an empty one — "I have nothing
// you need to diff against, send me your full state" — valid per protocol,
// costing one extra round trip of (harmless, idempotent) data versus a
// byte-perfect diff.
//
// IMPORTANT: a Yjs state vector is itself a lib0-encoded map and an *empty*
// map is NOT zero bytes — it's the single byte 0x00, i.e. writeVarUint(0)
// encoding "0 clients". Y.encodeStateAsUpdate() reads that leading varUint
// unconditionally, so handing it a genuinely zero-length payload makes the
// client-side decoder run readVarUint() past the end of the buffer and throw
// (caught the hard way — see docs/TESTING.md's note on this bug). The state
// vector payload must therefore be []byte{0x00}, not nil.
var emptyStateVector = []byte{0x00}

func EncodeSyncStep1Empty() []byte {
	e := lib0.NewEncoder()
	e.WriteVarUint(MessageSync)
	e.WriteVarUint(SyncStep1)
	e.WriteVarUint8Array(emptyStateVector)
	return e.Bytes()
}

// EncodeSyncStep2 wraps a raw update blob (opaque to us) as a syncStep2 message.
func EncodeSyncStep2(update []byte) []byte {
	e := lib0.NewEncoder()
	e.WriteVarUint(MessageSync)
	e.WriteVarUint(SyncStep2)
	e.WriteVarUint8Array(update)
	return e.Bytes()
}

// EncodeSyncUpdate wraps a raw update blob as an incremental "update" message.
func EncodeSyncUpdate(update []byte) []byte {
	e := lib0.NewEncoder()
	e.WriteVarUint(MessageSync)
	e.WriteVarUint(SyncUpdate)
	e.WriteVarUint8Array(update)
	return e.Bytes()
}

// EncodeAwarenessRemoval builds an awareness message telling peers that the
// given client IDs went away (state "null"), so their cursors/presence clear
// immediately instead of waiting for a timeout.
func EncodeAwarenessRemoval(clientIDs []uint64) []byte {
	inner := lib0.NewEncoder()
	inner.WriteVarUint(uint64(len(clientIDs)))
	for _, id := range clientIDs {
		inner.WriteVarUint(id)
		inner.WriteVarUint(1) // clock bump; exact value is irrelevant to peers here
		inner.WriteVarString("null")
	}
	e := lib0.NewEncoder()
	e.WriteVarUint(MessageAwareness)
	e.WriteVarUint8Array(inner.Bytes())
	return e.Bytes()
}

// EncodeAwareness wraps an already-encoded awareness payload (relayed verbatim).
func EncodeAwareness(payload []byte) []byte {
	e := lib0.NewEncoder()
	e.WriteVarUint(MessageAwareness)
	e.WriteVarUint8Array(payload)
	return e.Bytes()
}
