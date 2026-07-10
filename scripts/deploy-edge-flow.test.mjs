import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { replaceDirectoryAtomic, runVerifiedDeployment } from "./deploy-edge-flow.mjs";

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
  await writeFile(lockPath, JSON.stringify({ token: "expired", updatedAt: Date.now() - 5_000 }));
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
      /timed out waiting for the deployment lock/i
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

async function temporaryRoot() {
  const root = path.join(os.tmpdir(), `codepath-deploy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function listSiblingArtifacts(root) {
  const { readdir } = await import("node:fs/promises");
  return readdir(root);
}
