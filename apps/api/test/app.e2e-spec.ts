import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Real end-to-end test against the actual GraphQL endpoint (no mocks).
 *
 * REQUIRES a real Postgres reachable via DATABASE_URL and Redis via
 * REDIS_URL (see apps/api/.env.example) - this exercises the whole stack:
 * Nest -> GraphQL resolvers -> Prisma -> Postgres, and the RolesGuard /
 * JwtAuthGuard wiring end-to-end. Not run as part of `pnpm test` (unit);
 * run explicitly via `pnpm test:e2e` once infra is up
 * (`pnpm dev:infra` at the repo root).
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication;
  const gqlEndpoint = '/graphql';

  // Unique-per-run emails so repeated test runs against a persistent DB
  // don't collide on the unique User.email constraint.
  const runId = Date.now().toString(36);
  const ownerEmail = `owner-${runId}@example.com`;
  const outsiderEmail = `outsider-${runId}@example.com`;
  const password = 'super-secret-password-123';

  let ownerAccessToken: string;
  let outsiderAccessToken: string;
  let workspaceId: string;
  let channelId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function gql(query: string, variables?: Record<string, unknown>) {
    return request(app.getHttpServer()).post(gqlEndpoint).send({ query, variables });
  }

  it('registers the workspace owner', async () => {
    const res = await gql(
      `mutation Register($input: RegisterInput!) {
        register(input: $input) {
          accessToken
          refreshToken
          user { id email displayName }
        }
      }`,
      { input: { email: ownerEmail, password, displayName: 'Owner' } },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.register.user.email).toBe(ownerEmail);
    ownerAccessToken = res.body.data.register.accessToken;
    expect(ownerAccessToken).toEqual(expect.any(String));
  });

  it('registers a second, unrelated user (non-member for the rejection test)', async () => {
    const res = await gql(
      `mutation Register($input: RegisterInput!) {
        register(input: $input) { accessToken user { id email } }
      }`,
      { input: { email: outsiderEmail, password, displayName: 'Outsider' } },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    outsiderAccessToken = res.body.data.register.accessToken;
  });

  it('logs the owner back in', async () => {
    const res = await gql(
      `mutation Login($input: LoginInput!) {
        login(input: $input) { accessToken refreshToken user { id email } }
      }`,
      { input: { email: ownerEmail, password } },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.login.user.email).toBe(ownerEmail);
    ownerAccessToken = res.body.data.login.accessToken;
  });

  it('creates a workspace as the owner', async () => {
    const res = await gql(
      `mutation CreateWorkspace($input: CreateWorkspaceInput!) {
        createWorkspace(input: $input) { id name slug }
      }`,
      { input: { name: 'Acme Corp' } },
    ).set('Authorization', `Bearer ${ownerAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createWorkspace.name).toBe('Acme Corp');
    workspaceId = res.body.data.createWorkspace.id;
    expect(workspaceId).toEqual(expect.any(String));
  });

  it('creates a channel in that workspace', async () => {
    const res = await gql(
      `mutation CreateChannel($input: CreateChannelInput!) {
        createChannel(input: $input) { id name isPrivate isArchived }
      }`,
      { input: { workspaceId, name: 'general', isPrivate: false } },
    ).set('Authorization', `Bearer ${ownerAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createChannel.name).toBe('general');
    channelId = res.body.data.createChannel.id;
    expect(channelId).toEqual(expect.any(String));
  });

  it('sends a message to the channel', async () => {
    const res = await gql(
      `mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) { id body author { email } }
      }`,
      { input: { channelId, body: 'Hello, world!' } },
    ).set('Authorization', `Bearer ${ownerAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.sendMessage.body).toBe('Hello, world!');
    expect(res.body.data.sendMessage.author.email).toBe(ownerEmail);
  });

  it('lists messages in the channel (cursor-paginated)', async () => {
    const res = await gql(
      `query Messages($input: MessagesQueryInput!) {
        messages(input: $input) {
          items { id body }
          hasMore
          nextCursor
        }
      }`,
      { input: { channelId, limit: 10 } },
    ).set('Authorization', `Bearer ${ownerAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.messages.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.messages.items[0].body).toBe('Hello, world!');
  });

  it('rejects a non-member from sending a message in the channel', async () => {
    const res = await gql(
      `mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) { id body }
      }`,
      { input: { channelId, body: 'I should not be allowed to post this' } },
    ).set('Authorization', `Bearer ${outsiderAccessToken}`);

    expect(res.status).toBe(200); // GraphQL returns 200 with an errors[] array
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/not a member|forbidden/i);
    expect(res.body.data?.sendMessage ?? null).toBeNull();
  });

  it('rejects an unauthenticated request to a protected mutation', async () => {
    const res = await gql(
      `mutation CreateWorkspace($input: CreateWorkspaceInput!) {
        createWorkspace(input: $input) { id }
      }`,
      { input: { name: 'Should Not Be Created' } },
    );
    // No Authorization header attached at all.

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions?.code ?? res.body.errors[0].message).toBeTruthy();
    expect(res.body.data?.createWorkspace ?? null).toBeNull();
  });
});
