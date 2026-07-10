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

async function temporaryRoot() {
  const root = path.join(os.tmpdir(), `codepath-deploy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function listSiblingArtifacts(root) {
  const { readdir } = await import("node:fs/promises");
  return readdir(root);
}
