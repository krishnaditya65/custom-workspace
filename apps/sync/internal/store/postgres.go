// Package store talks to the same PostgreSQL database apps/api manages via
// Prisma (packages/db/prisma/schema.prisma), using raw SQL — the Go binary has
// no Prisma client available, so it speaks the schema directly. Table/column
// names here MUST stay in sync with schema.prisma; drift is caught by
// docs/TESTING.md's integration test, which round-trips a snapshot end to end.
package store

import (
	"context"
	"encoding/binary"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// DocumentWorkspace resolves the workspace a document belongs to. This is
// just topology (a foreign-key walk), not an authorization decision — who
// can do what with the document is now resolved by calling apps/api's
// POST /internal/sessions/verify with this workspaceID (see
// internal/sessionsclient and cmd/sync/main.go's wsHandler), not by joining
// through WorkspaceMember locally.
func (s *Store) DocumentWorkspace(ctx context.Context, documentID string) (string, error) {
	var workspaceID string
	row := s.pool.QueryRow(ctx, `SELECT "workspaceId" FROM "Document" WHERE id = $1`, documentID)
	if err := row.Scan(&workspaceID); err != nil {
		return "", fmt.Errorf("no such document: %w", err)
	}
	return workspaceID, nil
}

// EnsureDocument creates a Document row on first use if one doesn't already
// exist for this ID (documents are created lazily the first time a client
// opens a doc/board that the API hasn't pre-registered — e.g. ad-hoc scratch
// docs). Real deployments generally have the API create the row up front via
// its own createDocument mutation; this is a defensive fallback.
func (s *Store) EnsureDocument(ctx context.Context, documentID, workspaceID, kind, title string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO "Document" (id, "workspaceId", kind, title, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, now(), now())
		ON CONFLICT (id) DO NOTHING
	`, documentID, workspaceID, kind, title)
	return err
}

// LoadLatestSnapshot returns the ordered list of raw Yjs update blobs stored in
// the most recent DocumentSnapshot row, or nil if none exists yet. The blobs
// are framed (length-prefixed) rather than merged into one, because merging
// independent Yjs updates into a single minimal update requires a real CRDT
// engine (see docs/ARCHITECTURE.md "Go sync relay" for the tradeoff) — this
// server instead replays each stored blob through the client's own Y.applyUpdate,
// which is exactly what live "update" messages already do.
func (s *Store) LoadLatestSnapshot(ctx context.Context, documentID string) ([][]byte, error) {
	var gz []byte
	row := s.pool.QueryRow(ctx, `
		SELECT state FROM "DocumentSnapshot"
		WHERE "documentId" = $1
		ORDER BY "createdAt" DESC
		LIMIT 1
	`, documentID)
	if err := row.Scan(&gz); err != nil {
		return nil, nil // no snapshot yet — not an error
	}
	raw, err := gunzip(gz)
	if err != nil {
		return nil, err
	}
	return unframe(raw), nil
}

// SaveSnapshot gzips the framed concatenation of `blobs` and inserts a new
// DocumentSnapshot row, then prunes older rows for the same document so the
// table stays bounded (we only ever need the latest snapshot to rehydrate).
func (s *Store) SaveSnapshot(ctx context.Context, documentID string, blobs [][]byte) error {
	if len(blobs) == 0 {
		return nil
	}
	raw := frame(blobs)
	gz, err := gzipBytes(raw)
	if err != nil {
		return err
	}
	vectorClock := make([]byte, 8)
	binary.BigEndian.PutUint64(vectorClock, uint64(len(blobs)))

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO "DocumentSnapshot" (id, "documentId", state, "sizeBytes", "vectorClock", "createdAt")
		VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
	`, documentID, gz, len(gz), vectorClock); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM "DocumentSnapshot"
		WHERE "documentId" = $1
		AND id NOT IN (SELECT id FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "createdAt" DESC LIMIT 1)
	`, documentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
