import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget }) {
  await verifyBuildVersion();
  await build();
  return syncTarget();
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging }) {
  const ops = { cp, lstat, mkdir, rename, rm, ...fsOps };
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${targetDir}.staging-${suffix}`;
  const backupDir = `${targetDir}.backup`;
  let targetMoved = false;
  let promoted = false;

  await ops.mkdir(path.dirname(targetDir), { recursive: true });
  await ops.rm(stagingDir, { recursive: true, force: true });
  if (!(await pathExists(ops, targetDir)) && (await pathExists(ops, backupDir))) {
    await ops.rename(backupDir, targetDir);
  } else if (await pathExists(ops, backupDir)) {
    await ops.rm(backupDir, { recursive: true, force: true });
  }

  try {
    await ops.cp(sourceDir, stagingDir, { recursive: true });
    await prepareStaging?.(stagingDir);
    await verifyStaging?.(stagingDir);

    if (await pathExists(ops, targetDir)) {
      await ops.rename(targetDir, backupDir);
      targetMoved = true;
    }
    await ops.rename(stagingDir, targetDir);
    promoted = true;
    if (targetMoved) await ops.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (targetMoved && !promoted) {
      if (await pathExists(ops, targetDir)) await ops.rm(targetDir, { recursive: true, force: true });
      if (await pathExists(ops, backupDir)) await ops.rename(backupDir, targetDir);
    }
    throw error;
  } finally {
    await ops.rm(stagingDir, { recursive: true, force: true });
    if (promoted) await ops.rm(backupDir, { recursive: true, force: true });
  }
}

async function pathExists(fsOps, value) {
  try {
    await fsOps.lstat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
