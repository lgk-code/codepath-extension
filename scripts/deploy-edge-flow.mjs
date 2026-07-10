import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const BACKUP_MARKER = ".codepath-deploy-backup.json";
const inProcessMutationLocks = new Map();
export const DEPLOY_LOCK_DEFAULTS = Object.freeze({ timeoutMs: 30_000, leaseMs: 5_000 });

export async function runVerifiedDeployment({ verifyBuildVersion, build, syncTarget, withDeploymentLock = (action) => action(undefined) }) {
  return withDeploymentLock(async (mutationMutex) => {
    await verifyBuildVersion();
    await build();
    return syncTarget(mutationMutex);
  });
}

export async function withDeploymentMutationMutex(targetDir, action, lockOptions) {
  const mutationMutex = await acquireDeploymentMutationMutex(targetDir, lockOptions);
  try {
    return await action(mutationMutex);
  } finally {
    await mutationMutex.release();
  }
}

export async function replaceDirectoryAtomic({ sourceDir, targetDir, fsOps = {}, prepareStaging, verifyStaging, lockOptions, mutationMutex: providedMutationMutex }) {
  const ops = { cp, link, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile, ...fsOps };
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${targetDir}.staging-${suffix}`;
  const backupDir = `${targetDir}.backup-${suffix}`;
  const lockPath = `${targetDir}.deploy-lock`;
  let targetMoved = false;
  let promoted = false;

  await ops.mkdir(path.dirname(targetDir), { recursive: true });
  if (providedMutationMutex && providedMutationMutex.name !== deploymentMutexName(targetDir)) {
    throw new Error(`Deployment mutation mutex does not match target: ${targetDir}`);
  }
  const mutationMutex = providedMutationMutex ?? (await acquireDeploymentMutationMutex(targetDir, lockOptions));
  const releaseMutationMutex = !providedMutationMutex;
  try {
    const lease = await acquireDeploymentLock(ops, lockPath, lockOptions);
    try {
      await assertDeploymentOwnership(mutationMutex, lease);
      await ops.rm(stagingDir, { recursive: true, force: true });
      await reconcileBackupArtifacts(ops, targetDir);

      await ops.cp(sourceDir, stagingDir, { recursive: true });
      await prepareStaging?.(stagingDir);
      await verifyStaging?.(stagingDir);
      await assertDeploymentOwnership(mutationMutex, lease);

      if (await pathExists(ops, targetDir)) {
        await ops.writeFile(path.join(targetDir, BACKUP_MARKER), JSON.stringify({ schemaVersion: 1, transactionId: suffix }), "utf8");
        try {
          await assertDeploymentOwnership(mutationMutex, lease);
          await ops.rename(targetDir, backupDir);
        } catch (error) {
          await ops.rm(path.join(targetDir, BACKUP_MARKER), { force: true });
          throw error;
        }
        targetMoved = true;
      }
      await assertDeploymentOwnership(mutationMutex, lease);
      await ops.rename(stagingDir, targetDir);
      promoted = true;
      await assertDeploymentOwnership(mutationMutex, lease);
      if (targetMoved) await ops.rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      if (targetMoved && !promoted && (await mutationMutex.isOwned()) && (await lease.isOwned())) {
        if (await pathExists(ops, targetDir)) await ops.rm(targetDir, { recursive: true, force: true });
        if (await pathExists(ops, backupDir)) {
          await ops.rename(backupDir, targetDir);
          await ops.rm(path.join(targetDir, BACKUP_MARKER), { force: true });
        }
      }
      throw error;
    } finally {
      try {
        await ops.rm(stagingDir, { recursive: true, force: true });
        if (promoted && (await mutationMutex.isOwned()) && (await lease.isOwned())) await ops.rm(backupDir, { recursive: true, force: true });
      } finally {
        await lease.release();
      }
    }
  } finally {
    if (releaseMutationMutex) await mutationMutex.release();
  }
}

async function assertDeploymentOwnership(mutationMutex, lease) {
  await mutationMutex.assertOwned();
  await lease.assertOwned();
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
    await fsOps.rename(backups[0], targetDir);
    await fsOps.rm(path.join(targetDir, BACKUP_MARKER), { force: true });
    return;
  }
  for (const backup of backups) await fsOps.rm(backup, { recursive: true, force: true });
}

async function acquireDeploymentMutationMutex(
  targetDir,
  { timeoutMs = DEPLOY_LOCK_DEFAULTS.timeoutMs, helperStartupTimeoutMs = 10_000 } = {}
) {
  const name = deploymentMutexName(targetDir);
  const local = await acquireInProcessMutex(name, timeoutMs);
  let system;
  try {
    system = shouldUseWindowsSystemMutex() ? await acquirePowerShellMutex(name, timeoutMs, helperStartupTimeoutMs) : undefined;
  } catch (error) {
    await local.release();
    throw error;
  }

  return {
    name,
    async assertOwned() {
      await local.assertOwned();
      await system?.assertOwned();
    },
    async isOwned() {
      return (await local.isOwned()) && (system ? await system.isOwned() : true);
    },
    async release() {
      try {
        await system?.release();
      } finally {
        await local.release();
      }
    }
  };
}

function acquireInProcessMutex(name, timeoutMs) {
  let state = inProcessMutationLocks.get(name);
  if (!state) {
    state = { owned: false, waiters: [] };
    inProcessMutationLocks.set(name, state);
  }

  if (!state.owned) {
    state.owned = true;
    return Promise.resolve(createInProcessMutexHandle(name, state));
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: undefined };
    waiter.timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for the deployment mutation mutex: ${name}`));
    }, timeoutMs);
    waiter.timer.unref?.();
    state.waiters.push(waiter);
  });
}

function createInProcessMutexHandle(name, state) {
  let owned = true;
  return {
    async assertOwned() {
      if (!owned) throw new Error(`Deployment mutation mutex was lost: ${name}`);
    },
    async isOwned() {
      return owned;
    },
    async release() {
      if (!owned) return;
      owned = false;
      const next = state.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(createInProcessMutexHandle(name, state));
        return;
      }
      state.owned = false;
      if (inProcessMutationLocks.get(name) === state) inProcessMutationLocks.delete(name);
    }
  };
}

function shouldUseWindowsSystemMutex() {
  return process.platform === "win32" || Boolean(process.env.WSL_INTEROP) || Boolean(process.env.WSL_DISTRO_NAME);
}

function deploymentMutexName(targetDir) {
  let canonical = path.resolve(targetDir);
  const wslDrive = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(canonical);
  if (wslDrive) canonical = `${wslDrive[1].toUpperCase()}:\\${(wslDrive[2] ?? "").replaceAll("/", "\\")}`;
  canonical = canonical.replaceAll("/", "\\").toLowerCase();
  return `CodePathDeploy-${createHash("sha256").update(canonical).digest("hex")}`;
}

function acquirePowerShellMutex(name, timeoutMs, helperStartupTimeoutMs) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$mutex = [System.Threading.Mutex]::new($false, '${name}')`,
    "$acquired = $false",
    "try {",
    "  [Console]::Out.WriteLine('READY')",
    "  [Console]::Out.Flush()",
    `  try { $acquired = $mutex.WaitOne(${Math.max(0, Math.floor(timeoutMs))}) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }`,
    "  if (-not $acquired) { [Console]::Out.WriteLine('TIMEOUT'); exit 3 }",
    "  [Console]::Out.WriteLine('ACQUIRED')",
    "  [Console]::Out.Flush()",
    "  [Console]::In.ReadToEnd() | Out-Null",
    "} finally {",
    "  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }",
    "  $mutex.Dispose()",
    "}"
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let settled = false;
    let ready = false;
    let stdout = "";
    let stderr = "";
    let phaseTimer = setTimeout(() => fail(new Error(`Timed out starting the deployment mutation mutex helper: ${name}`)), helperStartupTimeoutMs);
    phaseTimer.unref?.();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      child.kill();
      reject(error);
    };
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      if (!ready && lines.includes("READY")) {
        ready = true;
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(
          () => fail(new Error(`Timed out waiting for the deployment mutation mutex helper: ${name}`)),
          timeoutMs + helperStartupTimeoutMs
        );
        phaseTimer.unref?.();
      }
      if (lines.includes("TIMEOUT")) {
        fail(new Error(`Timed out waiting for the deployment mutation mutex: ${name}`));
        return;
      }
      if (!lines.includes("ACQUIRED") || settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      resolve(createPowerShellMutexHandle(child, name));
    });
    child.once("error", (error) => fail(new Error(`Unable to start deployment mutation mutex helper: ${error.message}`)));
    child.once("exit", (code) => {
      if (!settled) fail(new Error(`Deployment mutation mutex helper exited before acquisition (${code}): ${stderr.trim()}`));
    });
  });
}

function createPowerShellMutexHandle(child, name) {
  let released = false;
  let exited = child.exitCode !== null;
  child.once("exit", () => {
    exited = true;
  });
  return {
    async assertOwned() {
      if (released || exited || child.exitCode !== null) throw new Error(`Deployment mutation mutex was lost: ${name}`);
    },
    async isOwned() {
      return !released && !exited && child.exitCode === null;
    },
    async release() {
      if (released) return;
      released = true;
      if (exited || child.exitCode !== null) return;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.kill();
          finish();
        }, 5_000);
        timer.unref?.();
        child.once("exit", finish);
        child.stdin.end();
      });
    }
  };
}

async function acquireDeploymentLock(
  fsOps,
  lockPath,
  {
    timeoutMs = DEPLOY_LOCK_DEFAULTS.timeoutMs,
    retryMs = 25,
    leaseMs = DEPLOY_LOCK_DEFAULTS.leaseMs,
    heartbeatMs = Math.min(10_000, leaseMs / 3)
  } = {}
) {
  const startedAt = Date.now();
  const owner = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
