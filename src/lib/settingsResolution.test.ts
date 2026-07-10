import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMcpSettings } from "./settingsResolution";

test("resolveMcpSettings keeps the OPENAI credential tuple together", () => {
  const settings = resolveMcpSettings({ OPENAI_API_KEY: "openai-test-key" });

  assert.equal(settings.provider, "openai");
  assert.equal(settings.apiKey, "openai-test-key");
  assert.equal(settings.baseUrl, "https://api.openai.com/v1");
  assert.equal(settings.model, "gpt-4.1-mini");
});

test("resolveMcpSettings uses CodePath defaults only with the CodePath namespace", () => {
  const settings = resolveMcpSettings({ CODEPATH_API_KEY: "codepath-test-key" });

  assert.equal(settings.provider, "openai");
  assert.equal(settings.apiKey, "codepath-test-key");
  assert.equal(settings.baseUrl, "https://api.deepseek.com");
  assert.equal(settings.model, "deepseek-v4-flash");
});

test("resolveMcpSettings rejects mixed model credential namespaces", () => {
  assert.throws(
    () => resolveMcpSettings({ OPENAI_API_KEY: "openai-test-key", CODEPATH_BASE_URL: "https://api.deepseek.com" }),
    /mixed credential namespaces/i
  );
});

test("resolveMcpSettings honors an explicit Anthropic provider on a neutral proxy", () => {
  const settings = resolveMcpSettings({
    CODEPATH_PROVIDER: "anthropic",
    CODEPATH_API_KEY: "anthropic-test-key",
    CODEPATH_BASE_URL: "https://models.example/v1",
    CODEPATH_MODEL: "claude-example"
  });

  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.baseUrl, "https://models.example/v1");
});
