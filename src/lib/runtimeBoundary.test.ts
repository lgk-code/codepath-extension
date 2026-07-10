import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoRef, RuntimeRequest } from "../types";
import { canFallbackLocallyBeforeDispatch, repoStateKey, validateRepoRequestScope, validateRequestLocation } from "./runtimeBoundary";

test("repoStateKey cannot collide when branch and path contain slashes", () => {
  const first: RepoRef = {
    owner: "owner",
    repo: "repo",
    branch: "feature/file",
    pageType: "file",
    path: "entry.ts"
  };
  const second: RepoRef = {
    owner: "owner",
    repo: "repo",
    branch: "feature",
    pageType: "file",
    path: "file/entry.ts"
  };

  assert.notEqual(repoStateKey(first), repoStateKey(second));
});

test("validateRepoRequestScope rejects a repository different from the sender tab", () => {
  const request: RuntimeRequest = {
    type: "analyze-project",
    repo: { owner: "other", repo: "repo", pageType: "repo" }
  };

  assert.equal(validateRepoRequestScope(request, "https://github.com/owner/current"), false);
});

test("validateRepoRequestScope accepts the sender repository and non-repository settings requests", () => {
  const request: RuntimeRequest = {
    type: "analyze-project",
    repo: { owner: "Owner", repo: "Current", pageType: "repo" }
  };

  assert.equal(validateRepoRequestScope(request, "https://github.com/owner/current/tree/main"), true);
  assert.equal(validateRepoRequestScope({ type: "get-settings" }, "chrome-extension://extension-id/secret-input.html"), true);
});

test("only an undispatched model-list request may fall back to a local call", () => {
  assert.equal(canFallbackLocallyBeforeDispatch({ type: "get-settings" }, false), false);
  assert.equal(canFallbackLocallyBeforeDispatch({ type: "save-settings", settings: testSettings() }, false), false);
  assert.equal(canFallbackLocallyBeforeDispatch({ type: "list-models", settings: testSettings() }, false), true);
  assert.equal(canFallbackLocallyBeforeDispatch({ type: "list-models", settings: testSettings() }, true), false);
  assert.equal(
    canFallbackLocallyBeforeDispatch({ type: "analyze-project", repo: { owner: "owner", repo: "repo", pageType: "repo" } }, false),
    false
  );
});

test("validateRequestLocation rejects a repository request after in-page navigation", () => {
  const request: RuntimeRequest = {
    type: "explain-file",
    repo: { owner: "Owner", repo: "Repo", branch: "main", pageType: "file", path: "src/old.ts" }
  };

  assert.equal(validateRequestLocation(request, "https://github.com/owner/repo/blob/main/src/old.ts"), true);
  assert.equal(validateRequestLocation(request, "https://github.com/owner/repo/blob/main/src/new.ts"), false);
  assert.equal(validateRequestLocation(request, "https://github.com/owner/repo/tree/main"), false);
});

function testSettings() {
  return {
    provider: "openai" as const,
    apiKey: "test-key",
    baseUrl: "https://models.example/v1",
    model: "test-model"
  };
}
