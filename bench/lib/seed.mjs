// Seeds the minimal rows apps/api's POST /internal/sessions/verify needs to
// resolve access for the Go sync relay's onConnect check (Document ->
// Workspace -> WorkspaceMember), and mints a JWT byte-identical in shape to
// the ones apps/api's AuthService signs, using the same JWT_ACCESS_SECRET
// apps/api verifies with (apps/sync itself no longer reads this secret - it
// calls apps/api to verify the token instead).
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://workspace:workspace@localhost:5433/workspace';
export const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'change-me-access-secret';

export async function seedDocument(label = 'bench') {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@example.com`;

  await client.query(
    `INSERT INTO "User" (id, email, "passwordHash", "displayName", "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', $3, now(), now())`,
    [userId, email, label],
  );
  await client.query(
    `INSERT INTO "Workspace" (id, name, slug, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, now(), now())`,
    [workspaceId, `${label} workspace`, `${label}-${workspaceId.slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, "joinedAt")
     VALUES ($1, $2, $3, 'MEMBER', now())`,
    [crypto.randomUUID(), workspaceId, userId],
  );
  await client.query(
    `INSERT INTO "Document" (id, "workspaceId", kind, title, "createdAt", "updatedAt")
     VALUES ($1, $2, 'RICH_TEXT', $3, now(), now())`,
    [documentId, workspaceId, `${label} doc`],
  );

  const token = jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: '15m' });

  return {
    userId,
    workspaceId,
    documentId,
    token,
    async cleanup() {
      await client.query(`DELETE FROM "DocumentSnapshot" WHERE "documentId" = $1`, [documentId]);
      await client.query(`DELETE FROM "Document" WHERE id = $1`, [documentId]);
      await client.query(`DELETE FROM "WorkspaceMember" WHERE "workspaceId" = $1`, [workspaceId]);
      await client.query(`DELETE FROM "Workspace" WHERE id = $1`, [workspaceId]);
      await client.query(`DELETE FROM "User" WHERE id = $1`, [userId]);
      await client.end();
    },
    pgClient: client,
  };
}
