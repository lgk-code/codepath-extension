import type { PortMessage, RuntimeRequest, RuntimeResponse, Settings, SettingsDiagnostics } from "../src/types";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/defaults";
import {
  analyzeFeature,
  analyzeProject,
  answerQuestion,
  clearAnalysisCaches,
  deletePersistentCacheEntry,
  deletePersistentCacheRepo,
  explainFile,
  generateSkillBlueprint,
  getAnalysisCacheStats
} from "../src/lib/analyzer";
import { chat } from "../src/lib/aiClient";
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

    if (request.type === "clear-cache") {
      return ok(await clearAnalysisCaches(request.scope, request.repo));
    }

    if (request.type === "cache-stats") {
      return ok(await getAnalysisCacheStats(request.repo));
    }

    if (request.type === "delete-cache-entry") {
      return ok(await deletePersistentCacheEntry(request.key));
    }

    if (request.type === "delete-cache-repo") {
      return ok(await deletePersistentCacheRepo(request.repoKey));
    }

    const settings = await getSettings();

    if (request.type === "analyze-project") {
      return ok(await analyzeProject(request.repo, settings));
    }

    if (request.type === "analyze-feature") {
      return ok(await analyzeFeature(request.repo, settings, request.feature));
    }

    if (request.type === "generate-skill-blueprint") {
      return ok(await generateSkillBlueprint(request.repo, settings, request.feature, request.mode));
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
      diagnostics.repoCheck = `GitHub 连接正常：${request.repo.owner}/${request.repo.repo}，默认分支 ${repo.default_branch}。`;
    } catch (error) {
      diagnostics.repoCheck = formatGithubDiagnostic(error);
    }
  } else {
    diagnostics.repoCheck = "GitHub 连接未测试：当前页面未识别到仓库。";
  }

  if (settings.apiKey) {
    try {
      await chat(settings, [
        { role: "system", content: "You are a connection test. Reply with OK." },
        { role: "user", content: "Reply only: OK" }
      ]);
      diagnostics.modelCheck = `模型连接正常：${settings.model}。`;
    } catch (error) {
      diagnostics.modelCheck = formatModelDiagnostic(error);
    }
  } else {
    diagnostics.modelCheck = "模型连接未测试：未填写 API Key。";
  }

  return diagnostics;
}

function formatGithubDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("404")) return "GitHub 连接失败：仓库不存在、仓库为私有，或 Token 没有 Contents 读取权限。";
  if (message.includes("403") || message.toLowerCase().includes("rate limit")) return "GitHub 连接失败：API 限流或权限不足，请填写 GitHub Token 后重试。";
  if (message.includes("401") || message.toLowerCase().includes("unauthorized")) return "GitHub 连接失败：GitHub Token 无效或已过期。";
  return `GitHub 连接失败：${message}`;
}

function formatModelDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("401") || message.includes("403")) return "模型连接失败：API Key 无效、权限不足，或当前模型不可用。";
  if (message.includes("404")) return "模型连接失败：Base URL 或模型名称不正确，请确认使用 OpenAI-compatible 的 /v1 地址。";
  if (message.includes("Failed to fetch") || message.includes("Unable to reach")) return "模型连接失败：无法连接 Base URL，请检查网络、代理和服务地址。";
  if (message.toLowerCase().includes("timeout")) return "模型连接失败：请求超时，请检查网络或更换更快的模型。";
  return `模型连接失败：${message}`;
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
