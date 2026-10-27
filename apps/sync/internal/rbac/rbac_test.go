package rbac

import "testing"

// These cover only the pure permission-ranking helpers that remain local to
// apps/sync. The ROLE -> PERMISSION computation this package used to mirror
// from apps/api (EffectivePermission) has been removed along with its own
// test — that decision is now made exclusively by apps/api's
// POST /internal/sessions/verify (see internal/sessionsclient and
// apps/api/src/internal/internal-sessions.service.spec.ts), so there is no
// longer a parallel Go truth table to keep in lockstep with the TS one.

func TestCanAccessOrdering(t *testing.T) {
	cases := []struct {
		have, required Permission
		want           bool
	}{
		{PermissionEdit, PermissionView, true},
		{PermissionEdit, PermissionComment, true},
		{PermissionEdit, PermissionEdit, true},
		{PermissionComment, PermissionEdit, false},
		{PermissionComment, PermissionComment, true},
		{PermissionView, PermissionComment, false},
		{PermissionView, PermissionView, true},
	}
	for _, c := range cases {
		if got := CanAccess(c.have, c.required); got != c.want {
			t.Errorf("CanAccess(%s, %s) = %v, want %v", c.have, c.required, got, c.want)
		}
	}
}

func TestCanAccessRejectsUnknownLevels(t *testing.T) {
	if CanAccess("BOGUS", PermissionView) {
		t.Error("unknown 'have' level must never grant access")
	}
	if CanAccess(PermissionEdit, "BOGUS") {
		t.Error("unknown 'required' level must never be satisfiable")
	}
}

func TestReadOnly(t *testing.T) {
	if ReadOnly(PermissionEdit) {
		t.Error("EDIT must not be read-only")
	}
	if ReadOnly(PermissionComment) {
		t.Error("COMMENT must not be read-only (comments are a write)")
	}
	if !ReadOnly(PermissionView) {
		t.Error("VIEW must be read-only")
	}
}
