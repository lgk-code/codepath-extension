import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings } from "../types";
import { createSettingsStore } from "./settingsStore";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    provider: "openai",
    apiKey: "key-old",
    baseUrl: "https://models.example/v1",
    model: "model-old",
    githubToken: "github-old",
    supportsStreaming: false,
    streamingMode: "untested",
    ...overrides
  };
}

function memoryStore(initial: Settings) {
  let current = initial;
  const store = createSettingsStore({
    load: async () => current,
    save: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = next;
    },
    normalize: (value) => value
  });
  return { store, current: () => current };
}

test("settings store serializes independent secret updates", async () => {
  const fixture = memoryStore(settings());

  await Promise.all([
    fixture.store.updateSecret("apiKey", "key-new"),
    fixture.store.updateSecret("githubToken", "github-new")
  ]);

  assert.equal(fixture.current().apiKey, "key-new");
  assert.equal(fixture.current().githubToken, "github-new");
});

test("non-secret saves cannot restore stale credentials", async () => {
  const fixture = memoryStore(settings({ apiKey: "key-new", githubToken: "github-new" }));

  await fixture.store.saveNonSecret(settings({ apiKey: "key-old", githubToken: "github-old", model: "model-new" }));

  assert.equal(fixture.current().apiKey, "key-new");
  assert.equal(fixture.current().githubToken, "github-new");
  assert.equal(fixture.current().model, "model-new");
});

test("stream probe metadata is discarded after connection settings change", async () => {
  const tested = settings();
  const fixture = memoryStore(tested);

  await fixture.store.updateSecret("apiKey", "key-revoked");
  const applied = await fixture.store.updateStreamingMetadataIfCurrent(tested, {
    supportsStreaming: true,
    streamingMode: "realtime"
  });

  assert.equal(applied, false);
  assert.equal(fixture.current().apiKey, "key-revoked");
  assert.equal(fixture.current().supportsStreaming, false);
});
