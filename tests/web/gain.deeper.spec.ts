import { describe, expect, it } from "vitest";
import { computeGain } from "../../apps/web/src/features/spatial-audio/gain";

describe("computeGain deeper boundaries", () => {
  it("uses Euclidean distance rather than axis distance", () => {
    expect(
      computeGain(
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { nearRadius: 0, farRadius: 10 },
      ),
    ).toBeCloseTo(0.5);
  });

  it("is symmetric when listener and source are swapped", () => {
    const options = { nearRadius: 10, farRadius: 100, curve: "inverse-square" as const };
    expect(computeGain({ x: -8, y: 12 }, { x: 30, y: -4 }, options)).toBe(
      computeGain({ x: 30, y: -4 }, { x: -8, y: 12 }, options),
    );
  });

  it("treats a degenerate radius configuration as a hard cutoff", () => {
    const options = { nearRadius: 50, farRadius: 50 };
    expect(computeGain({ x: 0, y: 0 }, { x: 50, y: 0 }, options)).toBe(1);
    expect(computeGain({ x: 0, y: 0 }, { x: 50.01, y: 0 }, options)).toBe(0);
  });

  it("honors the exact near and far boundaries for both curves", () => {
    for (const curve of ["linear", "inverse-square"] as const) {
      expect(computeGain({ x: 0, y: 0 }, { x: 10, y: 0 }, { nearRadius: 10, farRadius: 20, curve })).toBe(1);
      expect(computeGain({ x: 0, y: 0 }, { x: 20, y: 0 }, { nearRadius: 10, farRadius: 20, curve })).toBe(0);
    }
  });
});
