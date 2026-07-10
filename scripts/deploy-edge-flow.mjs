import { cp, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget }) {
  await verifyBuildVersion();
  await build();
  return syncTarget();
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging }) {
  const ops = { cp, lstat, mkdir, open, readFile, rename, rm, ...fsOps };
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${targetDir}.staging-${suffix}`;
  const backupDir = `${targetDir}.backup`;
  const lockPath = `${targetDir}.deploy-lock`;
  let targetMoved = false;
  let promoted = false;

  await ops.mkdir(path.dirname(targetDir), { recursive: true });
  const releaseLock = await acquireDeploymentLock(ops, lockPath);

  try {
    await ops.rm(stagingDir, { recursive: true, force: true });
    if (!(await pathExists(ops, targetDir)) && (await pathExists(ops, backupDir))) {
      await ops.rename(backupDir, targetDir);
    } else if (await pathExists(ops, backupDir)) {
      await ops.rm(backupDir, { recursive: true, force: true });
    }

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
    try {
      await ops.rm(stagingDir, { recursive: true, force: true });
      if (promoted) await ops.rm(backupDir, { recursive: true, force: true });
    } finally {
      await releaseLock();
    }
  }
}

async function acquireDeploymentLock(fsOps, lockPath, { timeoutMs = 30_000, retryMs = 25 } = {}) {
  const startedAt = Date.now();
  const owner = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
  while (true) {
    let handle;
    let created = false;
    try {
      handle = await fsOps.open(lockPath, "wx");
      created = true;
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.close();
      return async () => {
        try {
          const currentOwner = JSON.parse(await fsOps.readFile(lockPath, "utf8"));
          if (currentOwner?.token === owner.token) await fsOps.rm(lockPath, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        await fsOps.rm(lockPath, { force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const currentOwner = JSON.parse(await fsOps.readFile(lockPath, "utf8"));
      if (!isProcessAlive(currentOwner?.pid)) {
        const abandonedPath = `${lockPath}.abandoned-${owner.token}`;
        await fsOps.rename(lockPath, abandonedPath);
        await fsOps.rm(abandonedPath, { force: true });
        continue;
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        throw new Error(`Deployment lock metadata is invalid: ${lockPath}`);
      }
      if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for the deployment lock: ${lockPath}`);
    }
    await delay(retryMs);
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
