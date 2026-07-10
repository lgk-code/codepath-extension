import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export async function verifyRelease({ tag, packageVersion, taggedSha, mainSha, isAncestor }) {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag || "<missing>"} does not match package version ${packageVersion}.`);
  }
  if (!isCommitSha(taggedSha) || !isCommitSha(mainSha)) {
    throw new Error("Release provenance requires full 40-character commit SHAs.");
  }
  if (!(await isAncestor(taggedSha, mainSha))) {
    throw new Error(`Tagged commit ${taggedSha} is not contained in main ${mainSha}.`);
  }
  return { tag, taggedSha, mainSha };
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
  const taggedSha = git("rev-list", "-n", "1", tag);
  const mainSha = git("rev-parse", "refs/remotes/origin/main");
  const result = await verifyRelease({
    tag,
    packageVersion: pkg.version,
    taggedSha,
    mainSha,
    isAncestor: async (candidate, main) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", candidate, main], { stdio: "ignore" });
        return true;
      } catch (error) {
        if (error?.status === 1) return false;
        throw error;
      }
    }
  });
  console.log(`Release provenance verified: ${result.tag} -> ${result.taggedSha} on main ${result.mainSha}`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
