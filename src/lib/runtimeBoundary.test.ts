import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoRef, RuntimeRequest } from "../types";
import { isSettingsTransportRequest, repoStateKey, validateRepoRequestScope } from "./runtimeBoundary";

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

test("only local settings operations may retry through the message transport", () => {
  assert.equal(isSettingsTransportRequest({ type: "get-settings" }), true);
  assert.equal(isSettingsTransportRequest({ type: "save-settings", settings: testSettings() }), true);
  assert.equal(isSettingsTransportRequest({ type: "list-models", settings: testSettings() }), true);
  assert.equal(
    isSettingsTransportRequest({ type: "analyze-project", repo: { owner: "owner", repo: "repo", pageType: "repo" } }),
    false
  );
});

function testSettings() {
  return {
    provider: "openai" as const,
    apiKey: "test-key",
    baseUrl: "https://models.example/v1",
    model: "test-model"
  };
}
