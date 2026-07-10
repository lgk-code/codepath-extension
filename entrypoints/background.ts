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
  generateSuggestedQuestions,
  generateSkillBlueprint,
  getAnalysisCacheStats
} from "../src/lib/analyzer";
import { chat, listModels, normalizeBaseUrl, probeStreamingSupport, resolveProvider } from "../src/lib/aiClient";
import { DEV_RELOAD_MARKER_PATH, checkDevSelfReloadOnce, parseDevReloadMarker, type ExtensionInstallType } from "../src/lib/devSelfReload";
import { GithubClient } from "../src/lib/githubClient";
import { validateRepoRequestScope } from "../src/lib/runtimeBoundary";

const BACKGROUND_BUILD = "dev-2026-07-10-adversarial-review-fixes-v3";
const DEV_RELOAD_ALARM_NAME = "codepath-dev-self-reload";
const DEV_RELOAD_ALARM_PERIOD_MINUTES = 0.5;
const DEV_RELOAD_ACTIVE_INTERVAL_MS = 5_000;
const PORT_HEARTBEAT_INTERVAL_MS = 20_000;

type StreamHandlers = {
  onModelStart?: () => void;
  onModelDelta?: (text: string) => void;
  onModelDone?: () => void;
  onModelFallback?: (reason: string) => void;
};

let devReloadStarted = false;
let devReloadCheckInFlight = false;

export default defineBackground(() => {
  startDevSelfReload();

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === DEV_RELOAD_ALARM_NAME) void checkDevSelfReload();
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "update") void refreshGithubTabsAfterDevReload();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "codepath") return;
    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Extract<PortMessage, { request: RuntimeRequest }>;
      void handlePortRequest(port, envelope);
    });
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleRequest(request as RuntimeRequest, {}, senderUrl(sender)).then(sendResponse);
    return true;
  });
});

async function handlePortRequest(port: ChromePort, envelope: Extract<PortMessage, { request: RuntimeRequest }>) {
  const post = (message: PortMessage) => {
    try {
      port.postMessage(message);
    } catch {
      // The caller may navigate or close the tab while analysis is running.
    }
  };
  const heartbeat = globalThis.setInterval(
    () => post({ id: envelope.id, event: "heartbeat" }),
    PORT_HEARTBEAT_INTERVAL_MS
  );
  try {
    const response = await handleRequest(
      envelope.request,
      {
        onModelStart: () => post({ id: envelope.id, event: "stream-start" }),
        onModelDelta: (text) => post({ id: envelope.id, event: "stream-delta", text }),
        onModelDone: () => post({ id: envelope.id, event: "stream-done" }),
        onModelFallback: (reason) => post({ id: envelope.id, event: "stream-fallback", text: reason })
      },
      senderUrl(port.sender)
    );
    post({ id: envelope.id, response });
  } finally {
    globalThis.clearInterval(heartbeat);
  }
}

function senderUrl(sender: ChromeMessageSender | undefined): string | undefined {
  return sender?.tab?.url ?? sender?.url;
}

async function startDevSelfReload() {
  if (devReloadStarted) return;
  devReloadStarted = true;

  if ((await getExtensionInstallType()) !== "development") {
    chrome.alarms?.clear?.(DEV_RELOAD_ALARM_NAME);
    return;
  }

  chrome.alarms?.create(DEV_RELOAD_ALARM_NAME, { periodInMinutes: DEV_RELOAD_ALARM_PERIOD_MINUTES });
  globalThis.setInterval(() => void checkDevSelfReload(), DEV_RELOAD_ACTIVE_INTERVAL_MS);
  void checkDevSelfReload();
}

async function checkDevSelfReload() {
  if (devReloadCheckInFlight) return;
  devReloadCheckInFlight = true;
  try {
    await checkDevSelfReloadOnce({
      currentBuildId: BACKGROUND_BUILD,
      getInstallType: getExtensionInstallType,
      readMarker: readDevReloadMarker,
      reload: () => chrome.runtime.reload()
    });
  } catch {
    // Dev-only convenience path: failures should never break normal extension requests.
  } finally {
    devReloadCheckInFlight = false;
  }
}

async function refreshGithubTabsAfterDevReload() {
  try {
    if ((await getExtensionInstallType()) !== "development") return;
    const marker = await readDevReloadMarker();
    if (!marker || marker.buildId !== BACKGROUND_BUILD) return;
    chrome.tabs?.query({ url: "https://github.com/*/*" }, (tabs) => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs) {
        if (typeof tab.id === "number") chrome.tabs?.reload(tab.id);
      }
    });
  } catch {
    // Page refresh is best-effort. Reloading the extension itself is the critical path.
  }
}

async function getExtensionInstallType(): Promise<ExtensionInstallType> {
  if (!chrome.management?.getSelf) return "unknown";
  try {
    const info = await chrome.management.getSelf();
    return info.installType ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function readDevReloadMarker() {
  const url = `${chrome.runtime.getURL(DEV_RELOAD_MARKER_PATH)}?t=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  return parseDevReloadMarker(await response.json());
}

async function handleRequest(request: RuntimeRequest, streamHandlers: StreamHandlers = {}, requestSenderUrl?: string): Promise<RuntimeResponse<unknown>> {
  try {
    if (!validateRepoRequestScope(request, requestSenderUrl)) {
      return fail("Repository request does not match the sender GitHub tab.");
    }
    const validationError = validateRuntimeRequest(request);
    if (validationError) return fail(validationError);

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
      return ok(await analyzeProject(request.repo, settings, { ...streamHandlers, mode: request.mode }));
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

    if (request.type === "generate-suggestions") {
      return ok(await generateSuggestedQuestions(request.repo, settings, request));
    }

    if (request.type === "answer-question") {
      return ok(await answerQuestion(request.repo, settings, request.question, request.context, streamHandlers, request.contextBasis));
    }

    return fail("Unknown request.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function validateRuntimeRequest(request: RuntimeRequest): string {
  if ("feature" in request) {
    const error = validateText(request.feature, "功能描述", 500);
    if (error) return error;
  }
  if ("question" in request) {
    const error = validateText(request.question, "追问", 2000);
    if (error) return error;
  }
  if ("summary" in request) {
    const error = validateText(request.summary, "分析摘要", 30_000);
    if (error) return error;
  }
  return "";
}

function validateText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) return `${label}不能为空。`;
  if (normalized.length > maxLength) return `${label}过长，最多 ${maxLength} 个字符。`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return `${label}不能包含控制字符。`;
  return "";
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
  const baseUrl = normalizeBaseUrl(settings.baseUrl || DEFAULT_SETTINGS.baseUrl);
  return {
    ...settings,
    provider: resolveProvider({ provider: settings.provider, baseUrl }),
    apiKey: settings.apiKey.trim(),
    baseUrl,
    model: settings.model.trim() || DEFAULT_SETTINGS.model,
    githubToken: settings.githubToken?.trim() ?? "",
    maxOutputTokens: Number.isFinite(settings.maxOutputTokens) ? settings.maxOutputTokens : DEFAULT_SETTINGS.maxOutputTokens
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
  if (message.includes("404")) return "模型连接失败：Base URL、模型名称或接口格式不匹配，请确认 OpenAI 格式使用 /chat/completions，Anthropic 格式使用 /messages。";
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
