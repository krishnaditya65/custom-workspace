import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { GuestLinkPermission, PermissionLevel, WorkspaceRole } from '@workspace/shared';
import { InternalSessionsService } from './internal-sessions.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for InternalSessionsService, the logic behind
 * POST /internal/sessions/verify. This is what makes apps/api authoritative
 * over apps/sync's connection-time JWT verification and RBAC ceiling.
 */
describe('InternalSessionsService', () => {
  let service: InternalSessionsService;
  let jwt: { verifyAsync: jest.Mock };
  let prisma: { workspaceMember: { findUnique: jest.Mock } };
  let config: { get: jest.Mock };

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn() };
    prisma = { workspaceMember: { findUnique: jest.fn() } };
    config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'JWT_ACCESS_SECRET' ? 'test-access-secret' : fallback,
      ),
    };

    service = new InternalSessionsService(
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('rejects a token that fails JWT verification (bad signature / expired)', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    const result = await service.verify({ token: 'bad.token', workspaceId: 'ws1' });

    expect(result).toEqual({ valid: false, reason: 'invalid_token' });
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it('resolves a regular user token via WorkspaceMember role -> DEFAULT_ROLE_PERMISSION', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', email: 'a@b.com' });
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: WorkspaceRole.MEMBER });

    const result = await service.verify({ token: 'good.token', workspaceId: 'ws1' });

    expect(result).toEqual({
      valid: true,
      userId: 'user-1',
      role: WorkspaceRole.MEMBER,
      permission: PermissionLevel.EDIT,
    });
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws1', userId: 'user-1' } },
    });
  });

  it('rejects a valid token for a user with no membership in that workspace', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', email: 'a@b.com' });
    prisma.workspaceMember.findUnique.mockResolvedValue(null);

    const result = await service.verify({ token: 'good.token', workspaceId: 'ws-other' });

    expect(result).toEqual({ valid: false, reason: 'not_a_member' });
  });

  it('resolves a guest token using its embedded permission, without a DB lookup', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'guest:link-1',
      guest: true,
      workspaceId: 'ws1',
      permission: GuestLinkPermission.COMMENT,
    });

    const result = await service.verify({ token: 'guest.token', workspaceId: 'ws1' });

    expect(result).toEqual({
      valid: true,
      userId: 'guest:link-1',
      role: WorkspaceRole.GUEST,
      permission: GuestLinkPermission.COMMENT,
    });
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a guest token scoped to a different workspace', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'guest:link-1',
      guest: true,
      workspaceId: 'ws1',
      permission: GuestLinkPermission.EDIT,
    });

    const result = await service.verify({ token: 'guest.token', workspaceId: 'ws2' });

    expect(result).toEqual({ valid: false, reason: 'workspace_mismatch' });
  });
});
