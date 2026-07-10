import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export async function verifyRelease({ tag, packageVersion, taggedSha, headSha, mainSha, tagObjectType, isAncestor }) {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag || "<missing>"} does not match package version ${packageVersion}.`);
  }
  if (tagObjectType !== "tag") {
    throw new Error(`Release provenance requires an annotated tag; ${tag || "<missing>"} resolves to ${tagObjectType || "unknown"}.`);
  }
  if (!isCommitSha(taggedSha) || !isCommitSha(headSha) || !isCommitSha(mainSha)) {
    throw new Error("Release provenance requires full 40-character commit SHAs.");
  }
  if (headSha !== taggedSha) {
    throw new Error(`Checked out HEAD ${headSha} does not match tagged commit ${taggedSha}.`);
  }
  if (!(await isAncestor(taggedSha, mainSha))) {
    throw new Error(`Tagged commit ${taggedSha} is not contained in main ${mainSha}.`);
  }
  return { tag, taggedSha, headSha, mainSha, tagObjectType };
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
  const tagRef = `refs/tags/${tag}`;
  const tagObjectType = git("cat-file", "-t", tagRef);
  const taggedSha = git("rev-parse", `${tagRef}^{commit}`);
  const headSha = git("rev-parse", "HEAD");
  const mainSha = git("rev-parse", "refs/remotes/origin/main");
  const result = await verifyRelease({
    tag,
    packageVersion: pkg.version,
    taggedSha,
    headSha,
    mainSha,
    tagObjectType,
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
