import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for AuthService with a fully mocked PrismaService (no real
 * database). Covers: registration hashing, login rejection on bad password,
 * and refresh-token single-use rotation (including reuse rejection).
 */
describe('AuthService', () => {
  let authService: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
    refreshToken: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let jwtService: { sign: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('signed.jwt.token'),
    };

    configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          JWT_ACCESS_SECRET: 'test-access-secret',
          JWT_REFRESH_PEPPER: 'test-refresh-pepper',
        };
        return values[key] ?? fallback;
      }),
    };

    authService = new AuthService(
      prisma as unknown as PrismaService,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('hashes the password and creates a user with the hash (never the plaintext)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const createdUser = {
        id: 'user-1',
        email: 'alice@example.com',
        displayName: 'Alice',
        passwordHash: 'hashed-value',
      };
      prisma.user.create.mockResolvedValue(createdUser);
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

      // bcrypt's native binding can't be jest.spyOn'd in this environment
      // (its `hash` export is non-configurable), so instead of spying we
      // assert on the real, observable behavior: the value actually
      // persisted is a genuine bcrypt hash (cost 12) that verifies against
      // the plaintext, and is never the plaintext itself.
      const result = await authService.register('alice@example.com', 'correct-horse-battery', 'Alice');

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'alice@example.com',
          displayName: 'Alice',
        }),
      });
      // The plaintext password must never be passed through to `create`.
      const createArg = prisma.user.create.mock.calls[0][0].data;
      expect(createArg.passwordHash).not.toBe('correct-horse-battery');
      expect(createArg.passwordHash).toMatch(/^\$2[aby]\$12\$/); // real bcrypt hash, cost factor 12
      await expect(bcrypt.compare('correct-horse-battery', createArg.passwordHash)).resolves.toBe(true);
      expect(result.user).toBe(createdUser);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it('rejects registration when the email is already taken', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(authService.register('taken@example.com', 'password123', 'Bob')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('rejects a wrong password', async () => {
      const passwordHash = await bcrypt.hash('the-real-password', 4);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.com',
        passwordHash,
      });

      await expect(authService.login('alice@example.com', 'wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects login for an unknown email without leaking existence', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(authService.login('nobody@example.com', 'whatever')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('succeeds and issues tokens for a correct password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 4);
      const user = { id: 'user-1', email: 'alice@example.com', passwordHash };
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

      const result = await authService.login('alice@example.com', 'correct-password');

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toBe(user);
    });
  });

  describe('refreshToken rotation', () => {
    it('rotates: revokes the old token row and returns a brand new refresh token', async () => {
      const storedRow = {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: 'irrelevant-because-mocked-lookup',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        user: { id: 'user-1', email: 'alice@example.com' },
      };
      prisma.refreshToken.findUnique.mockResolvedValue(storedRow);
      prisma.refreshToken.update.mockResolvedValue({ ...storedRow, revokedAt: new Date() });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });

      const result = await authService.refreshToken('some-presented-token');

      // Old row revoked...
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      });
      // ...and a new row created, both inside a single transaction.
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it('rejects reuse of an already-rotated (revoked) refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: new Date(), // already rotated/revoked
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        user: { id: 'user-1', email: 'alice@example.com' },
      });

      await expect(authService.refreshToken('stolen-or-replayed-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('rejects an expired refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired
        user: { id: 'user-1', email: 'alice@example.com' },
      });

      await expect(authService.refreshToken('expired-token')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a completely unknown refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(authService.refreshToken('never-issued-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
