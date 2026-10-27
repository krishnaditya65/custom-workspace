package sessionsclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gormalone/custom-workspace/sync/internal/rbac"
)

func TestVerifySession_Valid(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-internal-secret"); got != "shh" {
			t.Errorf("missing/wrong x-internal-secret header: %q", got)
		}
		var body request
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.Token != "tok" || body.WorkspaceID != "ws1" {
			t.Errorf("unexpected request body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Result{
			Valid: true, UserID: "user-1", Role: "MEMBER", Permission: rbac.PermissionEdit,
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "shh", 0)
	result, err := c.VerifySession(context.Background(), "tok", "ws1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid || result.UserID != "user-1" || result.Permission != rbac.PermissionEdit {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestVerifySession_InvalidSessionIsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Result{Valid: false, Reason: "invalid_token"})
	}))
	defer srv.Close()

	c := New(srv.URL, "shh", 0)
	result, err := c.VerifySession(context.Background(), "bad", "ws1")
	if err != nil {
		t.Fatalf("a well-formed 'invalid' response must not be a Go error: %v", err)
	}
	if result.Valid {
		t.Error("expected Valid=false")
	}
	if result.Reason != "invalid_token" {
		t.Errorf("expected reason invalid_token, got %q", result.Reason)
	}
}

func TestVerifySession_UnreachableIsAnError(t *testing.T) {
	// Nothing listening on this address.
	c := New("http://127.0.0.1:1", "shh", 0)
	_, err := c.VerifySession(context.Background(), "tok", "ws1")
	if err == nil {
		t.Fatal("expected an error when apps/api is unreachable")
	}
	if !errors.Is(err, ErrUnreachable) {
		t.Errorf("expected ErrUnreachable, got %v", err)
	}
}

func TestVerifySession_NonOKStatusIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("bad internal secret"))
	}))
	defer srv.Close()

	c := New(srv.URL, "wrong-secret", 0)
	_, err := c.VerifySession(context.Background(), "tok", "ws1")
	if !errors.Is(err, ErrUnreachable) {
		t.Errorf("expected ErrUnreachable-wrapped error for non-200, got %v", err)
	}
}
