import { describe, expect, it } from "vitest";
import { computeGain, type Vec2 } from "./gain";

describe("computeGain", () => {
  const origin: Vec2 = { x: 0, y: 0 };
  const nearRadius = 100;
  const farRadius = 500;

  it("returns full gain (1) at the exact same position", () => {
    expect(computeGain(origin, { x: 0, y: 0 })).toBe(1);
  });

  it("returns full gain (1) anywhere within nearRadius", () => {
    const table: Vec2[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 0, y: 99 },
      { x: 60, y: 60 }, // dist ~84.85, still < 100
    ];
    for (const pos of table) {
      expect(computeGain(origin, pos, { nearRadius, farRadius })).toBe(1);
    }
  });

  it("returns zero gain beyond farRadius", () => {
    const table: Vec2[] = [
      { x: 501, y: 0 },
      { x: 0, y: 1000 },
      { x: 400, y: 400 }, // dist ~565.7
    ];
    for (const pos of table) {
      expect(computeGain(origin, pos, { nearRadius, farRadius })).toBe(0);
    }
  });

  it("returns a value strictly between 0 and 1 at the midpoint", () => {
    const midpoint: Vec2 = { x: (nearRadius + farRadius) / 2, y: 0 };
    const gain = computeGain(origin, midpoint, { nearRadius, farRadius });
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(1);
  });

  it("is monotonically non-increasing as distance increases (linear curve)", () => {
    const distances = [0, 50, 100, 150, 200, 300, 400, 500, 600];
    const gains = distances.map((d) =>
      computeGain(origin, { x: d, y: 0 }, { nearRadius, farRadius, curve: "linear" }),
    );
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThanOrEqual(gains[i - 1]);
    }
  });

  it("is monotonically non-increasing as distance increases (inverse-square curve)", () => {
    const distances = [0, 50, 100, 150, 200, 300, 400, 500, 600];
    const gains = distances.map((d) =>
      computeGain(origin, { x: d, y: 0 }, { nearRadius, farRadius, curve: "inverse-square" }),
    );
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThanOrEqual(gains[i - 1]);
    }
  });

  it("always clamps output to [0, 1]", () => {
    const distances = [-10, 0, 10, 100, 1000, 1_000_000];
    for (const d of distances) {
      const gain = computeGain(origin, { x: d, y: 0 }, { nearRadius, farRadius });
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });
});
