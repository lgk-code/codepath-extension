import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, open as fsOpen, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEPLOY_LOCK_DEFAULTS, replaceDirectoryAtomic, runVerifiedDeployment, withDeploymentMutationMutex } from "./deploy-edge-flow.mjs";

test("runVerifiedDeployment stops before build and sync when version verification fails", async () => {
  const events = [];

  await assert.rejects(
    runVerifiedDeployment({
      verifyBuildVersion: async () => {
        events.push("verify");
        throw new Error("build versions differ");
      },
      build: async () => events.push("build"),
      syncTarget: async () => events.push("sync-target")
    }),
    /build versions differ/
  );

  assert.deepEqual(events, ["verify"]);
});

test("runVerifiedDeployment serializes verification, build, and sync under one deployment mutex", async () => {
  const root = await temporaryRoot();
  const targetDir = path.join(root, "CodePath");
  let activeBuilds = 0;
  let maxActiveBuilds = 0;

  const runDeployment = () =>
    runVerifiedDeployment({
      withDeploymentLock: (action) => withDeploymentMutationMutex(targetDir, action, { timeoutMs: 2_000 }),
      verifyBuildVersion: async () => undefined,
      build: async () => {
        activeBuilds += 1;
        maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeBuilds -= 1;
      },
      syncTarget: async () => undefined
    });

  try {
    await Promise.all([runDeployment(), runDeployment()]);
    assert.equal(maxActiveBuilds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default deployment wait covers stale lease recovery", () => {
  assert.equal(DEPLOY_LOCK_DEFAULTS.timeoutMs > DEPLOY_LOCK_DEFAULTS.leaseMs, true);
});

test("replaceDirectoryAtomic preserves the old target when staging copy fails", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "sentinel.txt"), "old");

  try {
    await assert.rejects(
      () =>
        replaceDirectoryAtomic({
          sourceDir,
          targetDir,
          fsOps: {
            cp: async (_source, staging) => {
              await mkdir(staging, { recursive: true });
              await writeFile(path.join(staging, "partial.txt"), "partial");
              throw new Error("copy failed");
            },
            mkdir,
            rename,
            rm
          }
        }),
      /copy failed/
    );
    assert.equal(await readFile(path.join(targetDir, "sentinel.txt"), "utf8"), "old");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("staging") || name.includes("backup")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic rolls back when staging promotion fails", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "sentinel.txt"), "old");

  try {
    await assert.rejects(
      () =>
        replaceDirectoryAtomic({
          sourceDir,
          targetDir,
          fsOps: {
            cp,
            mkdir,
            async rename(from, to) {
              if (String(from).includes(".staging-") && to === targetDir) throw new Error("promotion failed");
              await rename(from, to);
            },
            rm
          }
        }),
      /promotion failed/
    );
    assert.equal(await readFile(path.join(targetDir, "sentinel.txt"), "utf8"), "old");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("staging") || name.includes("backup")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup recovery preserves its marker when rename fails", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const transactionId = "123-456-abc";
  const backupDir = `${targetDir}.backup-${transactionId}`;
  const markerPath = path.join(backupDir, ".codepath-deploy-backup.json");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(backupDir, "manifest.json"), "old");
  await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, transactionId }));

  try {
    await assert.rejects(
      () =>
        replaceDirectoryAtomic({
          sourceDir,
          targetDir,
          fsOps: {
            async rename(from, to) {
              if (from === backupDir && to === targetDir) throw new Error("restore rename failed");
              return rename(from, to);
            }
          }
        }),
      /restore rename failed/
    );
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).transactionId, transactionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic serializes concurrent deployments to the same target", async () => {
  const root = await temporaryRoot();
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceA, { recursive: true });
  await mkdir(sourceB, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceA, "manifest.json"), "a");
  await writeFile(path.join(sourceB, "manifest.json"), "b");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  let releaseA;
  let markAEntered;
  const aEntered = new Promise((resolve) => {
    markAEntered = resolve;
  });
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const events = [];

  try {
    const deploymentA = replaceDirectoryAtomic({
      sourceDir: sourceA,
      targetDir,
      lockOptions: { timeoutMs: 500, retryMs: 5, leaseMs: 30, heartbeatMs: 5 },
      prepareStaging: async () => {
        events.push("a-enter");
        markAEntered();
        await holdA;
      }
    });
    await aEntered;

    const deploymentB = replaceDirectoryAtomic({
      sourceDir: sourceB,
      targetDir,
      lockOptions: { timeoutMs: 500, retryMs: 5, leaseMs: 30, heartbeatMs: 5 },
      prepareStaging: async () => {
        events.push("b-enter");
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ["a-enter"]);
    releaseA();
    await Promise.all([deploymentA, deploymentB]);

    assert.deepEqual(events, ["a-enter", "b-enter"]);
    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "b");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("staging") || name.includes("backup") || name.includes("deploy-lock")), []);
  } finally {
    releaseA?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic recovers an expired deployment lease", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  const lockPath = `${targetDir}.deploy-lock`;
  await writeFile(
    lockPath,
    JSON.stringify({ token: "expired", pid: 2_147_483_647, runtimeId: `${process.platform}:${os.hostname().toLowerCase()}`, updatedAt: Date.now() - 5_000 })
  );
  const staleTime = new Date(Date.now() - 5_000);
  await utimes(lockPath, staleTime, staleTime);

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir, lockOptions: { timeoutMs: 200, retryMs: 5, leaseMs: 20 } });

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("deploy-lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic does not reclaim a fresh lock based on a foreign PID namespace", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(`${targetDir}.deploy-lock`, JSON.stringify({ pid: 2_147_483_647, token: "foreign-runtime" }));

  try {
    await assert.rejects(
      () => replaceDirectoryAtomic({ sourceDir, targetDir, lockOptions: { timeoutMs: 40, retryMs: 5, leaseMs: 1_000 } }),
      /timed out waiting for the deployment (?:lock|mutation mutex)/i
    );
    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic recovers an empty lock left by a crashed creator", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(lockPath, "");
  const staleTime = new Date(Date.now() - 5_000);
  await utimes(lockPath, staleTime, staleTime);

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir, lockOptions: { timeoutMs: 200, retryMs: 5, leaseMs: 20 } });

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("deploy-lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment heartbeat never exposes empty lock metadata", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  let markPrepareEntered;
  let releasePrepare;
  let markHeartbeatWrite;
  let releaseHeartbeatWrite;
  const prepareEntered = new Promise((resolve) => {
    markPrepareEntered = resolve;
  });
  const holdPrepare = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const heartbeatWrite = new Promise((resolve) => {
    markHeartbeatWrite = resolve;
  });
  const holdHeartbeatWrite = new Promise((resolve) => {
    releaseHeartbeatWrite = resolve;
  });

  try {
    const deployment = replaceDirectoryAtomic({
      sourceDir,
      targetDir,
      lockOptions: { timeoutMs: 500, retryMs: 5, leaseMs: 200, heartbeatMs: 5 },
      fsOps: {
        async utimes(value, atime, mtime) {
          if (String(value).includes(".heartbeat-")) {
            markHeartbeatWrite?.();
            await holdHeartbeatWrite;
          }
          return utimes(value, atime, mtime);
        }
      },
      prepareStaging: async () => {
        markPrepareEntered?.();
        await holdPrepare;
      }
    });
    await prepareEntered;
    await heartbeatWrite;

    const observedText = await readFile(lockPath, "utf8");
    releaseHeartbeatWrite?.();
    releasePrepare?.();
    await deployment;

    const observed = JSON.parse(observedText);
    assert.equal(typeof observed.token, "string");
    assert.equal(Number.isFinite(observed.updatedAt), true);
  } finally {
    releaseHeartbeatWrite?.();
    releasePrepare?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a deployment that loses its lease after promotion cannot delete its rollback backup", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  try {
    await assert.rejects(
      () =>
        replaceDirectoryAtomic({
          sourceDir,
          targetDir,
          fsOps: {
            async rename(from, to) {
              await rename(from, to);
              if (String(from).includes(".staging-") && to === targetDir) {
                await writeFile(lockPath, JSON.stringify({ token: "replacement-owner", updatedAt: Date.now() }));
              }
            }
          }
        }),
      /deployment lease was lost/i
    );

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
    assert.equal((await listSiblingArtifacts(root)).filter((name) => name.includes(".backup-")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment recovery ignores unrelated backup-like sibling directories", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const personalDir = path.join(root, "CodePath.backup-personal");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await mkdir(personalDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(path.join(personalDir, "sentinel.txt"), "personal");

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir });

    assert.equal(await readFile(path.join(personalDir, "sentinel.txt"), "utf8"), "personal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment publishes complete lock metadata atomically", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  let markLockWrite;
  let releaseLockWrite;
  const lockWriteStarted = new Promise((resolve) => {
    markLockWrite = resolve;
  });
  const holdLockWrite = new Promise((resolve) => {
    releaseLockWrite = resolve;
  });

  try {
    const deployment = replaceDirectoryAtomic({
      sourceDir,
      targetDir,
      fsOps: {
        async open(value, flags) {
          const handle = await fsOpen(value, flags);
          if (flags !== "wx" || (value !== lockPath && !String(value).includes(".candidate-"))) return handle;
          return {
            async writeFile(...args) {
              markLockWrite?.();
              await holdLockWrite;
              return handle.writeFile(...args);
            },
            sync: () => handle.sync(),
            close: () => handle.close()
          };
        }
      }
    });
    await lockWriteStarted;

    let observed = null;
    try {
      observed = await readFile(lockPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    releaseLockWrite?.();
    await deployment;

    assert.equal(observed === null || observed.length > 0, true);
  } finally {
    releaseLockWrite?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a heartbeat refreshed during stale takeover cannot be fenced as expired", async () => {
  const root = await temporaryRoot();
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceA, { recursive: true });
  await mkdir(sourceB, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceA, "manifest.json"), "a");
  await writeFile(path.join(sourceB, "manifest.json"), "b");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  let markAEntered;
  let releaseA;
  const aEntered = new Promise((resolve) => {
    markAEntered = resolve;
  });
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  let bEntered = false;

  try {
    const deploymentA = replaceDirectoryAtomic({
      sourceDir: sourceA,
      targetDir,
      lockOptions: { timeoutMs: 500, retryMs: 5, leaseMs: 40, heartbeatMs: 200 },
      prepareStaging: async () => {
        markAEntered?.();
        await holdA;
      }
    });
    await aEntered;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deploymentB = replaceDirectoryAtomic({
      sourceDir: sourceB,
      targetDir,
      lockOptions: { timeoutMs: 60, retryMs: 5, leaseMs: 40, heartbeatMs: 10 },
      fsOps: {
        async rename(from, to) {
          if (String(from).includes(".heartbeat-") && String(to).includes(".fenced-")) {
            const now = new Date();
            await utimes(from, now, now);
          }
          return rename(from, to);
        }
      },
      prepareStaging: async () => {
        bEntered = true;
      }
    });

    let bTimedOut = false;
    try {
      await deploymentB;
    } catch (error) {
      bTimedOut = /timed out waiting for the deployment (?:lock|mutation mutex)/i.test(String(error));
    }
    releaseA?.();
    await deploymentA.catch(() => undefined);

    assert.equal(bTimedOut, true);
    assert.equal(bEntered, false);
  } finally {
    releaseA?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a live owner paused after its lease check cannot mutate a replacement deployment", async () => {
  const root = await temporaryRoot();
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceA, { recursive: true });
  await mkdir(sourceB, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceA, "manifest.json"), "a");
  await writeFile(path.join(sourceB, "manifest.json"), "b");
  await writeFile(path.join(targetDir, "manifest.json"), "old");

  let markAAtMutation;
  let releaseA;
  const aAtMutation = new Promise((resolve) => {
    markAAtMutation = resolve;
  });
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  let deploymentA;

  try {
    deploymentA = replaceDirectoryAtomic({
      sourceDir: sourceA,
      targetDir,
      lockOptions: { timeoutMs: 500, retryMs: 5, leaseMs: 40, heartbeatMs: 200 },
      fsOps: {
        async writeFile(file, data, options) {
          if (path.basename(String(file)) === ".codepath-deploy-backup.json") {
            markAAtMutation?.();
            await holdA;
          }
          return writeFile(file, data, options);
        }
      }
    });
    await aAtMutation;
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () =>
        replaceDirectoryAtomic({
          sourceDir: sourceB,
          targetDir,
          lockOptions: { timeoutMs: 80, retryMs: 5, leaseMs: 40, heartbeatMs: 10 }
        }),
      /timed out waiting for the deployment (?:lock|mutation mutex)/i
    );

    releaseA?.();
    await deploymentA;
    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "a");
  } finally {
    releaseA?.();
    await deploymentA?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic recovers a crashed lock created by another runtime", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  const heartbeatPath = `${lockPath}.heartbeat-cross-runtime`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(lockPath, JSON.stringify({ token: "cross-runtime", pid: process.pid, runtimeId: "linux:wsl", updatedAt: Date.now() - 5_000 }));
  await writeFile(heartbeatPath, JSON.stringify({ token: "cross-runtime" }));
  const staleTime = new Date(Date.now() - 5_000);
  await utimes(lockPath, staleTime, staleTime);
  await utimes(heartbeatPath, staleTime, staleTime);

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir, lockOptions: { timeoutMs: 100, retryMs: 5, leaseMs: 20 } });

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceDirectoryAtomic recovers a crashed lock after PID reuse", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  const lockPath = `${targetDir}.deploy-lock`;
  const heartbeatPath = `${lockPath}.heartbeat-reused-pid`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(
    lockPath,
    JSON.stringify({ token: "reused-pid", pid: process.pid, runtimeId: `${process.platform}:${os.hostname().toLowerCase()}`, updatedAt: Date.now() - 5_000 })
  );
  await writeFile(heartbeatPath, JSON.stringify({ token: "reused-pid" }));
  const staleTime = new Date(Date.now() - 5_000);
  await utimes(lockPath, staleTime, staleTime);
  await utimes(heartbeatPath, staleTime, staleTime);

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir, lockOptions: { timeoutMs: 100, retryMs: 5, leaseMs: 20 } });

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "the Windows deployment mutex serializes separate Node processes",
  { skip: process.platform !== "win32" && !process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME },
  async () => {
    const root = await temporaryRoot();
    const sourceA = path.join(root, "source-a");
    const sourceB = path.join(root, "source-b");
    const targetDir = path.join(root, "CodePath");
    const readyPath = path.join(root, "a-ready");
    const releasePath = path.join(root, "a-release");
    const moduleUrl = new URL("./deploy-edge-flow.mjs", import.meta.url).href;
    await mkdir(sourceA, { recursive: true });
    await mkdir(sourceB, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(sourceA, "manifest.json"), "a");
    await writeFile(path.join(sourceB, "manifest.json"), "b");
    await writeFile(path.join(targetDir, "manifest.json"), "old");

    const firstCode = `
      import { access, writeFile } from "node:fs/promises";
      import { replaceDirectoryAtomic } from ${JSON.stringify(moduleUrl)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await replaceDirectoryAtomic({
        sourceDir: ${JSON.stringify(sourceA)},
        targetDir: ${JSON.stringify(targetDir)},
        lockOptions: { timeoutMs: 1000, retryMs: 5, leaseMs: 40, heartbeatMs: 200 },
        prepareStaging: async () => {
          await writeFile(${JSON.stringify(readyPath)}, "ready");
          while (true) {
            try { await access(${JSON.stringify(releasePath)}); break; } catch { await sleep(5); }
          }
        }
      });
    `;
    const secondCode = `
      import { replaceDirectoryAtomic } from ${JSON.stringify(moduleUrl)};
      try {
        await replaceDirectoryAtomic({
          sourceDir: ${JSON.stringify(sourceB)},
          targetDir: ${JSON.stringify(targetDir)},
          lockOptions: { timeoutMs: 80, retryMs: 5, leaseMs: 40, heartbeatMs: 10 }
        });
        throw new Error("second deployment unexpectedly entered");
      } catch (error) {
        if (!/deployment mutation mutex/i.test(String(error))) throw error;
      }
    `;
    const first = startNodeModule(firstCode);

    try {
      await waitForPath(readyPath, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = await runNodeModule(secondCode);
      assert.equal(second.code, 0, second.stderr);

      await writeFile(releasePath, "release");
      const firstResult = await waitForChild(first);
      assert.equal(firstResult.code, 0, firstResult.stderr);
      assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "a");
    } finally {
      await writeFile(releasePath, "release").catch(() => undefined);
      first.kill();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "the Windows deployment mutex is released when its Node owner exits",
  { skip: process.platform !== "win32" && !process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME },
  async () => {
    const root = await temporaryRoot();
    const sourceA = path.join(root, "source-a");
    const sourceB = path.join(root, "source-b");
    const targetDir = path.join(root, "CodePath");
    const readyPath = path.join(root, "a-ready");
    const moduleUrl = new URL("./deploy-edge-flow.mjs", import.meta.url).href;
    await mkdir(sourceA, { recursive: true });
    await mkdir(sourceB, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(sourceA, "manifest.json"), "a");
    await writeFile(path.join(sourceB, "manifest.json"), "b");
    await writeFile(path.join(targetDir, "manifest.json"), "old");

    const firstCode = `
      import { writeFile } from "node:fs/promises";
      import { replaceDirectoryAtomic } from ${JSON.stringify(moduleUrl)};
      await replaceDirectoryAtomic({
        sourceDir: ${JSON.stringify(sourceA)},
        targetDir: ${JSON.stringify(targetDir)},
        lockOptions: { timeoutMs: 1000, retryMs: 5, leaseMs: 40, heartbeatMs: 200 },
        prepareStaging: async () => {
          await writeFile(${JSON.stringify(readyPath)}, "ready");
          await new Promise(() => {});
        }
      });
    `;
    const secondCode = `
      import { replaceDirectoryAtomic } from ${JSON.stringify(moduleUrl)};
      await replaceDirectoryAtomic({
        sourceDir: ${JSON.stringify(sourceB)},
        targetDir: ${JSON.stringify(targetDir)},
        lockOptions: { timeoutMs: 1000, retryMs: 5, leaseMs: 40, heartbeatMs: 10 }
      });
    `;
    const first = startNodeModule(firstCode);

    try {
      await waitForPath(readyPath, 5_000);
      first.kill();
      await waitForChild(first);
      await new Promise((resolve) => setTimeout(resolve, 80));

      const second = await runNodeModule(secondCode);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "b");
    } finally {
      first.kill();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "the Windows mutex wait may outlive helper startup without timing out early",
  { skip: process.platform !== "win32" && !process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME },
  async () => {
    const root = await temporaryRoot();
    const targetDir = path.join(root, "CodePath");
    const readyPath = path.join(root, "owner-ready");
    const releasePath = path.join(root, "owner-release");
    const moduleUrl = new URL("./deploy-edge-flow.mjs", import.meta.url).href;
    const ownerCode = `
      import { access, writeFile } from "node:fs/promises";
      import { withDeploymentMutationMutex } from ${JSON.stringify(moduleUrl)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await withDeploymentMutationMutex(${JSON.stringify(targetDir)}, async () => {
        await writeFile(${JSON.stringify(readyPath)}, "ready");
        while (true) {
          try { await access(${JSON.stringify(releasePath)}); break; } catch { await sleep(5); }
        }
      }, { timeoutMs: 5_000 });
    `;
    const owner = startNodeModule(ownerCode);

    try {
      await waitForPath(readyPath, 5_000);
      const releaseTimer = setTimeout(() => void writeFile(releasePath, "release"), 2_000);
      const startedAt = Date.now();
      await withDeploymentMutationMutex(targetDir, async () => undefined, { timeoutMs: 5_000, helperStartupTimeoutMs: 1_500 });
      clearTimeout(releaseTimer);

      assert.equal(Date.now() - startedAt >= 1_500, true);
      const ownerResult = await waitForChild(owner);
      assert.equal(ownerResult.code, 0, ownerResult.stderr);
    } finally {
      await writeFile(releasePath, "release").catch(() => undefined);
      owner.kill();
      await rm(root, { recursive: true, force: true });
    }
  }
);

async function temporaryRoot() {
  const root = path.join(os.tmpdir(), `codepath-deploy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function listSiblingArtifacts(root) {
  const { readdir } = await import("node:fs/promises");
  return readdir(root);
}

function startNodeModule(code) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => {
    child.stdoutText += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    child.stderrText += String(chunk);
  });
  return child;
}

async function runNodeModule(code) {
  return waitForChild(startNodeModule(code));
}

function waitForChild(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, stdout: child.stdoutText, stderr: child.stderrText });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout: child.stdoutText, stderr: child.stderrText }));
  });
}

async function waitForPath(file, timeoutMs) {
  const { access } = await import("node:fs/promises");
  const startedAt = Date.now();
  while (true) {
    try {
      await access(file);
      return;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
