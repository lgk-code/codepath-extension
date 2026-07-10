import { cp, link, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BACKUP_MARKER = ".codepath-deploy-backup.json";

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget }) {
  await verifyBuildVersion();
  await build();
  return syncTarget();
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging, lockOptions }) {
  const ops = { cp, link, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile, ...fsOps };
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
      await ops.writeFile(path.join(targetDir, BACKUP_MARKER), JSON.stringify({ schemaVersion: 1, transactionId: suffix }), "utf8");
      try {
        await ops.rename(targetDir, backupDir);
      } catch (error) {
        await ops.rm(path.join(targetDir, BACKUP_MARKER), { force: true });
        throw error;
      }
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
      if (await pathExists(ops, backupDir)) {
        await ops.rm(path.join(backupDir, BACKUP_MARKER), { force: true });
        await ops.rename(backupDir, targetDir);
      }
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
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backupPattern = new RegExp(`^${escapedBasename}\\.backup-(\\d+-\\d+-[0-9a-f]+)$`, "i");
  const backups = [];
  for (const name of names) {
    const match = backupPattern.exec(name);
    if (!match) continue;
    const backup = path.join(parent, name);
    try {
      const marker = JSON.parse(await fsOps.readFile(path.join(backup, BACKUP_MARKER), "utf8"));
      if (marker?.schemaVersion === 1 && marker.transactionId === match[1]) backups.push(backup);
    } catch {
      // Similar names without a valid CodePath transaction marker are not ours.
    }
  }
  if (backups.length === 0) return;
  if (!(await pathExists(fsOps, targetDir))) {
    if (backups.length !== 1) throw new Error(`Cannot recover deployment: found ${backups.length} backup directories for ${targetDir}.`);
    await fsOps.rm(path.join(backups[0], BACKUP_MARKER), { force: true });
    await fsOps.rename(backups[0], targetDir);
    return;
  }
  for (const backup of backups) await fsOps.rm(backup, { recursive: true, force: true });
}

async function acquireDeploymentLock(fsOps, lockPath, { timeoutMs = 30_000, retryMs = 25, leaseMs = 120_000, heartbeatMs = Math.min(10_000, leaseMs / 3) } = {}) {
  const startedAt = Date.now();
  const owner = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    runtimeId: currentRuntimeId(),
    updatedAt: Date.now()
  };
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  while (true) {
    let handle;
    let published = false;
    try {
      handle = await fsOps.open(candidatePath, "wx");
      owner.updatedAt = Date.now();
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsOps.link(candidatePath, lockPath);
      published = true;
      await fsOps.rm(candidatePath, { force: true });
      await createHeartbeat(fsOps, heartbeatPathFor(lockPath, owner.token), owner);
      return createDeploymentLease(fsOps, lockPath, owner, leaseMs, heartbeatMs);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fsOps.rm(candidatePath, { force: true });
      if (published) {
        if ((await readLockToken(fsOps, lockPath)) === owner.token) await fsOps.rm(lockPath, { force: true });
        await removeHeartbeatArtifacts(fsOps, lockPath, owner.token);
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = await readLockObservation(fsOps, lockPath);
    if (!observed) continue;
    if (Date.now() - observed.updatedAt > leaseMs) {
      if (await tryFenceStaleLock(fsOps, lockPath, observed, owner.token, leaseMs, retryMs)) continue;
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
        await refreshHeartbeat(fsOps, heartbeatPath);
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
      let currentToken = await readLockToken(fsOps, lockPath);
      let currentHeartbeat = await readHeartbeat(fsOps, heartbeatPath);
      if (currentToken !== owner.token || currentHeartbeat?.token !== owner.token) {
        throw new Error(`Deployment lease was lost: ${lockPath}`);
      }
      if (!Number.isFinite(currentHeartbeat.updatedAt) || Date.now() - currentHeartbeat.updatedAt > leaseMs) {
        await refreshHeartbeat(fsOps, heartbeatPath);
        currentToken = await readLockToken(fsOps, lockPath);
        currentHeartbeat = await readHeartbeat(fsOps, heartbeatPath);
        if (currentToken !== owner.token || currentHeartbeat?.token !== owner.token) {
          throw new Error(`Deployment lease was lost: ${lockPath}`);
        }
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
    let heartbeatPath;
    if (owner?.token) {
      heartbeatPath = heartbeatPathFor(lockPath, owner.token);
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
      pid: owner?.pid,
      runtimeId: owner?.runtimeId,
      heartbeatPath: heartbeatFingerprint ? heartbeatPath : undefined,
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
    return {
      token: owner.token,
      pid: Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined,
      runtimeId: typeof owner.runtimeId === "string" ? owner.runtimeId : undefined,
      updatedAt: Number.isFinite(owner.updatedAt) ? owner.updatedAt : undefined
    };
  } catch {
    return undefined;
  }
}

async function createHeartbeat(fsOps, heartbeatPath, owner) {
  const handle = await fsOps.open(heartbeatPath, "wx");
  try {
    await handle.writeFile(JSON.stringify({ token: owner.token }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function refreshHeartbeat(fsOps, heartbeatPath) {
  const now = new Date();
  await fsOps.utimes(heartbeatPath, now, now);
}

async function tryFenceStaleLock(fsOps, lockPath, observed, claimantToken, leaseMs, retryMs) {
  if (observed.token && observed.heartbeatPath) {
    if (!isConfirmedExitedOwner(observed)) return false;
    const fencedHeartbeat = `${observed.heartbeatPath}.fenced-${claimantToken}`;
    try {
      await fsOps.rename(observed.heartbeatPath, fencedHeartbeat);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return false;
      throw error;
    }

    try {
      const heartbeatContent = await fsOps.readFile(fencedHeartbeat, "utf8");
      const heartbeatStat = await fsOps.lstat(fencedHeartbeat);
      const heartbeatOwner = parseLockOwner(heartbeatContent);
      const refreshed = heartbeatOwner?.token !== observed.token || Date.now() - heartbeatStat.mtimeMs <= leaseMs;
      if (refreshed || (await readLockToken(fsOps, lockPath)) !== observed.token) {
        if ((await readLockToken(fsOps, lockPath)) === observed.token && !(await pathExists(fsOps, observed.heartbeatPath))) {
          await fsOps.rename(fencedHeartbeat, observed.heartbeatPath);
        }
        return false;
      }

      const abandonedPath = `${lockPath}.abandoned-${claimantToken}`;
      try {
        await fsOps.rename(lockPath, abandonedPath);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
        if ((await readLockToken(fsOps, lockPath)) === observed.token && !(await pathExists(fsOps, observed.heartbeatPath))) {
          await fsOps.rename(fencedHeartbeat, observed.heartbeatPath);
        }
        return false;
      }
      await fsOps.rm(abandonedPath, { force: true });
      return true;
    } finally {
      await fsOps.rm(fencedHeartbeat, { force: true });
    }
  }

  if (observed.token && !isConfirmedExitedOwner(observed)) return false;

  await delay(Math.min(retryMs, 25));
  const confirmed = await readLockObservation(fsOps, lockPath);
  if (!confirmed || confirmed.fingerprint !== observed.fingerprint || Date.now() - confirmed.updatedAt <= leaseMs) return false;
  const abandonedPath = `${lockPath}.abandoned-${claimantToken}`;
  try {
    await fsOps.rename(lockPath, abandonedPath);
    await fsOps.rm(abandonedPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return false;
    throw error;
  }
}

function currentRuntimeId() {
  return `${process.platform}:${os.hostname().toLowerCase()}`;
}

function isConfirmedExitedOwner(owner) {
  if (owner.runtimeId !== currentRuntimeId() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
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
