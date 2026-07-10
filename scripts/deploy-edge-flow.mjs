import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, utimes } from "node:fs/promises";
import path from "node:path";

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget }) {
  await verifyBuildVersion();
  await build();
  return syncTarget();
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging, lockOptions }) {
  const ops = { cp, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, ...fsOps };
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${targetDir}.staging-${suffix}`;
  const backupDir = `${targetDir}.backup-${suffix}`;
  const lockPath = `${targetDir}.deploy-lock`;
  let targetMoved = false;
  let promoted = false;

  await ops.mkdir(path.dirname(targetDir), { recursive: true });
  const lease = await acquireDeploymentLock(ops, lockPath, lockOptions);

  try {
    await lease.assertOwned();
    await ops.rm(stagingDir, { recursive: true, force: true });
    await reconcileBackupArtifacts(ops, targetDir);

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
    await lease.assertOwned();
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
      if (promoted && (await lease.isOwned())) await ops.rm(backupDir, { recursive: true, force: true });
    } finally {
      await lease.release();
    }
  }
}

async function reconcileBackupArtifacts(fsOps, targetDir) {
  const parent = path.dirname(targetDir);
  const basename = path.basename(targetDir);
  const names = await fsOps.readdir(parent);
  const backupNames = names.filter((name) => name === `${basename}.backup` || name.startsWith(`${basename}.backup-`));
  if (backupNames.length === 0) return;
  const backups = backupNames.map((name) => path.join(parent, name));
  if (!(await pathExists(fsOps, targetDir))) {
    if (backups.length !== 1) throw new Error(`Cannot recover deployment: found ${backups.length} backup directories for ${targetDir}.`);
    await fsOps.rename(backups[0], targetDir);
    return;
  }
  for (const backup of backups) await fsOps.rm(backup, { recursive: true, force: true });
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
      await writeHeartbeat(fsOps, heartbeatPathFor(lockPath, owner.token), owner);
      return createDeploymentLease(fsOps, lockPath, owner, leaseMs, heartbeatMs);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        await fsOps.rm(lockPath, { force: true });
        await removeHeartbeatArtifacts(fsOps, lockPath, owner.token);
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
        if (confirmed.token) await removeHeartbeatArtifacts(fsOps, lockPath, confirmed.token);
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
  const heartbeatPath = heartbeatPathFor(lockPath, owner.token);
  let stopped = false;
  let leaseError;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (stopped) return;
        const currentToken = await readLockToken(fsOps, lockPath);
        if (currentToken !== owner.token) throw new Error(`Deployment lease was lost: ${lockPath}`);
        await writeHeartbeat(fsOps, heartbeatPath, owner);
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
      const currentToken = await readLockToken(fsOps, lockPath);
      const currentHeartbeat = await readHeartbeat(fsOps, heartbeatPath);
      if (
        currentToken !== owner.token ||
        currentHeartbeat?.token !== owner.token ||
        !Number.isFinite(currentHeartbeat.updatedAt) ||
        Date.now() - currentHeartbeat.updatedAt > leaseMs
      ) {
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
      const currentToken = await readLockToken(fsOps, lockPath);
      if (currentToken === owner.token) await fsOps.rm(lockPath, { force: true });
      await removeHeartbeatArtifacts(fsOps, lockPath, owner.token);
    }
  };
}

async function readLockObservation(fsOps, lockPath) {
  try {
    const content = await fsOps.readFile(lockPath, "utf8");
    const stat = await fsOps.lstat(lockPath);
    const owner = parseLockOwner(content);
    let updatedAt = owner?.updatedAt ?? stat.mtimeMs;
    let heartbeatFingerprint = "";
    if (owner?.token) {
      const heartbeatPath = heartbeatPathFor(lockPath, owner.token);
      try {
        const heartbeatContent = await fsOps.readFile(heartbeatPath, "utf8");
        const heartbeatStat = await fsOps.lstat(heartbeatPath);
        const heartbeatOwner = parseLockOwner(heartbeatContent);
        if (heartbeatOwner?.token === owner.token) updatedAt = Math.max(updatedAt, heartbeatStat.mtimeMs);
        heartbeatFingerprint = `${heartbeatStat.mtimeMs}:${heartbeatStat.size}:${heartbeatContent}`;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return {
      token: owner?.token,
      updatedAt,
      fingerprint: `${stat.mtimeMs}:${stat.size}:${content}:${heartbeatFingerprint}`
    };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return { updatedAt: Date.now(), fingerprint: "inaccessible" };
    }
    throw error;
  }
}

async function readLockToken(fsOps, lockPath) {
  try {
    return parseLockOwner(await fsOps.readFile(lockPath, "utf8"))?.token;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readHeartbeat(fsOps, heartbeatPath) {
  try {
    const owner = parseLockOwner(await fsOps.readFile(heartbeatPath, "utf8"));
    const stat = await fsOps.lstat(heartbeatPath);
    return owner ? { token: owner.token, updatedAt: stat.mtimeMs } : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLockOwner(content) {
  try {
    const owner = JSON.parse(content);
    if (typeof owner?.token !== "string") return undefined;
    return { token: owner.token, updatedAt: Number.isFinite(owner.updatedAt) ? owner.updatedAt : undefined };
  } catch {
    return undefined;
  }
}

async function writeHeartbeat(fsOps, heartbeatPath, owner) {
  let handle;
  try {
    handle = await fsOps.open(heartbeatPath, "wx");
    await handle.writeFile(JSON.stringify({ token: owner.token }), "utf8");
    await handle.sync();
    await handle.close();
    return;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error?.code !== "EEXIST") throw error;
  }
  const now = new Date();
  await fsOps.utimes(heartbeatPath, now, now);
}

function heartbeatPathFor(lockPath, token) {
  return `${lockPath}.heartbeat-${token}`;
}

async function removeHeartbeatArtifacts(fsOps, lockPath, token) {
  const heartbeatPath = heartbeatPathFor(lockPath, token);
  await fsOps.rm(heartbeatPath, { force: true });
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
