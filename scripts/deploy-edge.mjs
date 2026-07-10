import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { replaceDirectoryAtomic, runVerifiedDeployment, withDeploymentMutationMutex } from "./deploy-edge-flow.mjs";
import { validateDeployTarget } from "./deploy-target.mjs";
import { DEV_RELOAD_MARKER_PATH, createDevReloadMarker, extractBuildId, parseDevReloadMarker } from "./dev-reload-marker.mjs";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, ".output", "chrome-mv3");
const defaultTargetDir =
  process.platform === "win32"
    ? "D:\\edge下载\\CodePath"
    : "/mnt/d/edge下载/CodePath";
const targetDir = process.env.CODEPATH_EDGE_EXTENSION_DIR || defaultTargetDir;
const allowedRoot = path.resolve(process.env.CODEPATH_EDGE_EXTENSION_ROOT || path.dirname(defaultTargetDir));
const { targetDir: resolvedTargetDir } = await validateDeployTarget({ projectRoot, allowedRoot, targetDir, platform: process.platform });

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

await runVerifiedDeployment({
  withDeploymentLock: (action) => withDeploymentMutationMutex(resolvedTargetDir, action),
  verifyBuildVersion: () => run(npmCommand, ["run", "verify:build-version"]),
  build: () => run(npmCommand, ["run", "build"]),
  syncTarget: async (mutationMutex) => {
    if (!existsSync(outputDir)) {
      throw new Error(`Build output not found: ${outputDir}`);
    }

    const contentSource = await readFile(path.join(projectRoot, "entrypoints", "content.tsx"), "utf8");
    const buildId = extractBuildId(contentSource);
    const marker = createDevReloadMarker(buildId);

    await replaceDirectoryAtomic({
      sourceDir: outputDir,
      targetDir: resolvedTargetDir,
      mutationMutex,
      prepareStaging: (stagingDir) =>
        writeFile(path.join(stagingDir, DEV_RELOAD_MARKER_PATH), `${JSON.stringify(marker, null, 2)}\n`, "utf8"),
      verifyStaging: async (stagingDir) => {
        const manifest = JSON.parse(await readFile(path.join(stagingDir, "manifest.json"), "utf8"));
        if (!manifest || typeof manifest !== "object" || manifest.manifest_version !== 3) {
          throw new Error("Staged extension manifest is missing or invalid.");
        }
        const stagedMarker = parseDevReloadMarker(JSON.parse(await readFile(path.join(stagingDir, DEV_RELOAD_MARKER_PATH), "utf8")));
        if (!stagedMarker || stagedMarker.buildId !== buildId) {
          throw new Error("Staged extension reload marker is missing or invalid.");
        }
      }
    });

    console.log(`CodePath Edge build deployed to ${resolvedTargetDir}`);
    console.log(`Dev reload marker written for ${buildId}.`);
    console.log("Next: wait for CodePath to self-reload, then refresh the GitHub page if the tab was not refreshed automatically.");
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(`${command} ${args.join(" ")}`, { stdio: "inherit", shell: true })
        : spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}
