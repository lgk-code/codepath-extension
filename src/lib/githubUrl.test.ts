import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGithubUrl } from "./githubUrl";

test("parseGithubUrl handles common slash branch file URLs", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/feature/sidebar/src/app.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "feature/sidebar",
    path: "src/app.ts",
    pageType: "file",
    refCandidates: [
      { refName: "feature", path: "sidebar/src/app.ts" },
      { refName: "feature/sidebar", path: "src/app.ts" },
      { refName: "feature/sidebar/src", path: "app.ts" }
    ]
  });
});

test("parseGithubUrl keeps common directory roots out of slash branch names", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/feature/sidebar/examples/demo.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "feature/sidebar",
    path: "examples/demo.ts",
    pageType: "file",
    refCandidates: [
      { refName: "feature", path: "sidebar/examples/demo.ts" },
      { refName: "feature/sidebar", path: "examples/demo.ts" },
      { refName: "feature/sidebar/examples", path: "demo.ts" }
    ]
  });
});

test("parseGithubUrl decodes file path segments", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/main/docs/hello%20world.md"), {
    owner: "acme",
    repo: "demo",
    branch: "main",
    path: "docs/hello world.md",
    pageType: "file",
    refCandidates: [
      { refName: "main", path: "docs/hello world.md" },
      { refName: "main/docs", path: "hello world.md" }
    ]
  });
});

test("parseGithubUrl rejects encoded repository separators and traversal segments", () => {
  assert.equal(parseGithubUrl("https://github.com/visible/..%2Fsecret-owner%2Fsecret-repo"), null);
  assert.equal(parseGithubUrl("https://github.com/visible/secret%5Crepo"), null);
  assert.equal(parseGithubUrl("https://github.com/visible/%2E%2E"), null);
});

test("parseGithubUrl rejects encoded separators and traversal inside file paths", () => {
  assert.equal(
    parseGithubUrl("https://github.com/visible/repo/blob/main/..%2F..%2F..%2Fsecret-owner%2Fsecret-repo%2Fcontents%2Fsecret.txt"),
    null
  );
});

test("parseGithubUrl keeps commit permalink refs separate from file paths", () => {
  const commit = "1234567890abcdef1234567890abcdef12345678";
  assert.deepEqual(parseGithubUrl(`https://github.com/acme/demo/blob/${commit}/foo/bar.ts`), {
    owner: "acme",
    repo: "demo",
    branch: commit,
    path: "foo/bar.ts",
    pageType: "file",
    refCandidates: [
      { refName: commit, path: "foo/bar.ts" },
      { refName: `${commit}/foo`, path: "bar.ts" }
    ]
  });
});

test("parseGithubUrl keeps tag refs separate from unknown directory paths", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/v1.0.0/foo/bar.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "v1.0.0",
    path: "foo/bar.ts",
    pageType: "file",
    refCandidates: [
      { refName: "v1.0.0", path: "foo/bar.ts" },
      { refName: "v1.0.0/foo", path: "bar.ts" }
    ]
  });
});

test("parseGithubUrl preserves a slash ref candidate after a tag-like prefix", () => {
  const parsed = parseGithubUrl("https://github.com/acme/demo/blob/v1.2.3/hotfix/src/app.ts") as RepoRefWithCandidates;

  assert.deepEqual(parsed.refCandidates, [
    { refName: "v1.2.3", path: "hotfix/src/app.ts" },
    { refName: "v1.2.3/hotfix", path: "src/app.ts" },
    { refName: "v1.2.3/hotfix/src", path: "app.ts" }
  ]);
});

test("parseGithubUrl preserves every possible slash ref and file path boundary", () => {
  const parsed = parseGithubUrl("https://github.com/acme/demo/blob/release/v2/src/app.ts") as RepoRefWithCandidates;

  assert.deepEqual(parsed.refCandidates, [
    { refName: "release", path: "v2/src/app.ts" },
    { refName: "release/v2", path: "src/app.ts" },
    { refName: "release/v2/src", path: "app.ts" }
  ]);
});

test("parseGithubUrl rejects oversized paths before materializing quadratic ref candidates", () => {
  const oversizedPath = Array.from({ length: 1_200 }, () => "segment").join("/");

  assert.equal(parseGithubUrl(`https://github.com/acme/demo/blob/main/${oversizedPath}/app.ts`), null);
});

type RepoRefWithCandidates = NonNullable<ReturnType<typeof parseGithubUrl>> & {
  refCandidates: Array<{ refName: string; path: string }>;
};
