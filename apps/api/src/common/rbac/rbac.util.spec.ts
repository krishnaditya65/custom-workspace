import {
  canPerform,
  hasWorkspaceRoleAtLeast,
  PermissionLevel,
  WorkspaceRole,
} from '@workspace/shared';

/**
 * Full truth table for canPerform(role, required) with no override, per the
 * documented matrix in packages/shared/src/index.ts:
 *
 *   Role \ Required | VIEW | COMMENT | EDIT
 *   OWNER           | Y    | Y       | Y
 *   ADMIN           | Y    | Y       | Y
 *   MEMBER          | Y    | Y       | Y
 *   GUEST           | Y    | N       | N
 */
describe('canPerform (RBAC matrix)', () => {
  const roles = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.GUEST];
  const levels = [PermissionLevel.VIEW, PermissionLevel.COMMENT, PermissionLevel.EDIT];

  const expected: Record<WorkspaceRole, Record<PermissionLevel, boolean>> = {
    [WorkspaceRole.OWNER]: { VIEW: true, COMMENT: true, EDIT: true } as any,
    [WorkspaceRole.ADMIN]: { VIEW: true, COMMENT: true, EDIT: true } as any,
    [WorkspaceRole.MEMBER]: { VIEW: true, COMMENT: true, EDIT: true } as any,
    [WorkspaceRole.GUEST]: { VIEW: true, COMMENT: false, EDIT: false } as any,
  };

  for (const role of roles) {
    for (const level of levels) {
      const want = expected[role][level];
      it(`${role} x ${level} => ${want}`, () => {
        expect(canPerform(role, level)).toBe(want);
      });
    }
  }

  describe('with an override (e.g. GuestLink.permission)', () => {
    it('GUEST + COMMENT override satisfies COMMENT but not EDIT', () => {
      expect(canPerform(WorkspaceRole.GUEST, PermissionLevel.VIEW, PermissionLevel.COMMENT)).toBe(true);
      expect(canPerform(WorkspaceRole.GUEST, PermissionLevel.COMMENT, PermissionLevel.COMMENT)).toBe(true);
      expect(canPerform(WorkspaceRole.GUEST, PermissionLevel.EDIT, PermissionLevel.COMMENT)).toBe(false);
    });

    it('GUEST + EDIT override satisfies everything', () => {
      for (const level of levels) {
        expect(canPerform(WorkspaceRole.GUEST, level, PermissionLevel.EDIT)).toBe(true);
      }
    });

    it('an override REPLACES the role default rather than only raising it', () => {
      // OWNER's default is EDIT; a VIEW override should cap them down to VIEW.
      expect(canPerform(WorkspaceRole.OWNER, PermissionLevel.EDIT, PermissionLevel.VIEW)).toBe(false);
      expect(canPerform(WorkspaceRole.OWNER, PermissionLevel.VIEW, PermissionLevel.VIEW)).toBe(true);
    });
  });
});

describe('hasWorkspaceRoleAtLeast (role hierarchy)', () => {
  it('ranks OWNER > ADMIN > MEMBER > GUEST', () => {
    expect(hasWorkspaceRoleAtLeast(WorkspaceRole.OWNER, WorkspaceRole.GUEST)).toBe(true);
    expect(hasWorkspaceRoleAtLeast(WorkspaceRole.ADMIN, WorkspaceRole.MEMBER)).toBe(true);
    expect(hasWorkspaceRoleAtLeast(WorkspaceRole.MEMBER, WorkspaceRole.ADMIN)).toBe(false);
    expect(hasWorkspaceRoleAtLeast(WorkspaceRole.GUEST, WorkspaceRole.MEMBER)).toBe(false);
  });

  it('is reflexive (a role always satisfies itself as the requirement)', () => {
    for (const role of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.GUEST]) {
      expect(hasWorkspaceRoleAtLeast(role, role)).toBe(true);
    }
  });
});
