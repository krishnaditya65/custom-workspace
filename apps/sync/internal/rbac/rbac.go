// Package rbac holds pure, dependency-free helpers for reasoning about
// PermissionLevel ranking (VIEW < COMMENT < EDIT) once apps/sync already
// knows a connection's effective permission.
//
// It intentionally does NOT compute a WorkspaceRole's effective permission
// anymore — that ROLE -> PERMISSION decision, along with JWT verification,
// is made exclusively by apps/api's POST /internal/sessions/verify endpoint
// (see internal/sessionsclient and cmd/sync/main.go's wsHandler). apps/api
// is the single source of truth here; apps/sync just receives the resulting
// Permission over the wire and uses the helpers below to decide what a
// connection at that permission level is allowed to do at the transport
// layer. See docs/ARCHITECTURE.md.
package rbac

type Permission string

const (
	PermissionView    Permission = "VIEW"
	PermissionComment Permission = "COMMENT"
	PermissionEdit    Permission = "EDIT"
)

var permissionRank = map[Permission]int{
	PermissionView:    0,
	PermissionComment: 1,
	PermissionEdit:    2,
}

// CanAccess reports whether `have` satisfies a `required` permission level,
// e.g. a document that only requires VIEW is accessible to an EDIT holder.
func CanAccess(have, required Permission) bool {
	h, ok1 := permissionRank[have]
	r, ok2 := permissionRank[required]
	if !ok1 || !ok2 {
		return false
	}
	return h >= r
}

// ReadOnly reports whether a connection with this effective permission should
// be marked read-only at the transport layer (i.e. the server will accept
// syncStep1/step2 from it to hydrate the client, but will drop any update /
// awareness-edit frames it sends rather than relaying them).
func ReadOnly(have Permission) bool {
	return !CanAccess(have, PermissionComment)
}
