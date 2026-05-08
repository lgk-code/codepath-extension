import type { PortMessage, RuntimeRequest, RuntimeResponse, Settings, SettingsDiagnostics } from "../src/types";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/defaults";
import { analyzeFeature, analyzeProject, answerQuestion, explainFile } from "../src/lib/analyzer";
import { GithubClient } from "../src/lib/githubClient";

export default defineBackground(() => {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "codepath") return;
    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Extract<PortMessage, { request: RuntimeRequest }>;
      handleRequest(envelope.request).then((response) => {
        port.postMessage({ id: envelope.id, response } satisfies PortMessage);
      });
    });
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    handleRequest(request as RuntimeRequest).then(sendResponse);
    return true;
  });
});

async function handleRequest(request: RuntimeRequest): Promise<RuntimeResponse<unknown>> {
  try {
    if (request.type === "get-settings") {
      return ok(await getSettings());
    }

    if (request.type === "save-settings") {
      await storageSet({ [SETTINGS_KEY]: request.settings });
      return ok(request.settings);
    }

    if (request.type === "test-settings") {
      return ok(await testSettings(request));
    }

    const settings = await getSettings();

    if (request.type === "analyze-project") {
      return ok(await analyzeProject(request.repo, settings));
    }

    if (request.type === "analyze-feature") {
      return ok(await analyzeFeature(request.repo, settings, request.feature));
    }

    if (request.type === "explain-file") {
      return ok(await explainFile(request.repo, settings));
    }

    if (request.type === "answer-question") {
      return ok(await answerQuestion(request.repo, settings, request.question, request.context));
    }

    return fail("Unknown request.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function getSettings(): Promise<Settings> {
  const stored = await storageGet(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY];
  const patch = isSettingsPatch(value);
  return { ...DEFAULT_SETTINGS, ...patch };
}

function storageGet(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items);
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function isSettingsPatch(value: unknown): Partial<Settings> {
  if (!value || typeof value !== "object") return {};
  return value as Partial<Settings>;
}

async function testSettings(request: Extract<RuntimeRequest, { type: "test-settings" }>): Promise<SettingsDiagnostics> {
  const settings = await getSettings();
  const diagnostics: SettingsDiagnostics = {
    provider: settings.provider,
    apiKeyPreview: maskSecret(settings.apiKey),
    hasApiKey: Boolean(settings.apiKey),
    baseUrl: settings.baseUrl,
    model: settings.model,
    githubTokenPreview: maskSecret(settings.githubToken || ""),
    hasGithubToken: Boolean(settings.githubToken)
  };

  if (request.repo) {
    try {
      const repo = await new GithubClient(settings).getRepo(request.repo.owner, request.repo.repo);
      diagnostics.repoCheck = `GitHub 连接正常：默认分支 ${repo.default_branch}`;
    } catch (error) {
      diagnostics.repoCheck = `GitHub 连接失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return diagnostics;
}

function maskSecret(value: string): string {
  if (!value) return "Not set";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function ok<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeResponse<never> {
  return { ok: false, error };
}
