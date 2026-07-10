import { cp, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget }) {
  await verifyBuildVersion();
  await build();
  return syncTarget();
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging, lockOptions }) {
  const ops = { cp, lstat, mkdir, open, readFile, rename, rm, ...fsOps };
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${targetDir}.staging-${suffix}`;
  const backupDir = `${targetDir}.backup`;
  const lockPath = `${targetDir}.deploy-lock`;
  let targetMoved = false;
  let promoted = false;

  await ops.mkdir(path.dirname(targetDir), { recursive: true });
  const lease = await acquireDeploymentLock(ops, lockPath, lockOptions);

  try {
    await lease.assertOwned();
    await ops.rm(stagingDir, { recursive: true, force: true });
    if (!(await pathExists(ops, targetDir)) && (await pathExists(ops, backupDir))) {
      await ops.rename(backupDir, targetDir);
    } else if (await pathExists(ops, backupDir)) {
      await ops.rm(backupDir, { recursive: true, force: true });
    }

    await ops.cp(sourceDir, stagingDir, { recursive: true });
    await prepareStaging?.(stagingDir);
    await verifyStaging?.(stagingDir);
    await lease.assertOwned();

    if (await pathExists(ops, targetDir)) {
      await ops.rename(targetDir, backupDir);
      targetMoved = true;
    }
    await lease.assertOwned();
    await ops.rename(stagingDir, targetDir);
    promoted = true;
    if (targetMoved) await ops.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (targetMoved && !promoted && (await lease.isOwned())) {
      if (await pathExists(ops, targetDir)) await ops.rm(targetDir, { recursive: true, force: true });
      if (await pathExists(ops, backupDir)) await ops.rename(backupDir, targetDir);
    }
    throw error;
  } finally {
    try {
      await ops.rm(stagingDir, { recursive: true, force: true });
      if (promoted) await ops.rm(backupDir, { recursive: true, force: true });
    } finally {
      await lease.release();
    }
  }
}

async function acquireDeploymentLock(fsOps, lockPath, { timeoutMs = 30_000, retryMs = 25, leaseMs = 120_000, heartbeatMs = Math.min(10_000, leaseMs / 3) } = {}) {
  const startedAt = Date.now();
  const owner = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    updatedAt: Date.now()
  };
  while (true) {
    let handle;
    let created = false;
    try {
      handle = await fsOps.open(lockPath, "wx");
      created = true;
      owner.updatedAt = Date.now();
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
      await handle.close();
      return createDeploymentLease(fsOps, lockPath, owner, leaseMs, heartbeatMs);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        await fsOps.rm(lockPath, { force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = await readLockObservation(fsOps, lockPath);
    if (!observed) continue;
    if (Date.now() - observed.updatedAt > leaseMs) {
      await delay(Math.min(retryMs, 25));
      const confirmed = await readLockObservation(fsOps, lockPath);
      if (!confirmed) continue;
      if (confirmed.fingerprint !== observed.fingerprint || Date.now() - confirmed.updatedAt <= leaseMs) continue;
      const abandonedPath = `${lockPath}.abandoned-${owner.token}`;
      try {
        await fsOps.rename(lockPath, abandonedPath);
        await fsOps.rm(abandonedPath, { force: true });
        continue;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") continue;
        throw error;
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for the deployment lock: ${lockPath}`);
    }
    await delay(retryMs);
  }
}

function createDeploymentLease(fsOps, lockPath, owner, leaseMs, heartbeatMs) {
  let stopped = false;
  let leaseError;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (stopped) return;
        const current = await readLockOwner(fsOps, lockPath);
        if (!current || current.token !== owner.token) throw new Error(`Deployment lease was lost: ${lockPath}`);
        owner.updatedAt = Date.now();
        await writeLockOwner(fsOps, lockPath, owner);
      })
      .catch((error) => {
        leaseError = error;
      });
  }, Math.max(5, heartbeatMs));
  timer.unref?.();

  return {
    async assertOwned() {
      await heartbeat;
      if (leaseError) throw leaseError;
      const current = await readLockOwner(fsOps, lockPath);
      if (!current || current.token !== owner.token || Date.now() - current.updatedAt > leaseMs) {
        throw new Error(`Deployment lease was lost: ${lockPath}`);
      }
    },
    async isOwned() {
      try {
        await this.assertOwned();
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      stopped = true;
      clearInterval(timer);
      await heartbeat;
      const current = await readLockOwner(fsOps, lockPath);
      if (current?.token === owner.token) await fsOps.rm(lockPath, { force: true });
    }
  };
}

async function readLockObservation(fsOps, lockPath) {
  try {
    const content = await fsOps.readFile(lockPath, "utf8");
    const stat = await fsOps.lstat(lockPath);
    const owner = parseLockOwner(content);
    return {
      updatedAt: owner?.updatedAt ?? stat.mtimeMs,
      fingerprint: `${stat.mtimeMs}:${stat.size}:${content}`
    };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return { updatedAt: Date.now(), fingerprint: "inaccessible" };
    }
    throw error;
  }
}

async function readLockOwner(fsOps, lockPath) {
  try {
    return parseLockOwner(await fsOps.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLockOwner(content) {
  try {
    const owner = JSON.parse(content);
    return typeof owner?.token === "string" && Number.isFinite(owner?.updatedAt) ? owner : undefined;
  } catch {
    return undefined;
  }
}

async function writeLockOwner(fsOps, lockPath, owner) {
  const handle = await fsOps.open(lockPath, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
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
