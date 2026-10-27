// Command sync is the standalone WebSocket relay for CRDT (Yjs) documents and
// whiteboards. It is deliberately a pure protocol relay + durable replay-log
// store rather than a full CRDT engine (see docs/ARCHITECTURE.md) — this is
// the "rewrite the isolated WebSocket microservice in Go once the single
// Node.js process's CPU becomes the bottleneck" step from the system's staged
// rollout plan, skipped straight to for this build.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/gormalone/custom-workspace/sync/internal/config"
	"github.com/gormalone/custom-workspace/sync/internal/hub"
	"github.com/gormalone/custom-workspace/sync/internal/redisbus"
	"github.com/gormalone/custom-workspace/sync/internal/sessionsclient"
	"github.com/gormalone/custom-workspace/sync/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // CORS handled upstream by Envoy/API gateway
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg := config.Load()

	if cfg.DatabaseURL == "" {
		logger.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	if cfg.APIBaseURL == "" {
		logger.Error("API_BASE_URL is required")
		os.Exit(1)
	}
	if cfg.InternalServiceSecret == "" {
		logger.Error("INTERNAL_SERVICE_SECRET is required")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("failed to connect to postgres", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	var bus *redisbus.Bus
	if opts, err := redis.ParseURL(cfg.RedisURL); err == nil {
		rdb := redis.NewClient(opts)
		if err := rdb.Ping(ctx).Err(); err != nil {
			logger.Warn("redis unreachable — running single-instance without cross-node fan-out", "err", err)
		} else {
			bus = redisbus.New(rdb, cfg.InstanceID, logger)
		}
	} else {
		logger.Warn("invalid REDIS_URL — running single-instance without cross-node fan-out", "err", err)
	}

	h := hub.New(st, bus, cfg.SnapshotDebounce, logger)
	sessions := sessionsclient.New(cfg.APIBaseURL, cfg.InternalServiceSecret, cfg.SessionVerifyTimeout)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/", wsHandler(h, st, sessions, logger))

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: mux}

	go func() {
		logger.Info("sync engine listening", "port", cfg.Port, "instance", cfg.InstanceID)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// wsHandler upgrades the connection, authenticates it, resolves the target
// Room, and hands off to hub.Client for the connection lifetime.
// URL shape: ws://host:1234/<kind>:<documentId>?token=<jwt>
// e.g. ws://sync:1234/doc:9c14...  or  ws://sync:1234/board:9c14...
// This mirrors HocuspocusProvider's default of appending its `name` option to
// the URL path, so apps/web's provider config needs no special-casing.
//
// Auth + RBAC: apps/sync does not verify the JWT or compute a permission
// itself — it resolves the document's workspace (a plain foreign-key lookup,
// not a security decision) and asks apps/api's
// POST /internal/sessions/verify whether the token is valid and what
// permission it grants there. apps/api is the single source of truth for
// both questions; see internal/sessionsclient and docs/ARCHITECTURE.md.
func wsHandler(h *hub.Hub, st *store.Store, sessions *sessionsclient.Client, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomName := strings.TrimPrefix(r.URL.Path, "/")
		if roomName == "" || roomName == "health" {
			http.NotFound(w, r)
			return
		}
		kind, documentID, ok := strings.Cut(roomName, ":")
		if !ok || (kind != "doc" && kind != "board") {
			http.Error(w, "room name must be doc:<id> or board:<id>", http.StatusBadRequest)
			return
		}

		token := r.URL.Query().Get("token")
		if token == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}

		workspaceID, err := st.DocumentWorkspace(r.Context(), documentID)
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		result, err := sessions.VerifySession(r.Context(), token, workspaceID)
		if err != nil {
			// apps/api is unreachable/erroring — reject the connection
			// outright. apps/api is the single source of truth for session
			// validity, so there is no safe local fallback to fall back to.
			logger.Error("session verification call failed", "err", err)
			http.Error(w, "session verification unavailable", http.StatusBadGateway)
			return
		}
		if !result.Valid {
			logger.Info("session rejected by apps/api", "reason", result.Reason)
			http.Error(w, "invalid session", http.StatusUnauthorized)
			return
		}
		if result.Permission == "" || result.UserID == "" {
			logger.Error("malformed session verify response", "userId", result.UserID, "permission", result.Permission)
			http.Error(w, "session verification unavailable", http.StatusBadGateway)
			return
		}
		permission := result.Permission

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Warn("ws upgrade failed", "err", err)
			return
		}

		room, err := h.GetOrLoadRoom(r.Context(), roomName, documentID, workspaceID)
		if err != nil {
			logger.Error("failed to load room", "room", roomName, "err", err)
			conn.Close()
			return
		}

		client := hub.NewClient(conn, room, h, result.UserID, permission, logger)
		room.AddClient(client)
		client.Run()
	}
}
