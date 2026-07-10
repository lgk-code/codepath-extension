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
  assert.match(release, /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.match(release, /permissions:\s*\n\s*contents:\s*read/);
  assert.equal((release.match(/contents:\s*write/g) ?? []).length, 1);
  assert.match(release, /environment:\s*release/);
  assert.match(release, /needs:\s*build-extension/);
  const publishJob = release.slice(release.indexOf("  publish-release:"));
  assert.match(publishJob, /git fetch --force origin "refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"/);
  assert.match(publishJob, /CURRENT_COMMIT/);
  assert.match(publishJob, /EXPECTED_COMMIT/);
  assert.match(publishJob, /CURRENT_COMMIT" != "\$EXPECTED_COMMIT/);
});
