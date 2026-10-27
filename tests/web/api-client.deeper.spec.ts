import { beforeEach, describe, expect, it, vi } from "vitest";
import { authState, logout, setAuth } from "../../apps/web/src/lib/auth-store";
import { login, myWorkspaces, sendMessage } from "../../apps/web/src/lib/api";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("web GraphQL client deeper behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    logout();
  });

  it("sends auth and variables for an authenticated query", async () => {
    setAuth({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: { id: "u1", email: "user@example.com" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ data: { myWorkspaces: [{ id: "w1", name: "Acme" }] } }),
    );

    await expect(myWorkspaces()).resolves.toEqual([{ id: "w1", name: "Acme" }]);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(JSON.parse(String(request.body)).variables).toBeUndefined();
  });

  it("refreshes once after HTTP 401 and retries the original operation", async () => {
    setAuth({
      accessToken: "expired",
      refreshToken: "refresh-old",
      user: { id: "u1", email: "user@example.com" },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(
        response({
          data: {
            refreshToken: {
              accessToken: "access-new",
              refreshToken: "refresh-new",
              user: { id: "u1", email: "user@example.com" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(response({ data: { sendMessage: { id: "m1", body: "hello" } } }));

    await expect(sendMessage("c1", "hello")).resolves.toEqual({ id: "m1", body: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authState().accessToken).toBe("access-new");
    expect((fetchMock.mock.calls[2][1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-new",
    );
  });

  it("deduplicates concurrent refreshes after GraphQL auth errors", async () => {
    setAuth({
      accessToken: "expired",
      refreshToken: "refresh-old",
      user: { id: "u1", email: "user@example.com" },
    });
    let refreshRequests = 0;
    let unauthenticatedResponses = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("RefreshToken")) {
        refreshRequests += 1;
        return response({
          data: {
            refreshToken: {
              accessToken: "access-new",
              refreshToken: "refresh-new",
              user: { id: "u1", email: "user@example.com" },
            },
          },
        });
      }
      if (body.query.includes("MyWorkspaces") && unauthenticatedResponses++ < 2) {
        return response({ errors: [{ message: "expired", extensions: { code: "UNAUTHENTICATED" } }] });
      }
      return response({ data: { myWorkspaces: [{ id: "w1", name: "Acme" }] } });
    });

    const [first, second] = await Promise.all([myWorkspaces(), myWorkspaces()]);
    expect(first).toEqual(second);
    expect(refreshRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("surfaces GraphQL errors instead of returning partial data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ errors: [{ message: "validation failed" }] }),
    );

    await expect(login("bad@example.com", "bad")).rejects.toThrow("validation failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
