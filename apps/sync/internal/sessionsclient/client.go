// Package sessionsclient calls apps/api's internal session-verification
// endpoint (POST /internal/sessions/verify) so apps/sync no longer decodes
// JWTs or recomputes the RBAC permission matrix itself. apps/api is the
// single source of truth for both "is this token valid" and "what can this
// user do" — see docs/ARCHITECTURE.md.
package sessionsclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gormalone/custom-workspace/sync/internal/rbac"
)

// ErrUnreachable wraps any failure to complete the HTTP round trip itself
// (DNS, connection refused, timeout, TLS, ...) as distinct from a well-formed
// "invalid session" response from apps/api. Callers MUST treat this as a hard
// reject, never a silent fallback to local verification — apps/api being
// unreachable is not the same thing as a token being valid.
var ErrUnreachable = errors.New("sessionsclient: apps/api unreachable")

// Result mirrors apps/api's SessionVerifyResult DTO
// (apps/api/src/internal/dto/session-verify-result.dto.ts).
type Result struct {
	Valid      bool            `json:"valid"`
	UserID     string          `json:"userId,omitempty"`
	Role       string          `json:"role,omitempty"`
	Permission rbac.Permission `json:"permission,omitempty"`
	Reason     string          `json:"reason,omitempty"`
}

type request struct {
	Token       string `json:"token"`
	WorkspaceID string `json:"workspaceId"`
}

// Client calls POST {BaseURL}/internal/sessions/verify.
type Client struct {
	BaseURL string
	Secret  string
	HTTP    *http.Client
}

// New builds a Client with a sane default timeout. baseURL should be
// apps/api's origin with no trailing slash, e.g. "http://localhost:4000".
func New(baseURL, secret string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &Client{
		BaseURL: baseURL,
		Secret:  secret,
		HTTP:    &http.Client{Timeout: timeout},
	}
}

// VerifySession asks apps/api whether `token` is currently valid, and if so,
// what effective RBAC permission it grants against `workspaceID`. A non-nil
// error means the call itself failed (network, timeout, non-2xx, malformed
// response) — always ErrUnreachable-wrapped — and must be treated as "reject
// the connection", not "fall back to a local decision". A nil error with
// Result.Valid == false means apps/api itself rejected the session (expired
// token, wrong workspace, not a member, ...); Result.Reason carries why.
func (c *Client) VerifySession(ctx context.Context, token, workspaceID string) (*Result, error) {
	body, err := json.Marshal(request{Token: token, WorkspaceID: workspaceID})
	if err != nil {
		return nil, fmt.Errorf("%w: encoding request: %v", ErrUnreachable, err)
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.BaseURL+"/internal/sessions/verify", bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("%w: building request: %v", ErrUnreachable, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", c.Secret)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return nil, fmt.Errorf("%w: reading response: %v", ErrUnreachable, err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: unexpected status %d: %s", ErrUnreachable, resp.StatusCode, respBody)
	}

	var result Result
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("%w: decoding response: %v", ErrUnreachable, err)
	}
	return &result, nil
}
