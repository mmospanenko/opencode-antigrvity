import { describe, expect, test } from "bun:test";
import { measuredContextUsage } from "../src/proxy.js";
import type { ContextSnapshot } from "../src/telemetry.js";

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return { version: 1, hostSessionID: "session", epoch: 1, sequence: 1, observedAt: Date.now(), used: 12, size: 1000, state: "measured", ...overrides };
}

describe("measured context usage", () => {
  test("maps the measured occupancy to Anthropic input tokens", async () => {
    expect(await measuredContextUsage("session", async () => snapshot())).toEqual({ input_tokens: 12, output_tokens: 0 });
  });

  test("ignores stale, unknown, empty, and missing sessions", async () => {
    expect(await measuredContextUsage("session", async () => snapshot({ state: "stale" }))).toBeUndefined();
    expect(await measuredContextUsage("session", async () => snapshot({ state: "unknown" }))).toBeUndefined();
    expect(await measuredContextUsage("session", async () => snapshot({ used: 0 }))).toBeUndefined();
    expect(await measuredContextUsage("session", async () => snapshot({ used: -1 }))).toBeUndefined();
    expect(await measuredContextUsage("session", async () => snapshot({ used: Number.NaN }))).toBeUndefined();
    expect(await measuredContextUsage(undefined, async () => snapshot())).toBeUndefined();
  });

  test("returns undefined when the snapshot cannot be read", async () => {
    expect(await measuredContextUsage("session", async () => { throw new Error("broken snapshot"); })).toBeUndefined();
  });
});
