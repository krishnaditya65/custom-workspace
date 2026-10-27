// Package redisbus is the horizontal-scaling backbone: when this WebSocket
// relay is deployed as N replicas behind a load balancer, two clients editing
// the same document can land on different instances. Redis pub/sub relays
// document updates and awareness frames between instances so every replica
// broadcasts to its own locally-connected clients — the exact role the system
// design calls out for Redis ("routes real-time chat messages, presence, and
// CRDT update vectors across horizontally scaled WebSocket nodes").
package redisbus

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const channelPrefix = "sync:room:"

type Message struct {
	InstanceID string `json:"instanceId"`
	RoomID     string `json:"roomId"`
	Kind       string `json:"kind"` // "update" | "awareness"
	Data       []byte `json:"data"`
}

type Bus struct {
	rdb        *redis.Client
	instanceID string
	logger     *slog.Logger
}

func New(rdb *redis.Client, instanceID string, logger *slog.Logger) *Bus {
	return &Bus{rdb: rdb, instanceID: instanceID, logger: logger}
}

// Publish broadcasts a room event to every other instance. Messages carry the
// publishing instance's ID so Subscribe can skip echoes back to their origin —
// this instance already relayed the message to its own local clients directly.
func (b *Bus) Publish(ctx context.Context, roomID, kind string, data []byte) error {
	payload, err := json.Marshal(Message{InstanceID: b.instanceID, RoomID: roomID, Kind: kind, Data: data})
	if err != nil {
		return err
	}
	return b.rdb.Publish(ctx, channelPrefix+roomID, payload).Err()
}

// Subscribe listens on all room channels via a Redis pattern subscription and
// invokes onMessage for every event published by a *different* instance.
func (b *Bus) Subscribe(ctx context.Context, onMessage func(Message)) {
	sub := b.rdb.PSubscribe(ctx, channelPrefix+"*")
	ch := sub.Channel()
	go func() {
		defer sub.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var m Message
				if err := json.Unmarshal([]byte(msg.Payload), &m); err != nil {
					b.logger.Warn("redisbus: bad payload", "err", err)
					continue
				}
				if m.InstanceID == b.instanceID {
					continue // we published this; our local clients already have it
				}
				onMessage(m)
			}
		}
	}()
}
