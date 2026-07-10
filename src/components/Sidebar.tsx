import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, Clipboard, Download, FileCode2, KeyRound, Layers3, Map, RefreshCw, Route, Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AnalysisBasis,
  FeaturePath,
  FileExplanation,
  BlueprintMode,
  CacheClearResult,
  CacheDeleteResult,
  CacheStats,
  ModelListResult,
  ModelOption,
  PortMessage,
  ProjectAnalysisMode,
  ProjectOverview,
  RepoRef,
  RuntimeRequest,
  RuntimeResponse,
  Settings,
  SettingsDiagnostics,
  SkillBlueprint,
  SuggestedQuestionsResult,
  SuggestionAnalysisKind,
  TimingBreakdown
} from "../types";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../lib/defaults";
import { parseGithubUrl } from "../lib/githubUrl";
import { inferProviderFromBaseUrl, listModels, normalizeBaseUrl, resolveProvider } from "../lib/aiClient";
import { githubFileUrl, rehypeLinkCodePaths } from "../lib/linkPaths";
import { canFallbackLocallyBeforeDispatch, isRepoStateCurrent, repoStateKey, validateRequestLocation } from "../lib/runtimeBoundary";
import { createStreamBatcher } from "../lib/streamBatcher";

type Tab = "overview" | "feature" | "file" | "skill" | "settings";

type TabScrollPosition = {
  scrollTop: number;
  bottomOffset: number;
  nearBottom: boolean;
  hasValue: boolean;
};

type ChatTurn = {
  question: string;
  answer: ProjectOverview;
  elapsedMs?: number;
  timing?: TimingBreakdown;
};

type StreamTarget = "overview" | "feature" | "file" | "skill" | "ask";
type SuggestionTarget = Exclude<StreamTarget, "ask">;

type ActiveStream = {
  runId: number;
  repoKey: string;
  target: StreamTarget;
  question?: string;
  text: string;
  receivedDelta: boolean;
  expectsStreaming: boolean;
  mode: Settings["streamingMode"];
  fallbackReason?: string;
};

type AnalysisSuggestionRequest = {
  kind: SuggestionAnalysisKind;
  label?: string;
  summary: string;
  sources: string[];
};

type SuggestionPanelState = {
  questions: string[];
  loading: boolean;
  status: string;
  request?: AnalysisSuggestionRequest;
};

const PROJECT_ANALYSIS_MODE_HELP: Record<ProjectAnalysisMode, string> = {
  focused: "读取仓库文件树，并挑选重要源码片段进行分析。速度快，适合大多数项目，但不是全仓库源码全文分析。",
  "full-source": "读取所有可用的文本源码、配置和文档后再分析；仓库过大时会直接提示，不截断、不分批。"
};

const PROJECT_ANALYSIS_MODE_HINT: Record<ProjectAnalysisMode, string> = {
  focused: "当前模式会使用文件树和重要源码片段，速度更快；不是全仓库源码全文分析。",
  "full-source": "当前模式会读取所有可用源码；仓库过大时会直接提示，不截断、不分批。"
};

const UI_VERSION = "dev-2026-07-10-adversarial-review-fixes-v11";
const SIDEBAR_COLLAPSED_KEY = "codepath.sidebarCollapsed";

export function Sidebar() {
  const [repo, setRepo] = useState<RepoRef | null>(() => parseGithubUrl(location.href));
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed());
  const [width, setWidth] = useState(() => readPanelWidth());
  const [tab, setTab] = useState<Tab>("overview");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState("");
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [projectAnalysisMode, setProjectAnalysisMode] = useState<ProjectAnalysisMode>("focused");
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [feature, setFeature] = useState("");
  const [featurePath, setFeaturePath] = useState<FeaturePath | null>(null);
  const [blueprintFeature, setBlueprintFeature] = useState("");
  const [blueprintMode, setBlueprintMode] = useState<BlueprintMode>("openclaw-skill");
  const [skillBlueprint, setSkillBlueprint] = useState<SkillBlueprint | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [fileExplanation, setFileExplanation] = useState<FileExplanation | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<ChatTurn[]>([]);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsDiagnostics, setSettingsDiagnostics] = useState<SettingsDiagnostics | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [lastCacheClearResult, setLastCacheClearResult] = useState<CacheClearResult | null>(null);
  const [expandedCacheRepos, setExpandedCacheRepos] = useState<Record<string, boolean>>({});
  const [analysisSuggestions, setAnalysisSuggestions] = useState<Record<SuggestionTarget, SuggestionPanelState>>(createSuggestionStates);
  const contentRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const tabRef = useRef<Tab>("overview");
  const repoRef = useRef<RepoRef | null>(repo);
  const runIdRef = useRef(0);
  const tabScrollPositionsRef = useRef<Record<Tab, TabScrollPosition>>(createTabScrollPositions());

  useEffect(() => {
    repoRef.current = repo;
  }, [repo]);

  useEffect(() => {
    runIdRef.current += 1;
    setOverview(null);
    setFeaturePath(null);
    setSkillBlueprint(null);
    setFileExplanation(null);
    setAnswers([]);
    setQuestion("");
    setAnalysisSuggestions(createSuggestionStates());
    setLoading("");
    setLoadingStartedAt(null);
    setActiveStream(null);
    setError("");
  }, [repoStateKey(repo)]);

  useEffect(() => {
    send<Settings>({ type: "get-settings" }).then(setSettings).catch((err) => setError(err.message));
    const listener = () => {
      const nextRepo = parseGithubUrl(location.href);
      setRepo(nextRepo);
      if (nextRepo?.pageType === "file") switchTab("file");
    };
    window.addEventListener("codepath:url-change", listener);
    return () => window.removeEventListener("codepath:url-change", listener);
  }, []);

  useEffect(() => {
    if (!loadingStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [loadingStartedAt]);

  useEffect(() => {
    if (tab === "settings") void refreshCacheStats();
  }, [tab, repo?.owner, repo?.repo, repo?.branch]);

  useEffect(() => {
    if (!activeStream || !autoScrollRef.current) return;
    const element = contentRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight });
  }, [activeStream?.text]);

  useLayoutEffect(() => {
    tabRef.current = tab;
    const frame = window.requestAnimationFrame(() => restoreScrollPosition(tab));
    return () => window.cancelAnimationFrame(frame);
  }, [tab]);

  const title = useMemo(() => (repo ? `${repo.owner}/${repo.repo}` : "No GitHub repository detected"), [repo]);

  async function run<T>(
    target: StreamTarget,
    label: string,
    action: (onDelta: (text: string) => void, onFallback: (reason: string) => void) => Promise<T>,
    onDone: (value: T, elapsedMs: number) => void,
    meta: { question?: string } = {}
  ) {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const startedAt = Date.now();
    const startedRepoKey = repoStateKey(repoRef.current);
    setLoading(label);
    setLoadingStartedAt(startedAt);
    autoScrollRef.current = isContentNearBottom();
    setActiveStream({
      runId,
      repoKey: startedRepoKey,
      target,
      question: meta.question,
      text: "",
      receivedDelta: false,
      expectsStreaming: settings.supportsStreaming === true,
      mode: settings.streamingMode || "untested"
    });
    setNow(startedAt);
    setError("");
    const streamBatcher = createStreamBatcher((text) =>
      setActiveStream((current) =>
        current && current.runId === runId && current.target === target && current.repoKey === startedRepoKey && isCurrentRun(runId, startedRepoKey)
          ? { ...current, text: current.text + text, receivedDelta: true }
          : current
      )
    );
    try {
      const value = await action(streamBatcher.push, (reason) => markStreamFallback(runId, startedRepoKey, target, reason));
      streamBatcher.flush();
      if (!isCurrentRun(runId, startedRepoKey)) return;
      onDone(value, Date.now() - startedAt);
    } catch (err) {
      if (isCurrentRun(runId, startedRepoKey)) setError(formatRunError(label, repoRef.current, Date.now() - startedAt, err));
    } finally {
      streamBatcher.flush();
      if (isCurrentRun(runId, startedRepoKey)) {
        setLoading("");
        setLoadingStartedAt(null);
        setActiveStream((current) => (current?.runId === runId ? null : current));
      }
    }
  }

  function isCurrentRun(runId: number, repoKey: string) {
    return runIdRef.current === runId && repoKey === repoStateKey(repoRef.current) && isRepoStateCurrent(repoKey, location.href);
  }

  function isContentNearBottom() {
    const element = contentRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  function handleContentScroll() {
    autoScrollRef.current = isContentNearBottom();
    saveCurrentScrollPosition();
  }

  function switchTab(next: Tab) {
    if (next === tabRef.current) return;
    saveCurrentScrollPosition();
    tabRef.current = next;
    setTab(next);
  }

  function saveCurrentScrollPosition(tabName = tabRef.current) {
    const element = contentRef.current;
    if (!element) return;
    const bottomOffset = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
    tabScrollPositionsRef.current[tabName] = {
      scrollTop: element.scrollTop,
      bottomOffset,
      nearBottom: bottomOffset < 96,
      hasValue: true
    };
  }

  function restoreScrollPosition(tabName: Tab) {
    const element = contentRef.current;
    const position = tabScrollPositionsRef.current[tabName];
    if (!element || !position.hasValue) return;
    const top = position.nearBottom
      ? Math.max(0, element.scrollHeight - element.clientHeight - position.bottomOffset)
      : position.scrollTop;
    element.scrollTo({ top });
  }

  function markStreamFallback(runId: number, repoKey: string, target: StreamTarget, reason: string) {
    setActiveStream((current) =>
      current && current.runId === runId && current.target === target && current.repoKey === repoKey && isCurrentRun(runId, repoKey)
        ? { ...current, fallbackReason: reason, expectsStreaming: false, mode: "unsupported" }
        : current
    );
  }

  async function saveSettings(next: Settings) {
    setSettings(next);
    setSettingsStatus("正在保存设置...");
    setError("");
    try {
      const prepared = await prepareSettingsForSave(next);
      const saved = await send<Settings>({ type: "save-settings", settings: prepared });
      const verified = await send<Settings>({ type: "get-settings" });
      setSettings({ ...saved, ...verified });
      const diagnostics = await send<SettingsDiagnostics>({ type: "test-settings", repo: repo || undefined });
      setSettingsDiagnostics(diagnostics);
      setSettings((current) => ({ ...current, supportsStreaming: diagnostics.supportsStreaming, streamingMode: diagnostics.streamingMode }));
      setSettingsStatus(`设置已保存并测试。API Key: ${maskSecret(verified.apiKey)}`);
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function refreshSettings(status?: string) {
    const latest = await send<Settings>({ type: "get-settings" });
    setSettings(latest);
    if (status) setSettingsStatus(status);
  }

  async function testSettings() {
    setSettingsStatus("正在测试已保存的设置...");
    setError("");
    try {
      const diagnostics = await send<SettingsDiagnostics>({ type: "test-settings", repo: repo || undefined });
      setSettingsDiagnostics(diagnostics);
      setSettings((current) => ({ ...current, supportsStreaming: diagnostics.supportsStreaming, streamingMode: diagnostics.streamingMode }));
      setSettingsStatus(diagnostics.hasApiKey ? `已保存 API Key: ${diagnostics.apiKeyPreview}` : "未读取到已保存的模型 API Key。");
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function refreshCacheStats() {
    try {
      const stats = await send<CacheStats>({ type: "cache-stats", repo: repo || undefined });
      setCacheStats(stats);
    } catch (err) {
      setError(humanizeError(err));
    }
  }

  async function prepareSettingsForSave(next: Settings): Promise<Settings> {
    const prepared = normalizeSettingsDraft(next);
    if (prepared.model) return prepared;

    setSettingsStatus("正在获取可用模型...");
    try {
      const result = await send<ModelListResult>({ type: "list-models", settings: prepared });
      const model = result.selectedModel || result.models[0]?.id || "";
      if (!model) {
        throw new Error("模型列表为空，请手动填写模型名称。");
      }
      return { ...prepared, baseUrl: result.baseUrl, model };
    } catch (error) {
      throw new Error(`未能自动获取模型列表，请手动填写模型名称后再保存。${humanizeError(error)}`);
    }
  }

  function ask(text = question) {
    const trimmed = text.trim();
    if (!repo || !trimmed || loading) return;
    const askContext = buildAskContext(overview, featurePath, fileExplanation, answers);

    if (tabRef.current !== "overview") switchTab("overview");
    run(
      "ask",
      "正在回答问题...",
      (onDelta, onFallback) =>
        send<ProjectOverview>({
          type: "answer-question",
          repo,
          question: trimmed,
          context: askContext.basis ? askContext.text : undefined,
          contextBasis: askContext.basis
        }, onDelta, onFallback),
      (answer, elapsedMs) => {
        setAnswers((items) => [...items, { question: trimmed, answer, elapsedMs, timing: answer.timing }]);
        setQuestion("");
        requestAnalysisSuggestions("overview", answerSuggestionRequest(trimmed, answer));
      },
      { question: trimmed }
    );
  }

  function requestAnalysisSuggestions(target: SuggestionTarget, request: AnalysisSuggestionRequest) {
    if (!repo) return;

    const fallback = fallbackSuggestionQuestions(request);
    setAnalysisSuggestions((current) => ({
      ...current,
      [target]: {
        questions: fallback,
        loading: true,
        status: "正在生成继续追问...",
        request
      }
    }));

    send<SuggestedQuestionsResult>({
      type: "generate-suggestions",
      repo,
      ...request
    })
      .then((result) => {
        const questions = normalizeSuggestionQuestions(result.questions, fallback);
        setAnalysisSuggestions((current) => {
          if (current[target].request !== request) return current;
          return {
            ...current,
            [target]: {
              questions,
              loading: false,
              status: "",
              request
            }
          };
        });
      })
      .catch(() => {
        setAnalysisSuggestions((current) => {
          if (current[target].request !== request) return current;
          return {
            ...current,
            [target]: {
              questions: fallback,
              loading: false,
              status: "继续追问生成失败，已显示保守兜底。",
              request
            }
          };
        });
      });
  }

  async function clearCache(scope: "repo" | "all") {
    setSettingsStatus(scope === "repo" ? "正在清空当前仓库缓存..." : "正在清空全部缓存...");
    setError("");
    try {
      const result = await send<CacheClearResult>({ type: "clear-cache", scope, repo: scope === "repo" ? repo || undefined : undefined });
      setLastCacheClearResult(result);
      setSettingsStatus(`缓存已清空：内存缓存已重置，持久化缓存删除 ${result.persistentKeysCleared} 项。`);
      await refreshCacheStats();
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function deleteCacheEntry(key: string) {
    setSettingsStatus("正在删除单条缓存...");
    setError("");
    try {
      const result = await send<CacheDeleteResult>({ type: "delete-cache-entry", key });
      setSettingsStatus(`缓存项已删除：持久化缓存删除 ${result.persistentKeysCleared} 项。`);
      await refreshCacheStats();
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function deleteCacheRepo(repoKey: string) {
    setSettingsStatus(`正在删除 ${repoKey} 的缓存...`);
    setError("");
    try {
      const result = await send<CacheDeleteResult>({ type: "delete-cache-repo", repoKey });
      setSettingsStatus(`项目缓存已删除：${repoKey}，持久化缓存删除 ${result.persistentKeysCleared} 项。`);
      setExpandedCacheRepos((items) => ({ ...items, [repoKey]: false }));
      await refreshCacheStats();
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function copyMarkdown(text: string) {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("已复制 Markdown。");
    } catch {
      setCopyStatus("复制失败，请手动选中内容复制。");
    }
  }

  function downloadMarkdown(blueprint: SkillBlueprint) {
    const filename = buildMarkdownFilename(repo, blueprint);
    const blob = new Blob([blueprint.summary], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setCopyStatus(`已下载 ${filename}`);
  }

  function updateCollapsed(next: boolean) {
    setCollapsed(next);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "true" : "false");
  }

  if (collapsed) {
    return (
      <button className="cp-fab" onClick={() => updateCollapsed(false)} title="Open CodePath">
        <ChevronRight size={18} />
        CodePath
      </button>
    );
  }

  return (
    <aside className="cp-panel" style={{ width }}>
      <ResizeHandle width={width} onChange={setWidth} />
      <header className="cp-header">
        <div>
          <strong>CodePath</strong>
          <span>{title}</span>
        </div>
        <button className="cp-icon-btn" onClick={() => updateCollapsed(true)} title="Collapse">
          <X size={16} />
        </button>
      </header>

      <nav className="cp-tabs">
        <TabButton active={tab === "overview"} icon={<Map size={15} />} onClick={() => switchTab("overview")} label="项目概览" />
        <TabButton active={tab === "feature"} icon={<Route size={15} />} onClick={() => switchTab("feature")} label="功能路径" />
        <TabButton active={tab === "file"} icon={<FileCode2 size={15} />} onClick={() => switchTab("file")} label="当前文件" />
        <TabButton active={tab === "skill"} icon={<Layers3 size={15} />} onClick={() => switchTab("skill")} label="借鉴 / Skill" />
        <TabButton active={tab === "settings"} icon={<KeyRound size={15} />} onClick={() => switchTab("settings")} label="设置" />
      </nav>

      {error && <div className="cp-alert">{error}</div>}
      {loading && <div className="cp-loading">{formatLoadingStatus(loading, loadingStartedAt, now)}</div>}

      <main className="cp-content" ref={contentRef} onScroll={handleContentScroll}>
        {tab === "overview" && (
          <section className="cp-section">
            <p>分析项目用途、技术栈、目录职责、入口文件和推荐阅读路线。</p>
            <div className="cp-mode-group" role="group" aria-label="分析模式">
              <button
                type="button"
                className={projectAnalysisMode === "focused" ? "cp-mode active" : "cp-mode"}
                title={PROJECT_ANALYSIS_MODE_HELP.focused}
                aria-label={`根据当前分析情况：${PROJECT_ANALYSIS_MODE_HELP.focused}`}
                onClick={() => setProjectAnalysisMode("focused")}
              >
                根据当前分析情况
              </button>
              <button
                type="button"
                className={projectAnalysisMode === "full-source" ? "cp-mode active" : "cp-mode"}
                title={PROJECT_ANALYSIS_MODE_HELP["full-source"]}
                aria-label={`全部源码分析：${PROJECT_ANALYSIS_MODE_HELP["full-source"]}`}
                onClick={() => setProjectAnalysisMode("full-source")}
              >
                全部源码分析
              </button>
            </div>
            <p className="cp-muted">{PROJECT_ANALYSIS_MODE_HINT[projectAnalysisMode]}</p>
            <button
              className="cp-primary"
              disabled={!repo || !!loading}
              onClick={() =>
                repo &&
                run(
                  "overview",
                  projectAnalysisMode === "full-source" ? "正在进行全部源码分析..." : "正在分析项目...",
                  (onDelta, onFallback) =>
                    send<ProjectOverview>(
                      { type: "analyze-project", repo, mode: projectAnalysisMode },
                      onDelta,
                      onFallback
                    ),
                  (result) => {
                    setOverview(result);
                    requestAnalysisSuggestions("overview", overviewSuggestionRequest(result));
                  }
                )
              }
            >
              <BookOpen size={16} />
              分析代码
            </button>
            {activeStream?.target === "overview" && <StreamPreview repo={repo} stream={activeStream} />}
            {overview && (
              <>
                <MarkdownBlock repo={repo} branch={overview.branch} text={overview.summary} sources={overview.sources.map((item) => item.path)} timing={overview.timing} />
                <SuggestionList
                  suggestions={analysisSuggestions.overview.questions}
                  loading={!!loading || analysisSuggestions.overview.loading}
                  status={analysisSuggestions.overview.status}
                  onAsk={ask}
                  onDraft={setQuestion}
                  onRefresh={() => requestAnalysisSuggestions("overview", overviewSuggestionRequest(overview))}
                />
              </>
            )}
            {(answers.length > 0 || activeStream?.target === "ask") && (
              <OverviewConversation
                repo={repo}
                answers={answers}
                activeStream={activeStream}
              />
            )}
          </section>
        )}

        {tab === "feature" && (
          <section className="cp-section">
            <p>输入你想理解的功能，例如训练流程、推理流程、评估流程、登录、上传、搜索或权限。CodePath 会找相关文件并串成实现路径。</p>
            <input className="cp-input" value={feature} onChange={(event) => setFeature(event.target.value)} placeholder="例如：训练流程" />
            <button
              className="cp-primary"
              disabled={!repo || !feature.trim() || !!loading}
              onClick={() =>
                repo &&
                run(
                  "feature",
                  "正在分析功能路径...",
                  (onDelta, onFallback) => send<FeaturePath>({ type: "analyze-feature", repo, feature }, onDelta, onFallback),
                  (result) => {
                    setFeaturePath(result);
                    requestAnalysisSuggestions("feature", featureSuggestionRequest(result));
                  }
                )
              }
            >
              <Route size={16} />
              分析功能路径
            </button>
            {activeStream?.target === "feature" && <StreamPreview repo={repo} stream={activeStream} />}
            {featurePath && (
              <>
                <MarkdownBlock repo={repo} branch={featurePath.branch} text={featurePath.summary} sources={featurePath.sources.map((item) => item.path)} timing={featurePath.timing} />
                <SuggestionList
                  suggestions={analysisSuggestions.feature.questions}
                  loading={!!loading || analysisSuggestions.feature.loading}
                  status={analysisSuggestions.feature.status}
                  onAsk={ask}
                  onDraft={setQuestion}
                  onRefresh={() => requestAnalysisSuggestions("feature", featureSuggestionRequest(featurePath))}
                />
              </>
            )}
          </section>
        )}

        {tab === "file" && (
          <section className="cp-section">
            <p>解释当前 GitHub 文件：它负责什么、主要结构、依赖关系，以及修改风险。</p>
            {repo?.path && <div className="cp-path">{repo.path}</div>}
            <button
              className="cp-primary"
              disabled={!repo || repo.pageType !== "file" || !!loading}
              onClick={() =>
                repo &&
                run(
                  "file",
                  "正在解释当前文件...",
                  (onDelta, onFallback) => send<FileExplanation>({ type: "explain-file", repo }, onDelta, onFallback),
                  (result) => {
                    setFileExplanation(result);
                    requestAnalysisSuggestions("file", fileSuggestionRequest(result));
                  }
                )
              }
            >
              <FileCode2 size={16} />
              解释当前文件
            </button>
            {activeStream?.target === "file" && <StreamPreview repo={repo} stream={activeStream} />}
            {fileExplanation && (
              <>
                <MarkdownBlock repo={repo} branch={fileExplanation.branch} text={fileExplanation.summary} sources={fileExplanation.sources.map((item) => item.path)} timing={fileExplanation.timing} />
                <SuggestionList
                  suggestions={analysisSuggestions.file.questions}
                  loading={!!loading || analysisSuggestions.file.loading}
                  status={analysisSuggestions.file.status}
                  onAsk={ask}
                  onDraft={setQuestion}
                  onRefresh={() => requestAnalysisSuggestions("file", fileSuggestionRequest(fileExplanation))}
                />
              </>
            )}
          </section>
        )}

        {tab === "skill" && (
          <section className="cp-section">
            <p>把某个功能提炼成 OpenClaw Skill、新项目蓝图，或给人读的技术分析。第一版先提供 Markdown 复制，方便交给 agent 继续执行。</p>
            <input
              className="cp-input"
              value={blueprintFeature}
              onChange={(event) => setBlueprintFeature(event.target.value)}
              placeholder="例如：训练流程、插件系统、缓存机制"
            />
            <label className="cp-label">
              输出用途
              <select className="cp-input" value={blueprintMode} onChange={(event) => setBlueprintMode(event.target.value as BlueprintMode)}>
                <option value="openclaw-skill">OpenClaw Skill</option>
                <option value="new-project">新项目蓝图</option>
                <option value="human">给人读的技术分析</option>
              </select>
            </label>
            <button
              className="cp-primary"
              disabled={!repo || !blueprintFeature.trim() || !!loading}
              onClick={() =>
                repo &&
                run(
                  "skill",
                  "正在生成借鉴材料...",
                  (onDelta, onFallback) => send<SkillBlueprint>({ type: "generate-skill-blueprint", repo, feature: blueprintFeature, mode: blueprintMode }, onDelta, onFallback),
                  (result) => {
                    setSkillBlueprint(result);
                    requestAnalysisSuggestions("skill", skillSuggestionRequest(result));
                  }
                )
              }
            >
              <Layers3 size={16} />
              生成 Skill / 蓝图
            </button>
            {activeStream?.target === "skill" && <StreamPreview repo={repo} stream={activeStream} />}
            {skillBlueprint && (
              <>
                <div className="cp-action-row">
                  <button className="cp-secondary" onClick={() => copyMarkdown(skillBlueprint.summary)}>
                    复制 Markdown
                  </button>
                  <button className="cp-secondary" onClick={() => downloadMarkdown(skillBlueprint)}>
                    <Download size={14} />
                    下载 Markdown
                  </button>
                  {copyStatus && <span className="cp-save-status">{copyStatus}</span>}
                </div>
                <MarkdownBlock
                  repo={repo}
                  branch={skillBlueprint.branch}
                  text={skillBlueprint.summary}
                  sources={skillBlueprint.sources.map((item) => item.path)}
                  timing={skillBlueprint.timing}
                />
                <SuggestionList
                  suggestions={analysisSuggestions.skill.questions}
                  loading={!!loading || analysisSuggestions.skill.loading}
                  status={analysisSuggestions.skill.status}
                  onAsk={ask}
                  onDraft={setQuestion}
                  onRefresh={() => requestAnalysisSuggestions("skill", skillSuggestionRequest(skillBlueprint))}
                />
              </>
            )}
          </section>
        )}

        {tab === "settings" && (
          <SettingsPanel
            settings={settings}
            status={settingsStatus}
            diagnostics={settingsDiagnostics}
            onChange={saveSettings}
            onRefreshSettings={refreshSettings}
            onTest={testSettings}
            onClearCache={clearCache}
            onRefreshCacheStats={refreshCacheStats}
            onDeleteCacheEntry={deleteCacheEntry}
            onDeleteCacheRepo={deleteCacheRepo}
            expandedCacheRepos={expandedCacheRepos}
            onToggleCacheRepo={(repoKey) => setExpandedCacheRepos((items) => ({ ...items, [repoKey]: !items[repoKey] }))}
            hasRepo={Boolean(repo)}
            cacheStats={cacheStats}
            lastCacheClearResult={lastCacheClearResult}
          />
        )}
      </main>

      {tab === "overview" && overview && <GlobalAskInput question={question} loading={!!loading} disabled={!repo} onChange={setQuestion} onAsk={() => ask()} />}
    </aside>
  );
}

function ResizeHandle(props: { width: number; onChange: (width: number) => void }) {
  function applyWidth(nextWidth: number) {
    const clamped = clamp(nextWidth, 340, Math.min(860, window.innerWidth - 32));
    props.onChange(clamped);
    window.localStorage.setItem("codepath.panelWidth", String(clamped));
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = props.width;

    function onMove(moveEvent: PointerEvent) {
      applyWidth(startWidth + (startX - moveEvent.clientX));
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      className="cp-resize-handle"
      onPointerDown={startResize}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") applyWidth(props.width + 24);
        if (event.key === "ArrowRight") applyWidth(props.width - 24);
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 CodePath 面板宽度"
      tabIndex={0}
      title="Drag to resize"
    />
  );
}

function readSidebarCollapsed(): boolean {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function TabButton(props: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? "cp-tab active" : "cp-tab"} onClick={props.onClick} title={props.label} aria-label={props.label} aria-current={props.active ? "page" : undefined}>
      {props.icon}
    </button>
  );
}

function GlobalAskInput(props: { question: string; loading: boolean; disabled: boolean; onChange: (value: string) => void; onAsk: () => void }) {
  return (
    <footer className="cp-global-ask">
      <textarea
        className="cp-textarea cp-global-textarea"
        value={props.question}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            props.onAsk();
          }
        }}
        placeholder="继续追问这个项目，例如：训练入口在哪里？"
        rows={2}
      />
      <button className="cp-send-btn" disabled={props.disabled || props.loading || !props.question.trim()} onClick={props.onAsk} title="发送问题">
        <Send size={16} />
      </button>
    </footer>
  );
}

function OverviewConversation(props: {
  repo: RepoRef | null;
  answers: ChatTurn[];
  activeStream: ActiveStream | null;
}) {
  const activeAskStream = props.activeStream?.target === "ask" ? props.activeStream : null;
  return (
    <div className="cp-overview-conversation">
      <h3 className="cp-section-title">问答记录</h3>
      <div className="cp-chat-list">
        {props.answers.map((item, index) => (
          <article className="cp-chat-item" key={`${item.question}-${index}`}>
            <strong>问：{item.question}</strong>
            {item.elapsedMs !== undefined && <div className="cp-chat-meta">回答耗时：{formatElapsed(item.elapsedMs)}</div>}
            <MarkdownBlock repo={props.repo} branch={item.answer.branch} text={item.answer.summary} sources={item.answer.sources.map((source) => source.path)} timing={item.timing} />
          </article>
        ))}
        {activeAskStream && (
          <article className="cp-chat-item cp-chat-item-streaming">
            <strong>问：{activeAskStream.question || "正在回答的问题"}</strong>
            <StreamPreview repo={props.repo} stream={activeAskStream} />
          </article>
        )}
      </div>
    </div>
  );
}

function SettingsPanel(props: {
  settings: Settings;
  status: string;
  diagnostics: SettingsDiagnostics | null;
  cacheStats: CacheStats | null;
  lastCacheClearResult: CacheClearResult | null;
  onChange: (settings: Settings) => void;
  onRefreshSettings: (status?: string) => Promise<void>;
  onTest: () => void;
  onClearCache: (scope: "repo" | "all") => void;
  onRefreshCacheStats: () => void;
  onDeleteCacheEntry: (key: string) => void;
  onDeleteCacheRepo: (repoKey: string) => void;
  expandedCacheRepos: Record<string, boolean>;
  onToggleCacheRepo: (repoKey: string) => void;
  hasRepo: boolean;
}) {
  const [draft, setDraft] = useState(() => settingsDraftWithoutSecrets(props.settings));
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelListStatus, setModelListStatus] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const provider = resolveProvider({ provider: draft.provider, baseUrl: draft.baseUrl || DEFAULT_SETTINGS.baseUrl });
  const baseUrlPlaceholder = provider === "anthropic" ? "https://api.deepseek.com/anthropic" : DEFAULT_SETTINGS.baseUrl;
  const modelPlaceholder = DEFAULT_SETTINGS.model;

  useEffect(() => {
    setDraft(settingsDraftWithoutSecrets(props.settings));
    setModelOptions(props.settings.model ? [{ id: props.settings.model }] : []);
    setModelListStatus("");
  }, [props.settings]);

  async function fetchAvailableModels() {
    const normalized = buildSettingsForSave(draft, props.settings);
    if (!normalized.apiKey || !normalized.baseUrl) {
      setModelListStatus("请先通过安全窗口保存 API Key，并填写 Base URL。");
      return;
    }

    setFetchingModels(true);
    setModelListStatus("正在获取模型列表...");
    try {
      const result = await send<ModelListResult>({ type: "list-models", settings: normalized });
      setModelOptions(result.models);
      setDraft(settingsDraftWithoutSecrets({ ...normalized, baseUrl: result.baseUrl, model: result.selectedModel || normalized.model }));
      setModelListStatus(result.message || `已获取 ${result.models.length} 个模型。`);
    } catch (error) {
      setModelOptions([]);
      setDraft(settingsDraftWithoutSecrets(normalized));
      setModelListStatus(`模型列表获取失败：${humanizeError(error)}。可以手动填写模型名称后保存。`);
    } finally {
      setFetchingModels(false);
    }
  }

  function openSecretEditor(field: "apiKey" | "githubToken") {
    const url = chrome.runtime.getURL(`secret-input.html?field=${encodeURIComponent(field)}`);
    window.open(url, "codepath-secret-input", "width=480,height=360,popup=yes");
    setModelListStatus(field === "apiKey" ? "请在扩展安全窗口中更新模型 API Key。" : "请在扩展安全窗口中更新 GitHub Token。");
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void props.onRefreshSettings();
      if (attempts >= 30) window.clearInterval(timer);
    }, 1000);
  }

  const selectedOptions =
    draft.model && !modelOptions.some((model) => model.id === draft.model) ? [{ id: draft.model }, ...modelOptions] : modelOptions;

  return (
    <section className="cp-section">
      <div className="cp-version-banner">CodePath 构建版本：{UI_VERSION}</div>
      <h3 className="cp-section-title">模型与访问设置</h3>
      <p className="cp-muted">接口格式会按 Base URL 自动识别：DeepSeek/OpenAI 兼容地址走 OpenAI 格式，Anthropic 地址走 Anthropic 格式。</p>
      <label className="cp-label">
        模型 API Key
        <div className="cp-secret-row">
          <span>{maskSecret(props.settings.apiKey)}</span>
          <button className="cp-secondary" onClick={() => openSecretEditor("apiKey")}>
            <KeyRound size={14} />
            更新
          </button>
        </div>
      </label>
      <label className="cp-label">
        Base URL
        <input
          className="cp-input"
          value={draft.baseUrl}
          onChange={(event) => {
            const baseUrl = event.target.value;
            setDraft({ ...draft, baseUrl, provider: inferProviderFromBaseUrl(baseUrl) });
          }}
          placeholder={baseUrlPlaceholder}
        />
      </label>
      <button className="cp-secondary" disabled={fetchingModels} onClick={fetchAvailableModels}>
        {fetchingModels ? "正在获取模型..." : "获取模型"}
      </button>
      {modelListStatus && <p className="cp-muted">{modelListStatus}</p>}
      {selectedOptions.length > 0 && (
        <label className="cp-label">
          可用模型
          <select className="cp-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {selectedOptions.map((model) => (
              <option value={model.id} key={model.id}>
                {model.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="cp-label">
        模型名称（可手动填写）
        <input className="cp-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={modelPlaceholder} />
      </label>
      <label className="cp-label">
        GitHub Token（可选）
        <div className="cp-secret-row">
          <span>{maskSecret(props.settings.githubToken || "")}</span>
          <button className="cp-secondary" onClick={() => openSecretEditor("githubToken")}>
            <KeyRound size={14} />
            更新
          </button>
        </div>
      </label>
      <button className="cp-primary" onClick={() => props.onChange(buildSettingsForSave(draft, props.settings))}>
        保存并校验设置
      </button>
      <button className="cp-secondary" onClick={props.onTest}>
        测试模型 / GitHub 连接
      </button>
      <div className="cp-action-row">
        <button className="cp-secondary" disabled={!props.hasRepo} onClick={() => props.onClearCache("repo")}>
          清空当前仓库缓存
        </button>
        <button className="cp-secondary" onClick={() => props.onClearCache("all")}>
          清空全部缓存
        </button>
      </div>
      {props.status && <p className="cp-save-status">{props.status}</p>}
      <CacheSummary
        stats={props.cacheStats}
        lastClearResult={props.lastCacheClearResult}
        hasRepo={props.hasRepo}
        expandedRepos={props.expandedCacheRepos}
        onRefresh={props.onRefreshCacheStats}
        onDeleteEntry={props.onDeleteCacheEntry}
        onDeleteRepo={props.onDeleteCacheRepo}
        onToggleRepo={props.onToggleCacheRepo}
      />
      <SettingsSummary diagnostics={props.diagnostics} draft={draft} settings={props.settings} />
    </section>
  );
}

function CacheSummary(props: {
  stats: CacheStats | null;
  lastClearResult: CacheClearResult | null;
  hasRepo: boolean;
  expandedRepos: Record<string, boolean>;
  onRefresh: () => void;
  onDeleteEntry: (key: string) => void;
  onDeleteRepo: (repoKey: string) => void;
  onToggleRepo: (repoKey: string) => void;
}) {
  const repositories = props.stats?.repositories ?? [];
  return (
    <div className="cp-settings-summary">
      <strong>缓存状态</strong>
      <dl>
        <div>
          <dt>当前仓库</dt>
          <dd>{props.hasRepo ? `${props.stats?.currentRepoPersistentKeys ?? 0} 项持久化缓存` : "未检测到仓库页面"}</dd>
        </div>
        <div>
          <dt>全部缓存</dt>
          <dd>{props.stats?.allPersistentKeys ?? 0} 项持久化缓存</dd>
        </div>
        <div>
          <dt>最近清理</dt>
          <dd>{props.lastClearResult ? `${props.lastClearResult.scope === "repo" ? "当前仓库" : "全部"}，删除 ${props.lastClearResult.persistentKeysCleared} 项` : "暂无清理记录"}</dd>
        </div>
      </dl>
      <div className="cp-cache-actions">
        <button className="cp-secondary" onClick={props.onRefresh}>
          刷新缓存状态
        </button>
      </div>
      <div className="cp-cache-manager">
        <strong>缓存项目列表</strong>
        {repositories.length === 0 ? (
          <p className="cp-muted">暂无 CodePath 持久化缓存。</p>
        ) : (
          repositories.map((repository) => {
            const expanded = Boolean(props.expandedRepos[repository.repoKey]);
            return (
              <article className="cp-cache-repo" key={repository.repoKey}>
                <div className="cp-cache-repo-head">
                  <button className="cp-cache-toggle" onClick={() => props.onToggleRepo(repository.repoKey)}>
                    {expanded ? "收起" : "展开"}
                  </button>
                  <span title={repository.repoKey}>{repository.repoKey}</span>
                  <small>{repository.count} 项</small>
                  <button className="cp-cache-danger" onClick={() => props.onDeleteRepo(repository.repoKey)}>
                    删除项目
                  </button>
                </div>
                {expanded && (
                  <div className="cp-cache-items">
                    {repository.items.map((item) => (
                      <div className="cp-cache-item" key={item.key}>
                        <span className={`cp-cache-kind ${item.kind}`}>{item.kind}</span>
                        <span title={item.key}>{item.label}</span>
                        <button className="cp-cache-danger" onClick={() => props.onDeleteEntry(item.key)}>
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function SettingsSummary(props: { diagnostics: SettingsDiagnostics | null; draft: Settings; settings: Settings }) {
  const diagnostics = props.diagnostics;
  return (
    <div className="cp-settings-summary">
      <strong>当前可见配置</strong>
      <dl>
        <div>
          <dt>接口格式</dt>
          <dd>{providerLabel(diagnostics?.provider || inferProviderFromBaseUrl(props.draft.baseUrl || DEFAULT_SETTINGS.baseUrl))}</dd>
        </div>
        <div>
          <dt>API Key</dt>
          <dd>{diagnostics?.apiKeyPreview || maskSecret(props.settings.apiKey)}</dd>
        </div>
        <div>
          <dt>Base URL</dt>
          <dd>{diagnostics?.baseUrl || props.draft.baseUrl}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{diagnostics?.model || props.draft.model}</dd>
        </div>
        <div>
          <dt>GitHub Token</dt>
          <dd>{diagnostics?.githubTokenPreview || maskSecret(props.settings.githubToken || "")}</dd>
        </div>
        {diagnostics?.repoCheck && (
          <div>
            <dt>GitHub 检查</dt>
            <dd>{diagnostics.repoCheck}</dd>
          </div>
        )}
        {diagnostics?.modelCheck && (
          <div>
            <dt>模型检查</dt>
            <dd>{diagnostics.modelCheck}</dd>
          </div>
        )}
        {(diagnostics?.streamingCheck || props.draft.supportsStreaming !== undefined) && (
          <div>
            <dt>流式输出</dt>
            <dd>{diagnostics?.streamingCheck || streamingModeLabel(props.draft.streamingMode, props.draft.supportsStreaming)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function providerLabel(provider: Settings["provider"]): string {
  return provider === "anthropic" ? "Anthropic 格式" : "OpenAI 格式";
}

function streamingModeLabel(mode: Settings["streamingMode"], supported?: boolean): string {
  if (mode === "realtime") return "已记录：实时流式输出。";
  if (mode === "buffered") return "已记录：支持 stream=true，但接口疑似缓冲。";
  if (mode === "unsupported") return "已记录：不支持流式输出，将使用普通一次性返回。";
  if (supported) return "已记录：支持流式输出。";
  return "流式输出未测试或不可用，将使用普通一次性返回。";
}

function SuggestionList(props: {
  suggestions: string[];
  loading: boolean;
  status?: string;
  onAsk: (question: string) => void;
  onDraft: (question: string) => void;
  onRefresh?: () => void;
}) {
  async function copySuggestion(suggestion: string) {
    try {
      await navigator.clipboard.writeText(suggestion);
    } catch {
      props.onDraft(suggestion);
    }
  }

  return (
    <div className="cp-suggestions">
      <div className="cp-suggestions-header">
        <strong>继续追问</strong>
        {props.onRefresh && (
          <button className="cp-mini-btn" disabled={props.loading} onClick={props.onRefresh} title="重新调用模型生成继续追问">
            <RefreshCw size={13} />
            {props.loading ? "生成中..." : "刷新继续追问"}
          </button>
        )}
      </div>
      {props.status && <div className="cp-suggestion-status">{props.status}</div>}
      <ol className="cp-suggestion-list">
        {props.suggestions.slice(0, 3).map((suggestion, index) => (
          <li key={`${suggestion}-${index}`} className="cp-suggestion-item">
            <div className="cp-suggestion-row">
              <button
                className="cp-suggestion"
                disabled={props.loading}
                onClick={() => {
                  props.onDraft(suggestion);
                  props.onAsk(suggestion);
                }}
                title="点击后直接发送这个问题"
              >
                {suggestion}
              </button>
              <button className="cp-copy-btn" onClick={() => copySuggestion(suggestion)} title="复制这个问题">
                <Clipboard size={14} />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MarkdownBlock(props: { repo: RepoRef | null; branch?: string; text: string; sources: string[]; timing?: TimingBreakdown }) {
  const sourceRef = props.timing?.headSha && !props.timing.headSha.startsWith("unchecked:") ? props.timing.headSha : props.branch;
  return (
    <div className="cp-result">
      {props.timing && <TimingMeta timing={props.timing} repo={props.repo} branch={props.branch} />}
      <div className="cp-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeLinkCodePaths(props.repo, sourceRef, props.sources)]}>
          {props.text}
        </ReactMarkdown>
      </div>
      {props.sources.length > 0 && (
        <div className="cp-sources">
          <strong>参考源码</strong>
          {props.sources.map((source) =>
            props.repo ? (
              <a key={source} href={githubFileUrl(props.repo, source, sourceRef)} target="_blank" rel="noreferrer">
                {source}
              </a>
            ) : (
              <span key={source}>{source}</span>
            )
          )}
        </div>
      )}
    </div>
  );
}

function StreamPreview(props: { repo: RepoRef | null; stream: ActiveStream }) {
  const status = streamStatusText(props.stream);
  return (
    <div className="cp-stream-preview">
      <div className="cp-chat-meta">{status}</div>
      {props.stream.fallbackReason && <div className="cp-stream-placeholder">流式失败后已回退普通返回：{props.stream.fallbackReason}</div>}
      {props.stream.text ? (
        <MarkdownBlock repo={props.repo} text={props.stream.text} sources={[]} />
      ) : (
        <div className="cp-stream-placeholder">模型准备好后会在这里显示回答。</div>
      )}
    </div>
  );
}

function streamStatusText(stream: ActiveStream): string {
  if (stream.fallbackReason) return "已回退普通一次性返回...";
  if (stream.receivedDelta) return stream.mode === "buffered" ? "接口可能缓冲，正在接收模型输出..." : "正在实时接收模型输出...";
  if (stream.expectsStreaming) {
    if (stream.mode === "buffered") return "接口支持 stream=true，但疑似缓冲；正在等待模型内容...";
    if (stream.mode === "realtime") return "实时流式已启用，等待模型首段内容...";
    return "流式输出已启用，等待模型首段内容...";
  }
  return "当前使用普通一次性返回...";
}

function TimingMeta(props: { timing: TimingBreakdown; repo: RepoRef | null; branch?: string }) {
  const parts = [
    props.repo ? `仓库 ${props.repo.owner}/${props.repo.repo}` : "",
    props.branch ? `分支 ${props.branch}` : "",
    props.timing.resultCacheHit ? "结果缓存命中" : "实时分析",
    props.timing.sourceCacheHit ? "源码缓存命中" : "",
    props.timing.sourceIncomplete ? `源码片段不完整${props.timing.skippedSourcePaths?.length ? ` ${props.timing.skippedSourcePaths.length} 个文件` : ""}` : "",
    props.timing.persistentCacheHit ? "持久化缓存" : "",
    cacheStatusLabel(props.timing),
    props.timing.headSha ? `基于 ${shortRef(props.timing.headSha)}` : "",
    props.timing.capturedAt ? `生成 ${formatMetaTime(props.timing.capturedAt)}` : "",
    props.timing.lastValidatedAt ? `校验 ${formatMetaTime(props.timing.lastValidatedAt)}` : "",
    props.timing.totalMs !== undefined ? `总耗时 ${formatElapsedCompact(props.timing.totalMs)}` : "",
    props.timing.modelMs !== undefined ? `模型 ${formatElapsedCompact(props.timing.modelMs)}` : "",
    props.timing.githubMs !== undefined ? `GitHub ${formatElapsedCompact((props.timing.githubMs ?? 0) + (props.timing.treeMs ?? 0))}` : "",
    props.timing.fileMs !== undefined ? `文件 ${formatElapsedCompact(props.timing.fileMs)}` : ""
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="cp-chat-meta">{parts.join(" · ")}</div>;
}

function cacheStatusLabel(timing: TimingBreakdown): string {
  if (timing.cacheStatus === "same-tree-new-head") return "提交已更新，源码树未变";
  if (timing.cacheStatus === "stale") return "缓存已过期";
  if (timing.cacheStatus === "unchecked") return "缓存未校验";
  if (timing.cacheStatus === "fresh") return "源码快照一致";
  return "";
}

function shortRef(value: string): string {
  if (value.startsWith("unchecked:")) return "unchecked";
  return value.slice(0, 7);
}

function formatMetaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createSuggestionStates(): Record<SuggestionTarget, SuggestionPanelState> {
  return {
    overview: emptySuggestionState(),
    feature: emptySuggestionState(),
    file: emptySuggestionState(),
    skill: emptySuggestionState()
  };
}

function emptySuggestionState(): SuggestionPanelState {
  return { questions: [], loading: false, status: "" };
}

function createTabScrollPositions(): Record<Tab, TabScrollPosition> {
  return {
    overview: emptyTabScrollPosition(),
    feature: emptyTabScrollPosition(),
    file: emptyTabScrollPosition(),
    skill: emptyTabScrollPosition(),
    settings: emptyTabScrollPosition()
  };
}

function emptyTabScrollPosition(): TabScrollPosition {
  return { scrollTop: 0, bottomOffset: 0, nearBottom: false, hasValue: false };
}

function overviewSuggestionRequest(overview: ProjectOverview): AnalysisSuggestionRequest {
  return {
    kind: "overview",
    summary: overview.summary,
    sources: overview.sources.map((source) => source.path)
  };
}

function answerSuggestionRequest(question: string, answer: ProjectOverview): AnalysisSuggestionRequest {
  return {
    kind: "answer",
    label: question,
    summary: `用户问题：${question}\n\n本次回答：\n${answer.summary}`,
    sources: answer.sources.map((source) => source.path)
  };
}

function featureSuggestionRequest(featurePath: FeaturePath): AnalysisSuggestionRequest {
  return {
    kind: "feature",
    label: featurePath.feature,
    summary: featurePath.summary,
    sources: featurePath.sources.map((source) => source.path)
  };
}

function fileSuggestionRequest(fileExplanation: FileExplanation): AnalysisSuggestionRequest {
  return {
    kind: "file",
    label: fileExplanation.path,
    summary: fileExplanation.summary,
    sources: uniqueTextValues([fileExplanation.path, ...fileExplanation.sources.map((source) => source.path)])
  };
}

function skillSuggestionRequest(skillBlueprint: SkillBlueprint): AnalysisSuggestionRequest {
  return {
    kind: "skill",
    label: skillBlueprint.feature,
    summary: skillBlueprint.summary,
    sources: skillBlueprint.sources.map((source) => source.path)
  };
}

function fallbackSuggestionQuestions(request: AnalysisSuggestionRequest): string[] {
  const label = request.label?.trim();
  if (request.kind === "feature" && label) {
    const shortLabel = shortSuggestionLabel(label);
    return [
      `「${shortLabel}」入口在哪？`,
      "先读哪些相关文件？",
      "修改风险是什么？"
    ];
  }

  if (request.kind === "file" && label) {
    return [
      "这个文件负责什么？",
      "它依赖哪些模块？",
      "修改它风险在哪？"
    ];
  }

  if (request.kind === "skill") {
    return [
      "哪些设计可复用？",
      "哪里需要谨慎改？",
      "下一步验证什么？"
    ];
  }

  if (request.kind === "answer") {
    return [
      "还要读哪些文件？",
      "这个结论怎么验证？",
      "修改风险在哪里？"
    ];
  }

  return [
    "先读哪些入口？",
    "主流程怎么串？",
    "二次开发改哪里？"
  ];
}

function normalizeSuggestionQuestions(values: string[], fallback: string[]): string[] {
  const normalized = values.map((value) => ensureQuestionMark(trimSuggestionText(value))).filter((value) => value.length >= 4);
  return uniqueTextValues([...normalized, ...fallback]).slice(0, 3);
}

function ensureQuestionMark(value: string): string {
  if (!value) return "";
  if (/[?？]$/.test(value)) return value;
  return `${value.replace(/[。.!！,，;；:：]+$/g, "")}？`;
}

function trimSuggestionText(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  const questionEnd = cleaned.search(/[?？]/);
  if (questionEnd >= 0) return cleaned.slice(0, questionEnd + 1);
  return cleaned.split(/[。.!！；;]/)[0]?.trim() ?? cleaned;
}

function shortSuggestionLabel(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}...`;
}

function uniqueTextValues(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function buildMarkdownFilename(repo: RepoRef | null, blueprint: SkillBlueprint): string {
  const owner = sanitizeFilenamePart(repo?.owner || "github");
  const repoName = sanitizeFilenamePart(repo?.repo || "repo");
  const feature = sanitizeFilenamePart(blueprint.feature || "feature");
  const mode = sanitizeFilenamePart(blueprint.mode);
  return `${owner}-${repoName}-${feature}-${mode}.md`;
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || "untitled";
}

function readPanelWidth(): number {
  const stored = Number(window.localStorage.getItem("codepath.panelWidth"));
  if (Number.isFinite(stored) && stored >= 340) return stored;
  return 460;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatLoadingStatus(label: string, startedAt: number | null, now: number): string {
  if (!startedAt) return label;
  return `${label} 已用时 ${formatElapsed(now - startedAt)}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒`;
}

function formatElapsedCompact(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

async function send<T>(request: RuntimeRequest, onStreamDelta?: (text: string) => void, onStreamFallback?: (reason: string) => void): Promise<T> {
  if (!validateRequestLocation(request, location.href)) {
    throw new Error("GitHub 页面已导航，请在当前页面重新发起分析。");
  }
  const response = await sendBestEffort<T>(request, onStreamDelta, onStreamFallback);
  if (!response.ok) throw new Error(response.error || "Request failed.");
  return response.data as T;
}

async function sendBestEffort<T>(request: RuntimeRequest, onStreamDelta?: (text: string) => void, onStreamFallback?: (reason: string) => void): Promise<RuntimeResponse<T>> {
  const storageResponse = await sendSettingsViaStorage<T>(request).catch(() => undefined);
  if (storageResponse?.ok) return storageResponse;

  const portError: { message?: string; dispatched: boolean } = { dispatched: true };
  const portResponse = await sendViaPort<T>(request, onStreamDelta, onStreamFallback).catch((error) => {
    portError.message = error instanceof Error ? error.message : String(error);
    portError.dispatched = error instanceof PortRequestError ? error.dispatched : true;
    return undefined;
  });
  if (portResponse) return portResponse;

  if (canFallbackLocallyBeforeDispatch(request, portError.dispatched)) return handleLocally<T>(request);
  return fail<T>(backgroundUnavailableMessage(portError.message || "No background response."));
}

async function sendSettingsViaStorage<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  if (request.type === "get-settings") {
    return localOk((await getExtensionSettings()) as T);
  }

  if (request.type === "save-settings") {
    const settings = normalizeSettingsDraft(request.settings);
    await setExtensionSettings(settings);
    return localOk(settings as T);
  }

  return { ok: false, error: "Not a settings request." };
}

async function handleLocally<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  try {
    if (request.type === "list-models") {
      const settings = normalizeSettingsDraft(request.settings);
      const models = await listModels(settings);
      const selectedModel = settings.model && models.some((model) => model.id === settings.model) ? settings.model : models[0]?.id ?? "";
      return localOk({
        baseUrl: settings.baseUrl,
        models,
        selectedModel,
        message: models.length > 0 ? `已获取 ${models.length} 个模型。` : "模型列表为空，请手动填写模型名称。"
      } as T);
    }

    return { ok: false, error: "Extension storage or background is unavailable." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getExtensionSettings(): Promise<Settings> {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      reject(new Error("Extension storage is unavailable."));
      return;
    }

    chrome.storage.local.get(SETTINGS_KEY, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      const value = items[SETTINGS_KEY];
      const patch = value && typeof value === "object" ? (value as Partial<Settings>) : {};
      resolve(normalizeSettingsDraft({ ...DEFAULT_SETTINGS, ...patch }));
    });
  });
}

function setExtensionSettings(settings: Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      reject(new Error("Extension storage is unavailable."));
      return;
    }

    chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettingsDraft(settings) }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeSettingsDraft(settings: Settings): Settings {
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

function settingsDraftWithoutSecrets(settings: Settings): Settings {
  return {
    ...normalizeSettingsDraft(settings),
    apiKey: "",
    githubToken: ""
  };
}

function buildSettingsForSave(draft: Settings, existing: Settings): Settings {
  return normalizeSettingsDraft({
    ...draft,
    apiKey: existing.apiKey,
    githubToken: existing.githubToken || ""
  });
}

function localOk<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data };
}

function fail<T>(error: string): RuntimeResponse<T> {
  return { ok: false, error };
}

function maskSecret(value: string): string {
  if (!value) return "Not set";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function buildAskContext(
  overview: ProjectOverview | null,
  featurePath: FeaturePath | null,
  fileExplanation: FileExplanation | null,
  answers: ChatTurn[]
): { text: string; basis?: AnalysisBasis } {
  const entries: Array<{ text: string; basis?: AnalysisBasis }> = [];
  if (overview) entries.push({ text: `Project overview:\n${overview.summary}`, basis: overview.basis });
  if (featurePath) entries.push({ text: `Feature analysis (${featurePath.feature}):\n${featurePath.summary}`, basis: featurePath.basis });
  if (fileExplanation) entries.push({ text: `File explanation (${fileExplanation.path}):\n${fileExplanation.summary}`, basis: fileExplanation.basis });
  entries.push(
    ...answers.slice(-3).map((item) => ({
      text: `Previous question: ${item.question}\nAnswer: ${item.answer.summary}`,
      basis: item.answer.basis
    }))
  );
  const bases = entries.map((entry) => entry.basis).filter((basis): basis is AnalysisBasis => Boolean(basis));
  return {
    text: entries.map((entry) => entry.text).join("\n\n---\n\n"),
    basis: sharedAskContextBasis(bases, entries.length)
  };
}

function sharedAskContextBasis(bases: AnalysisBasis[], expectedCount: number): AnalysisBasis | undefined {
  if (bases.length !== expectedCount || bases.length === 0) return undefined;
  const first = bases[0];
  if (!first) return undefined;
  return bases.every(
    (basis) =>
      basis.snapshot.owner === first.snapshot.owner &&
      basis.snapshot.repo === first.snapshot.repo &&
      basis.snapshot.refName === first.snapshot.refName &&
      basis.snapshot.treeSha === first.snapshot.treeSha &&
      basis.promptVersion === first.promptVersion &&
      basis.analyzerVersion === first.analyzerVersion
  )
    ? first
    : undefined;
}

class PortRequestError extends Error {
  constructor(
    message: string,
    readonly dispatched: boolean
  ) {
    super(message);
    this.name = "PortRequestError";
  }
}

function sendViaPort<T>(request: RuntimeRequest, onStreamDelta?: (text: string) => void, onStreamFallback?: (reason: string) => void): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let port: ReturnType<typeof chrome.runtime.connect>;
    try {
      port = chrome.runtime.connect({ name: "codepath" });
    } catch (error) {
      reject(new PortRequestError(error instanceof Error ? error.message : String(error), false));
      return;
    }
    let settled = false;
    let dispatched = false;
    let timeout: number;
    const resetTimeout = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        settle(() => reject(new PortRequestError("Background response timed out.", dispatched)));
      }, 30_000);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        port.disconnect();
      } catch {
        // Port may already be disconnected.
      }
      action();
    };
    resetTimeout();

    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Exclude<PortMessage, { request: RuntimeRequest }>;
      if (envelope.id !== id) return;
      resetTimeout();
      if ("event" in envelope) {
        if (envelope.event === "heartbeat") return;
        if (envelope.event === "stream-delta" && envelope.text) onStreamDelta?.(envelope.text);
        if (envelope.event === "stream-fallback") onStreamFallback?.(envelope.text || "未知原因");
        if (envelope.event === "stream-error") settle(() => reject(new PortRequestError(envelope.error || "Streaming failed.", dispatched)));
        return;
      }
      settle(() => resolve(envelope.response as RuntimeResponse<T>));
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (!settled) settle(() => reject(new PortRequestError(error?.message || "Background port disconnected.", dispatched)));
    });

    try {
      port.postMessage({ id, request } satisfies PortMessage);
      dispatched = true;
    } catch (error) {
      settle(() => reject(new PortRequestError(error instanceof Error ? error.message : String(error), false)));
    }
  });
}

function backgroundUnavailableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `扩展后台不可用。请在 edge://extensions 重新加载 CodePath Dev，然后刷新 GitHub 页面。详情：${message}`;
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("扩展后台不可用")) {
    return message;
  }
  if (message.includes("API rate limit")) {
    return "GitHub API 已触发限流。请在设置里填写 GitHub Token 后再试。";
  }
  if (message.includes("GitHub API 404")) {
    return "GitHub 仓库未找到或没有访问权限。私有仓库请在设置里填写有 Contents 读取权限的 GitHub Token。";
  }
  if (message.includes("模型接口 401") || message.includes("模型接口 403")) {
    return "模型 API Key、Base URL 或模型权限被拒绝。请在设置里检查模型配置。";
  }
  if (message.includes("模型接口 404")) {
    return "模型接口返回 404。请检查 Base URL、接口格式和模型名称是否匹配；OpenAI 格式使用 /chat/completions，Anthropic 格式使用 /messages。";
  }
  if (message.includes("401") || message.includes("Unauthorized")) {
    return "API Key 或 GitHub Token 被拒绝。请检查设置后再试。";
  }
  if (message.includes("Unable to reach model base URL")) {
    return "无法连接模型 Base URL。请检查网络、Base URL 和本机代理设置。";
  }
  if (message.includes("Unable to reach model list URL")) {
    return "无法连接模型列表地址。请检查网络、Base URL 和本机代理设置。";
  }
  if (message.includes("Failed to fetch")) {
    return "网络请求失败。请检查仓库地址、Token 或模型 Base URL。";
  }
  return message;
}

function formatRunError(label: string, repo: RepoRef | null, elapsedMs: number, error: unknown): string {
  const action = label.replace(/^正在/, "").replace(/\.\.\.$/, "");
  const repoText = repo ? `${repo.owner}/${repo.repo}${repo.branch ? `@${repo.branch}` : ""}` : "未识别仓库";
  return `${action}失败。仓库：${repoText}。已用时：${formatElapsed(elapsedMs)}。${humanizeError(error)}`;
}
