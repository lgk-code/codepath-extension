import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

test("GitHub Actions references are pinned to immutable commit SHAs", () => {
  for (const workflowPath of workflowPaths) {
    const source = fs.readFileSync(workflowPath, "utf8");
    const references = [...source.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)];
    assert.ok(references.length > 0, `${workflowPath} should use actions`);
    for (const reference of references) {
      assert.match(reference[2], /^[0-9a-f]{40}$/i, `${reference[1]} in ${workflowPath} must be pinned`);
    }
  }
});

test("release workflow verifies tag provenance against full main history", () => {
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, /fetch-depth:\s*0/);
  assert.match(release, /refs\/remotes\/origin\/main/);
  assert.match(release, /git cat-file -t/);
  assert.match(release, /git merge-base --is-ancestor/);
  assert.match(release, /package\.json/);
});

test("release publication is orchestrated by the trusted default-branch workflow", () => {
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, /repository_dispatch:/);
  assert.doesNotMatch(release, /push:\s*[\s\S]*tags:/);
  assert.match(release, /if:\s*github\.ref == 'refs\/heads\/main' && github\.actor == github\.repository_owner/);
  assert.equal((release.match(/github\.actor == github\.repository_owner/g) ?? []).length, 2);
  assert.match(release, /permissions:\s*\n\s*contents:\s*read/);
  assert.equal((release.match(/contents:\s*write/g) ?? []).length, 1);
  assert.match(release, /environment:\s*release/);
  assert.match(release, /needs:\s*build-extension/);
  const buildJob = release.slice(release.indexOf("  build-extension:"), release.indexOf("  publish-release:"));
  assert.ok(
    buildJob.indexOf("Verify immutable release tag ruleset") < buildJob.indexOf("Verify annotated tag provenance"),
    "the immutable tag policy must be established before accepting a build candidate"
  );
  assert.match(buildJob, /RELEASE_TAG_OBJECT/);
  assert.match(buildJob, /tag_object=\$RELEASE_TAG_OBJECT/);
  const publishJob = release.slice(release.indexOf("  publish-release:"));
  const publishCheckout = publishJob.slice(
    publishJob.indexOf("Checkout trusted publish verifier"),
    publishJob.indexOf("Verify immutable release tag ruleset")
  );
  assert.match(publishCheckout, /ref:\s*\$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(publishCheckout, /ref:\s*main/);
  assert.match(publishJob, /git fetch --force origin "refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"/);
  assert.match(publishJob, /EXPECTED_TAG_OBJECT/);
  assert.match(publishJob, /CURRENT_TAG_OBJECT/);
  assert.match(publishJob, /CURRENT_TAG_OBJECT" != "\$EXPECTED_TAG_OBJECT/);
  assert.match(publishJob, /CURRENT_COMMIT/);
  assert.match(publishJob, /EXPECTED_COMMIT/);
  assert.match(publishJob, /CURRENT_COMMIT" != "\$EXPECTED_COMMIT/);
  assert.match(publishJob, /Verify immutable release tag ruleset/);
  assert.match(publishJob, /node scripts\/verify-release-ruleset\.mjs "\$RELEASE_TAG"/);
});
