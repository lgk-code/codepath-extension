import path from "node:path";
import { fileURLToPath } from "node:url";

const API_VERSION = "2022-11-28";

export function assertImmutableReleaseTagRuleset(rulesets, tag) {
  const ref = `refs/tags/${tag}`;
  const matched = rulesets.find((ruleset) => {
    const ruleTypes = new Set((ruleset.rules ?? []).map((rule) => rule?.type));
    const includes = ruleset.conditions?.ref_name?.include ?? [];
    const excludes = ruleset.conditions?.ref_name?.exclude ?? [];
    return (
      ruleset.target === "tag" &&
      ruleset.enforcement === "active" &&
      (ruleset.bypass_actors ?? []).length === 0 &&
      ruleset.current_user_can_bypass === "never" &&
      includes.some((pattern) => releaseRefPatternMatches(pattern, ref)) &&
      excludes.length === 0 &&
      ruleTypes.has("update") &&
      ruleTypes.has("deletion")
    );
  });
  if (!matched) {
    throw new Error(`No immutable active tag ruleset protects ${ref} from updates and deletion for the publishing identity.`);
  }
  return matched;
}

export async function loadRepositoryRulesets(repository, token = "") {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  const summaries = await githubJson(`/repos/${repository}/rulesets?includes_parents=true&targets=tag&per_page=100`, token);
  if (!Array.isArray(summaries)) throw new Error("GitHub rulesets response was not an array.");
  return Promise.all(
    summaries.map((ruleset) => {
      if (!Number.isInteger(ruleset?.id)) throw new Error("GitHub ruleset summary did not include a numeric id.");
      return githubJson(`/repos/${repository}/rulesets/${ruleset.id}?includes_parents=true`, token);
    })
  );
}

function releaseRefPatternMatches(pattern, ref) {
  return pattern === "~ALL" || pattern === ref || (pattern === "refs/tags/v*" && ref.startsWith("refs/tags/v"));
}

async function githubJson(apiPath, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    throw new Error(`GitHub rulesets API ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

async function main() {
  const tag = process.argv[2] || process.env.RELEASE_TAG || "";
  const repository = process.env.GITHUB_REPOSITORY || "";
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag || "<empty>"}`);
  }
  const rulesets = await loadRepositoryRulesets(repository, process.env.GITHUB_TOKEN || "");
  const matched = assertImmutableReleaseTagRuleset(rulesets, tag);
  process.stdout.write(`Verified immutable release tag ruleset ${matched.id}: ${matched.name}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
