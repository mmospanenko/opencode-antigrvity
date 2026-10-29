import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { acquireFileLock } from "../src/file-lock.js";
import { AgyBusyError } from "../src/errors.js";

/** A token whose owner cannot exist: reap the exiting child before using it. */
async function deadOwnerToken(): Promise<string> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  if (pid === undefined) throw new Error("Could not start a child process for the dead-owner fixture");
  return `${pid}:00000000-0000-0000-0000-000000000000`;
}

/** Build base plus `levels` reaper chain files, all owned by `token`. */
async function poison(directory: string, levels: number, token: string): Promise<string> {
  const base = join(directory, "resource.lock");
  await writeFile(base, token);
  let path = base;
  for (let index = 0; index < levels; index++) {
    path = `${path}.reap`;
    await writeFile(path, token);
  }
  return base;
}

async function expectBusy(path: string, waitMs: number): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  let failure: unknown;
  try {
    release = await acquireFileLock(path, waitMs);
  } catch (error) {
    failure = error;
  } finally {
    await release?.();
  }
  expect(failure).toBeInstanceOf(AgyBusyError);
}

describe("stale-lock recovery at the reaper guard depth", () => {
  test("recovers a fully dead base + 8-reaper chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 8, await deadOwnerToken());
      const release = await acquireFileLock(base, 2_000);
      await release();

      // The recovered lock must remain reusable.
      const again = await acquireFileLock(base, 2_000);
      await again();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers the same bounded stale chain with zero wait", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 8, await deadOwnerToken());
      const release = await acquireFileLock(base);
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a single dead owner without a reaper chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 0, await deadOwnerToken());
      const release = await acquireFileLock(base, 1_000);
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed at the new boundary for a fully dead chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const token = await deadOwnerToken();
      const base = await poison(directory, 9, token);
      await expectBusy(base, 250);

      // Base plus all nine reapers remain untouched at the new guard boundary.
      expect((await readdir(directory)).length).toBe(10);
      let path = base;
      for (let index = 0; index <= 9; index++) {
        expect(await readFile(path, "utf8")).toBe(token);
        path = `${path}.reap`;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves a live owner in a mixed dead/live chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const deadToken = await deadOwnerToken();
      const liveToken = `${process.pid}:11111111-1111-1111-1111-111111111111`;
      const base = await poison(directory, 0, deadToken);
      let livePath = base;
      for (let index = 0; index < 8; index++) {
        livePath = `${livePath}.reap`;
        await writeFile(livePath, index === 3 ? liveToken : deadToken);
      }

      await expectBusy(base, 250);
      expect(await readFile(base, "utf8")).toBe(deadToken);
      expect(await readFile(`${base}.reap.reap.reap.reap`, "utf8")).toBe(liveToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent recovery and lock ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 8, await deadOwnerToken());
      let active = 0;
      let maximumActive = 0;
      const contender = async () => {
        const release = await acquireFileLock(base, 3_000);
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise(resolve => setTimeout(resolve, 40));
        } finally {
          active--;
          await release();
        }
      };

      await Promise.all([contender(), contender()]);
      expect(maximumActive).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
