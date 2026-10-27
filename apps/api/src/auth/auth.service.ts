import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { GuestLinkPermission, JwtPayload } from '@workspace/shared';
import { PrismaService } from '../prisma/prisma.service';

const BCRYPT_COST = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_BYTES = 64;
const GUEST_TOKEN_TTL = '30m';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * AuthService
 * ===========
 * Owns password hashing, access-token signing, and refresh-token issuance /
 * single-use rotation.
 *
 * Refresh token design:
 *  - The token handed to the client is a random 64-byte value (base64url),
 *    never stored verbatim.
 *  - Only SHA-256(token + JWT_REFRESH_PEPPER) is persisted in
 *    RefreshToken.tokenHash, so a DB leak alone does not let an attacker
 *    replay refresh tokens (the pepper lives only in app config/env).
 *  - Rotation is single-use: redeeming a refresh token revokes it
 *    (revokedAt set) and issues a brand new one in the same transaction.
 *    Presenting an already-revoked or expired token is rejected - this
 *    also gives us a cheap "was this token stolen and replayed" signal
 *    (a legitimate client would never present a revoked token).
 */
@Injectable()
export class AuthService {
  private readonly refreshPepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.refreshPepper = this.config.get<string>('JWT_REFRESH_PEPPER', 'change-me-refresh-pepper');
  }

  // ---------------------------------------------------------------------
  // Registration / login
  // ---------------------------------------------------------------------

  async register(email: string, password: string, displayName: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, displayName },
    });

    const tokens = await this.issueTokenPair(user.id, user.email);
    return { ...tokens, user };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Same error for "no such user" and "wrong password" to avoid
      // leaking which emails are registered.
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.issueTokenPair(user.id, user.email);
    return { ...tokens, user };
  }

  // ---------------------------------------------------------------------
  // Refresh token rotation
  // ---------------------------------------------------------------------

  async refreshToken(presentedToken: string) {
    const tokenHash = this.hashRefreshToken(presentedToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Covers: unknown token, already-rotated (revoked) token reuse, and
      // naturally expired tokens - all rejected uniformly.
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate atomically: revoke the old row, insert the new one.
    const newRefreshToken = this.generateRefreshToken();
    const newTokenHash = this.hashRefreshToken(newRefreshToken);

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: newTokenHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      }),
    ]);

    const accessToken = this.signAccessToken(stored.user.id, stored.user.email);
    return { accessToken, refreshToken: newRefreshToken, user: stored.user };
  }

  async logout(presentedToken: string): Promise<boolean> {
    const tokenHash = this.hashRefreshToken(presentedToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt) {
      return false;
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return true;
  }

  // ---------------------------------------------------------------------
  // Guest tokens (see GuestLinksModule for the resolveGuestLink flow that
  // calls this after validating a GuestLink row)
  // ---------------------------------------------------------------------

  signGuestToken(guestLinkId: string, workspaceId: string, permission: GuestLinkPermission): string {
    return this.jwt.sign(
      {
        sub: `guest:${guestLinkId}`,
        guest: true,
        workspaceId,
        permission,
      },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
        expiresIn: GUEST_TOKEN_TTL,
      },
    );
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async issueTokenPair(userId: string, email: string): Promise<IssuedTokens> {
    const accessToken = this.signAccessToken(userId, email);

    const refreshToken = this.generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return { accessToken, refreshToken };
  }

  private signAccessToken(userId: string, email: string): string {
    const payload: JwtPayload = { sub: userId, email };
    return this.jwt.sign(payload as unknown as Record<string, unknown>, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
      expiresIn: ACCESS_TOKEN_TTL,
      algorithm: 'HS256',
    });
  }

  private generateRefreshToken(): string {
    return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  private hashRefreshToken(token: string): string {
    return crypto
      .createHash('sha256')
      .update(`${token}${this.refreshPepper}`)
      .digest('hex');
  }
}
