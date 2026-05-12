import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, ".output", "chrome-mv3");
const targetDir = process.env.CODEPATH_EDGE_EXTENSION_DIR || "C:\\CodePathExtension\\chrome-mv3";
const resolvedTargetDir = path.resolve(targetDir);

if (path.parse(resolvedTargetDir).root === resolvedTargetDir || !resolvedTargetDir.toLowerCase().endsWith(`${path.sep}chrome-mv3`)) {
  throw new Error(`Refusing to deploy to unsafe extension directory: ${resolvedTargetDir}`);
}

await run("npm.cmd", ["run", "build"]);

if (!existsSync(outputDir)) {
  throw new Error(`Build output not found: ${outputDir}`);
}

await mkdir(resolvedTargetDir, { recursive: true });
await rm(resolvedTargetDir, { recursive: true, force: true });
await mkdir(resolvedTargetDir, { recursive: true });
await cp(outputDir, resolvedTargetDir, { recursive: true });

console.log(`CodePath Edge build deployed to ${resolvedTargetDir}`);
console.log("Next: open edge://extensions, reload CodePath, then refresh the GitHub page.");

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
