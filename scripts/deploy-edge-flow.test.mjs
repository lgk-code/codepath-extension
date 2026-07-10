import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

test("replaceDirectoryAtomic recovers a deployment lock owned by a dead process", async () => {
  const root = await temporaryRoot();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "CodePath");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), "new");
  await writeFile(path.join(targetDir, "manifest.json"), "old");
  await writeFile(`${targetDir}.deploy-lock`, JSON.stringify({ pid: 2_147_483_647, token: "dead" }));

  try {
    await replaceDirectoryAtomic({ sourceDir, targetDir });

    assert.equal(await readFile(path.join(targetDir, "manifest.json"), "utf8"), "new");
    assert.deepEqual((await listSiblingArtifacts(root)).filter((name) => name.includes("deploy-lock")), []);
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
