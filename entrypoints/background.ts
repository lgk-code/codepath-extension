import type { ModelListResult, PortMessage, RuntimeRequest, RuntimeResponse, Settings, SettingsDiagnostics } from "../src/types";
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
import { chat, listModels, normalizeBaseUrl, normalizeProvider, probeStreamingSupport } from "../src/lib/aiClient";
import { GithubClient } from "../src/lib/githubClient";

type StreamHandlers = {
  onModelStart?: () => void;
  onModelDelta?: (text: string) => void;
  onModelDone?: () => void;
  onModelFallback?: (reason: string) => void;
};

export default defineBackground(() => {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "codepath") return;
    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Extract<PortMessage, { request: RuntimeRequest }>;
      handleRequest(envelope.request, {
        onModelStart: () => port.postMessage({ id: envelope.id, event: "stream-start" } satisfies PortMessage),
        onModelDelta: (text) => port.postMessage({ id: envelope.id, event: "stream-delta", text } satisfies PortMessage),
        onModelDone: () => port.postMessage({ id: envelope.id, event: "stream-done" } satisfies PortMessage),
        onModelFallback: (reason) => port.postMessage({ id: envelope.id, event: "stream-fallback", text: reason } satisfies PortMessage)
      }).then((response) => {
        port.postMessage({ id: envelope.id, response } satisfies PortMessage);
      });
    });
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    handleRequest(request as RuntimeRequest).then(sendResponse);
    return true;
  });
});

async function handleRequest(request: RuntimeRequest, streamHandlers: StreamHandlers = {}): Promise<RuntimeResponse<unknown>> {
  try {
    if (request.type === "get-settings") {
      return ok(await getSettings());
    }

    if (request.type === "save-settings") {
      const settings = normalizeSettings(request.settings);
      await storageSet({ [SETTINGS_KEY]: settings });
      return ok(settings);
    }

    if (request.type === "list-models") {
      return ok(await getModelList(request.settings));
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
      return ok(await analyzeProject(request.repo, settings, streamHandlers));
    }

    if (request.type === "analyze-feature") {
      return ok(await analyzeFeature(request.repo, settings, request.feature, streamHandlers));
    }

    if (request.type === "generate-skill-blueprint") {
      return ok(await generateSkillBlueprint(request.repo, settings, request.feature, request.mode, streamHandlers));
    }

    if (request.type === "explain-file") {
      return ok(await explainFile(request.repo, settings, streamHandlers));
    }

    if (request.type === "answer-question") {
      return ok(await answerQuestion(request.repo, settings, request.question, request.context, streamHandlers));
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
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...patch });
}

async function getModelList(settings: Settings): Promise<ModelListResult> {
  const normalized = normalizeSettings(settings);
  const models = await listModels(normalized);
  const selectedModel = normalized.model && models.some((model) => model.id === normalized.model) ? normalized.model : models[0]?.id ?? "";
  return {
    baseUrl: normalized.baseUrl,
    models,
    selectedModel,
    message: models.length > 0 ? `已获取 ${models.length} 个模型。` : "模型列表为空，请手动填写模型名称。"
  };
}

function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    provider: normalizeProvider(settings.provider),
    apiKey: settings.apiKey.trim(),
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    model: settings.model.trim(),
    githubToken: settings.githubToken?.trim() ?? ""
  };
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
    hasGithubToken: Boolean(settings.githubToken),
    supportsStreaming: settings.supportsStreaming,
    streamingMode: settings.streamingMode || "untested"
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
      const streaming = await probeStreamingSupport(settings);
      diagnostics.supportsStreaming = streaming.supported;
      diagnostics.streamingMode = streaming.mode;
      diagnostics.streamFirstDeltaMs = streaming.firstDeltaMs;
      diagnostics.streamDeltaCount = streaming.deltaCount;
      diagnostics.streamingCheck = streaming.message;
      await storageSet({ [SETTINGS_KEY]: { ...settings, supportsStreaming: streaming.supported, streamingMode: streaming.mode } });
    } catch (error) {
      diagnostics.modelCheck = formatModelDiagnostic(error);
      diagnostics.supportsStreaming = false;
      diagnostics.streamingMode = "untested";
      diagnostics.streamingCheck = "流式输出未测试：模型连接失败，请先修复模型配置。";
    }
  } else {
    diagnostics.modelCheck = "模型连接未测试：未填写 API Key。";
    diagnostics.supportsStreaming = false;
    diagnostics.streamingMode = "untested";
    diagnostics.streamingCheck = "流式输出未测试：未填写 API Key。";
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
  if (message.includes("404")) return "模型连接失败：Base URL、模型名称或服务商类型不匹配，请确认 OpenAI 兼容接口使用 /chat/completions，Anthropic 兼容接口使用 /messages。";
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
