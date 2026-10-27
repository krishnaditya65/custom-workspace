import { beforeEach, describe, expect, it } from "vitest";
import { authState, isAuthenticated, logout, setAuth } from "./auth-store";

const STORAGE_KEY = "workspace.auth";

describe("auth-store", () => {
  beforeEach(() => {
    localStorage.clear();
    logout();
  });

  it("starts logged out with nothing in localStorage", () => {
    expect(isAuthenticated()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists the session to localStorage on setAuth", () => {
    setAuth({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      user: { id: "u1", email: "a@b.com" },
    });

    expect(isAuthenticated()).toBe(true);
    expect(authState().accessToken).toBe("access-123");

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.accessToken).toBe("access-123");
    expect(parsed.refreshToken).toBe("refresh-456");
    expect(parsed.user.email).toBe("a@b.com");
  });

  it("clears both the signal and localStorage on logout()", () => {
    setAuth({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      user: { id: "u1", email: "a@b.com" },
    });
    expect(isAuthenticated()).toBe(true);

    logout();

    expect(isAuthenticated()).toBe(false);
    expect(authState().accessToken).toBeNull();
    expect(authState().refreshToken).toBeNull();
    expect(authState().user).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
