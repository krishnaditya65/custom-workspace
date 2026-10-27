package hub

import (
	"log/slog"
	"time"

	"github.com/gorilla/websocket"

	"github.com/gormalone/custom-workspace/sync/internal/protocol"
	"github.com/gormalone/custom-workspace/sync/internal/rbac"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	sendBufferSize = 256
)

// Client is one authenticated WebSocket connection bound to a single Room.
// Ephemeral presence — live cursors, cursor-chat bubbles, and the whiteboard
// avatar XY position spatial audio reads — all ride the awareness sub-protocol
// unmodified through Client.send/readPump; the server only inspects awareness
// payloads far enough to learn client IDs for cleanup on disconnect (see
// protocol.decodeAwareness), never their JSON state contents.
type Client struct {
	UserID     string
	Permission rbac.Permission
	ReadOnly   bool

	conn         *websocket.Conn
	room         *Room
	hub          *Hub
	sendCh       chan []byte
	awarenessIDs map[uint64]struct{}
	logger       *slog.Logger
}

func NewClient(conn *websocket.Conn, room *Room, h *Hub, userID string, permission rbac.Permission, logger *slog.Logger) *Client {
	return &Client{
		UserID:       userID,
		Permission:   permission,
		ReadOnly:     rbac.ReadOnly(permission),
		conn:         conn,
		room:         room,
		hub:          h,
		sendCh:       make(chan []byte, sendBufferSize),
		awarenessIDs: make(map[uint64]struct{}),
		logger:       logger,
	}
}

// send enqueues a payload for delivery on the write pump. Slow consumers are
// dropped rather than allowed to backpressure the whole hub — Yjs updates are
// idempotent, so a dropped frame is recovered by the next update from the same
// peer or, in the worst case, the peer simply reconnects and gets a fresh
// snapshotBlobs() replay.
func (c *Client) send(payload []byte) {
	select {
	case c.sendCh <- payload:
	default:
		c.logger.Warn("client: send buffer full, dropping slow consumer", "user", c.UserID)
	}
}

// Run starts the client's lifecycle: initial hydration handshake, then the
// blocking read pump (write pump runs in its own goroutine). Returns when the
// connection closes.
func (c *Client) Run() {
	go c.writePump()

	// Hydration: replay every stored update blob as its own syncStep2 message
	// (message boundaries matter — see store.Store doc comment on why blobs
	// cannot be concatenated), then request the client's own state via an
	// empty-state-vector syncStep1 so any offline/IndexedDB-only edits it has
	// get pulled up to the server too.
	for _, blob := range c.room.snapshotBlobs() {
		c.send(protocol.EncodeSyncStep2(blob))
	}
	c.send(protocol.EncodeSyncStep1Empty())

	c.readPump()
}

func (c *Client) readPump() {
	defer c.close()
	c.conn.SetReadLimit(10 << 20) // 10MB — generous for whiteboard/doc payloads
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		c.handleMessage(msg)
	}
}

func (c *Client) handleMessage(msg []byte) {
	env, err := protocol.Decode(msg)
	if err != nil {
		c.logger.Warn("client: malformed frame, dropping", "user", c.UserID, "err", err)
		return
	}

	switch env.Type {
	case protocol.MessageSync:
		c.handleSync(env)
	case protocol.MessageAwareness:
		c.handleAwareness(env)
	}
}

func (c *Client) handleSync(env *protocol.Envelope) {
	switch env.SyncType {
	case protocol.SyncStep1:
		// A peer asking for our state — we already proactively sent our full
		// log on connect, so nothing further to do (empty-state-vector design,
		// see protocol.EncodeSyncStep1Empty).
		return
	case protocol.SyncStep2, protocol.SyncUpdate:
		if c.ReadOnly {
			c.logger.Info("client: dropped update from read-only connection", "user", c.UserID)
			return
		}
		if len(env.Payload) == 0 {
			return
		}
		c.room.appendUpdate(env.Payload)
		out := protocol.EncodeSyncUpdate(env.Payload)
		c.room.broadcastLocal(c, out)
		c.hub.Publish(c.room.ID, "update", out)
	}
}

func (c *Client) handleAwareness(env *protocol.Envelope) {
	if c.ReadOnly {
		return // view-only connections still receive awareness, but don't emit it
	}
	for _, u := range env.Awareness {
		if u.State == "null" {
			delete(c.awarenessIDs, u.ClientID)
		} else {
			c.awarenessIDs[u.ClientID] = struct{}{}
		}
	}
	out := protocol.EncodeAwareness(env.RawAwareness)
	c.room.broadcastLocal(c, out)
	c.hub.Publish(c.room.ID, "awareness", out)
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case payload, ok := <-c.sendCh:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) close() {
	c.conn.Close()
	_ = c.room.removeClient(c)

	// Tell remaining local peers this client's cursors/presence are gone.
	if len(c.awarenessIDs) > 0 {
		ids := make([]uint64, 0, len(c.awarenessIDs))
		for id := range c.awarenessIDs {
			ids = append(ids, id)
		}
		removal := protocol.EncodeAwarenessRemoval(ids)
		c.room.broadcastAll(removal)
		c.hub.Publish(c.room.ID, "awareness", removal)
	}

	c.hub.ReleaseIfEmpty(c.room)
}
