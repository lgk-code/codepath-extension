import React, { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, Clipboard, FileCode2, KeyRound, Map, MessageSquare, Route, Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  FeaturePath,
  FileExplanation,
  PortMessage,
  ProjectOverview,
  RepoRef,
  RuntimeRequest,
  RuntimeResponse,
  Settings,
  SettingsDiagnostics
} from "../types";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../lib/defaults";
import { parseGithubUrl } from "../lib/githubUrl";
import { analyzeFeature, analyzeProject, answerQuestion, explainFile } from "../lib/analyzer";
import { githubFileUrl, rehypeLinkCodePaths } from "../lib/linkPaths";

type Tab = "overview" | "feature" | "file" | "ask" | "settings";

type ChatTurn = {
  question: string;
  answer: ProjectOverview;
  elapsedMs?: number;
};

const DEFAULT_QUESTIONS = [
  "我第一次看这个项目，应该先读哪些文件？",
  "用大白话按步骤解释这个项目的主流程。",
  "如果我要二次开发，最重要的文件有哪些？"
];

const UI_VERSION = "dev-2026-05-09-qa-timing";

export function Sidebar() {
  const [repo, setRepo] = useState<RepoRef | null>(() => parseGithubUrl(location.href));
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(() => readPanelWidth());
  const [tab, setTab] = useState<Tab>("overview");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState("");
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [feature, setFeature] = useState("");
  const [featurePath, setFeaturePath] = useState<FeaturePath | null>(null);
  const [fileExplanation, setFileExplanation] = useState<FileExplanation | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<ChatTurn[]>([]);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsDiagnostics, setSettingsDiagnostics] = useState<SettingsDiagnostics | null>(null);

  useEffect(() => {
    send<Settings>({ type: "get-settings" }).then(setSettings).catch((err) => setError(err.message));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<RepoRef>).detail;
      setRepo(detail);
      if (detail.pageType === "file") setTab("file");
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

  const title = useMemo(() => (repo ? `${repo.owner}/${repo.repo}` : "No GitHub repository detected"), [repo]);

  async function run<T>(label: string, action: () => Promise<T>, onDone: (value: T, elapsedMs: number) => void) {
    const startedAt = Date.now();
    setLoading(label);
    setLoadingStartedAt(startedAt);
    setNow(startedAt);
    setError("");
    try {
      const value = await action();
      onDone(value, Date.now() - startedAt);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading("");
      setLoadingStartedAt(null);
    }
  }

  async function saveSettings(next: Settings) {
    setSettings(next);
      setSettingsStatus("正在保存设置...");
    setError("");
    try {
      const saved = await send<Settings>({ type: "save-settings", settings: next });
      const verified = await send<Settings>({ type: "get-settings" });
      setSettings({ ...saved, ...verified });
      setSettingsDiagnostics({
        provider: verified.provider,
        apiKeyPreview: maskSecret(verified.apiKey),
        hasApiKey: Boolean(verified.apiKey),
        baseUrl: verified.baseUrl,
        model: verified.model,
        githubTokenPreview: maskSecret(verified.githubToken || ""),
        hasGithubToken: Boolean(verified.githubToken)
      });
      setSettingsStatus(`设置已保存。API Key: ${maskSecret(verified.apiKey)}`);
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  async function testSettings() {
    setSettingsStatus("正在测试已保存的设置...");
    setError("");
    try {
      const diagnostics = await send<SettingsDiagnostics>({ type: "test-settings", repo: repo || undefined });
      setSettingsDiagnostics(diagnostics);
      setSettingsStatus(diagnostics.hasApiKey ? `已保存 API Key: ${diagnostics.apiKeyPreview}` : "未读取到已保存的 Qwen API Key。");
    } catch (err) {
      setSettingsStatus("");
      setError(humanizeError(err));
    }
  }

  function ask(text = question) {
    const trimmed = text.trim();
    if (!repo || !trimmed || loading) return;

    run(
      "正在回答问题...",
      () =>
        send<ProjectOverview>({
          type: "answer-question",
          repo,
          question: trimmed,
          context: buildAskContext(overview, featurePath, fileExplanation, answers)
        }),
      (answer, elapsedMs) => {
        setAnswers((items) => [...items, { question: trimmed, answer, elapsedMs }]);
        setQuestion("");
        setTab("ask");
      }
    );
  }

  if (collapsed) {
    return (
      <button className="cp-fab" onClick={() => setCollapsed(false)} title="Open CodePath">
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
        <button className="cp-icon-btn" onClick={() => setCollapsed(true)} title="Collapse">
          <X size={16} />
        </button>
      </header>

      <nav className="cp-tabs">
        <TabButton active={tab === "overview"} icon={<Map size={15} />} onClick={() => setTab("overview")} label="项目概览" />
        <TabButton active={tab === "feature"} icon={<Route size={15} />} onClick={() => setTab("feature")} label="功能路径" />
        <TabButton active={tab === "file"} icon={<FileCode2 size={15} />} onClick={() => setTab("file")} label="当前文件" />
        <TabButton active={tab === "ask"} icon={<MessageSquare size={15} />} onClick={() => setTab("ask")} label="问答记录" />
        <TabButton active={tab === "settings"} icon={<KeyRound size={15} />} onClick={() => setTab("settings")} label="设置" />
      </nav>

      {error && <div className="cp-alert">{error}</div>}
      {loading && <div className="cp-loading">{formatLoadingStatus(loading, loadingStartedAt, now)}</div>}

      <main className="cp-content">
        {tab === "overview" && (
          <section className="cp-section">
            <p>分析项目用途、技术栈、目录职责、入口文件和推荐阅读路线。</p>
            <button
              className="cp-primary"
              disabled={!repo || !!loading}
              onClick={() => repo && run("正在分析项目...", () => send<ProjectOverview>({ type: "analyze-project", repo }), setOverview)}
            >
              <BookOpen size={16} />
              分析项目
            </button>
            {overview && (
              <>
                <MarkdownBlock repo={repo} text={overview.summary} sources={overview.sources.map((item) => item.path)} />
                <SuggestionList suggestions={overviewSuggestions()} loading={!!loading} onAsk={ask} onDraft={setQuestion} />
              </>
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
              onClick={() => repo && run("正在分析功能路径...", () => send<FeaturePath>({ type: "analyze-feature", repo, feature }), setFeaturePath)}
            >
              <Route size={16} />
              分析功能路径
            </button>
            {featurePath && (
              <>
                <MarkdownBlock repo={repo} text={featurePath.summary} sources={featurePath.sources.map((item) => item.path)} />
                <SuggestionList suggestions={featureSuggestions(featurePath.feature)} loading={!!loading} onAsk={ask} onDraft={setQuestion} />
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
              onClick={() => repo && run("正在解释当前文件...", () => send<FileExplanation>({ type: "explain-file", repo }), setFileExplanation)}
            >
              <FileCode2 size={16} />
              解释当前文件
            </button>
            {fileExplanation && (
              <>
                <MarkdownBlock repo={repo} text={fileExplanation.summary} sources={fileExplanation.sources.map((item) => item.path)} />
                <SuggestionList suggestions={fileSuggestions(fileExplanation.path)} loading={!!loading} onAsk={ask} onDraft={setQuestion} />
              </>
            )}
          </section>
        )}

        {tab === "ask" && (
          <section className="cp-section">
            <p>这里是后续追问记录。你可以在底部输入问题，也可以点击推荐问题直接发送。</p>
            {answers.length === 0 ? (
              <SuggestionList suggestions={DEFAULT_QUESTIONS} loading={!!loading} onAsk={ask} onDraft={setQuestion} />
            ) : (
              <div className="cp-chat-list">
                {answers.map((item, index) => (
                  <article className="cp-chat-item" key={`${item.question}-${index}`}>
                    <strong>问：{item.question}</strong>
                    {item.elapsedMs !== undefined && <div className="cp-chat-meta">回答耗时：{formatElapsed(item.elapsedMs)}</div>}
                    <MarkdownBlock repo={repo} text={item.answer.summary} sources={item.answer.sources.map((source) => source.path)} />
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "settings" && (
          <SettingsPanel settings={settings} status={settingsStatus} diagnostics={settingsDiagnostics} onChange={saveSettings} onTest={testSettings} />
        )}
      </main>

      {tab !== "settings" && <GlobalAskInput question={question} loading={!!loading} disabled={!repo} onChange={setQuestion} onAsk={() => ask()} />}
    </aside>
  );
}

function ResizeHandle(props: { width: number; onChange: (width: number) => void }) {
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = props.width;

    function onMove(moveEvent: PointerEvent) {
      const nextWidth = clamp(startWidth + (startX - moveEvent.clientX), 340, Math.min(860, window.innerWidth - 32));
      props.onChange(nextWidth);
      window.localStorage.setItem("codepath.panelWidth", String(nextWidth));
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return <div className="cp-resize-handle" onPointerDown={startResize} title="Drag to resize" />;
}

function TabButton(props: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? "cp-tab active" : "cp-tab"} onClick={props.onClick} title={props.label}>
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

function SettingsPanel(props: {
  settings: Settings;
  status: string;
  diagnostics: SettingsDiagnostics | null;
  onChange: (settings: Settings) => void;
  onTest: () => void;
}) {
  const [draft, setDraft] = useState(props.settings);

  useEffect(() => setDraft(props.settings), [props.settings]);

  return (
    <section className="cp-section">
      <div className="cp-version-banner">CodePath 构建版本：{UI_VERSION}</div>
      <h3 className="cp-section-title">模型与访问设置</h3>
      <label className="cp-label">
        模型服务商
        <select className="cp-input" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as Settings["provider"] })}>
          <option value="qwen">Qwen</option>
          <option value="custom">自定义 OpenAI 兼容接口</option>
        </select>
      </label>
      <label className="cp-label">
        模型 API Key
        <input className="cp-input" type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="sk-..." />
      </label>
      <label className="cp-label">
        Base URL
        <input className="cp-input" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      </label>
      <label className="cp-label">
        模型名称
        <input className="cp-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
      </label>
      <label className="cp-label">
        GitHub Token（可选）
        <input className="cp-input" type="password" value={draft.githubToken ?? ""} onChange={(event) => setDraft({ ...draft, githubToken: event.target.value })} />
      </label>
      <button className="cp-primary" onClick={() => props.onChange(draft)}>
        保存并校验设置
      </button>
      <button className="cp-secondary" onClick={props.onTest}>
        测试已保存设置
      </button>
      {props.status && <p className="cp-save-status">{props.status}</p>}
      <SettingsSummary diagnostics={props.diagnostics} draft={draft} />
      <p className="cp-muted">Qwen DashScope 默认 Base URL：{DEFAULT_SETTINGS.baseUrl}</p>
    </section>
  );
}

function SettingsSummary(props: { diagnostics: SettingsDiagnostics | null; draft: Settings }) {
  const diagnostics = props.diagnostics;
  return (
    <div className="cp-settings-summary">
      <strong>当前可见配置</strong>
      <dl>
        <div>
          <dt>服务商</dt>
          <dd>{diagnostics?.provider || props.draft.provider}</dd>
        </div>
        <div>
          <dt>API Key</dt>
          <dd>{diagnostics?.apiKeyPreview || maskSecret(props.draft.apiKey)}</dd>
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
          <dd>{diagnostics?.githubTokenPreview || maskSecret(props.draft.githubToken || "")}</dd>
        </div>
        {diagnostics?.repoCheck && (
          <div>
            <dt>GitHub 检查</dt>
            <dd>{diagnostics.repoCheck}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function SuggestionList(props: {
  suggestions: string[];
  loading: boolean;
  onAsk: (question: string) => void;
  onDraft: (question: string) => void;
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
      <strong>推荐追问</strong>
      {props.suggestions.map((suggestion) => (
        <div key={suggestion} className="cp-suggestion-row">
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
      ))}
    </div>
  );
}

function MarkdownBlock(props: { repo: RepoRef | null; text: string; sources: string[] }) {
  return (
    <div className="cp-result">
      <div className="cp-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeLinkCodePaths(props.repo)]}>
          {props.text}
        </ReactMarkdown>
      </div>
      {props.sources.length > 0 && (
        <div className="cp-sources">
          <strong>参考源码</strong>
          {props.sources.map((source) =>
            props.repo ? (
              <a key={source} href={githubFileUrl(props.repo, source)} target="_blank" rel="noreferrer">
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

function overviewSuggestions(): string[] {
  return [
    "按步骤解释这个项目的主执行流程。",
    "如果我要二次开发，应该先读哪些文件？",
    "训练、推理和评估入口分别在哪里？"
  ];
}

function featureSuggestions(feature: string): string[] {
  return [
    `按文件顺序解释「${feature}」的实现流程。`,
    `如果我要修改「${feature}」，应该改哪些文件？`,
    `修改「${feature}」时有哪些风险？`
  ];
}

function fileSuggestions(path: string): string[] {
  return [
    `用大白话解释 ${path} 的核心逻辑。`,
    `${path} 依赖谁？又被哪些模块依赖？`,
    `修改 ${path} 前需要注意什么？`
  ];
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

async function send<T>(request: RuntimeRequest): Promise<T> {
  const response = await sendBestEffort<T>(request);
  if (!response.ok) throw new Error(response.error || "Request failed.");
  return response.data as T;
}

async function sendBestEffort<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  const storageResponse = await sendSettingsViaStorage<T>(request).catch(() => undefined);
  if (storageResponse?.ok) return storageResponse;

  const portError: { message?: string } = {};
  const portResponse = await sendViaPort<T>(request).catch((error) => {
    portError.message = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  if (portResponse) return portResponse;

  const messageError: { message?: string } = {};
  const messageResponse = await sendViaMessage<T>(request).catch((error) => {
    messageError.message = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  if (messageResponse) return messageResponse;

  if (request.type !== "get-settings" && request.type !== "save-settings") {
    return fail<T>(backgroundUnavailableMessage(messageError.message || portError.message || "No background response."));
  }

  return handleLocally<T>(request);
}

async function sendSettingsViaStorage<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  if (request.type === "get-settings") {
    return localOk((await getExtensionSettings()) as T);
  }

  if (request.type === "save-settings") {
    await setExtensionSettings(request.settings);
    return localOk(request.settings as T);
  }

  return { ok: false, error: "Not a settings request." };
}

async function handleLocally<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  try {
    if (request.type === "get-settings") {
      return localOk(readLocalSettings() as T);
    }

    if (request.type === "save-settings") {
      writeLocalSettings(request.settings);
      return localOk(request.settings as T);
    }

    const settings = readLocalSettings();
    if (request.type === "analyze-project") {
      return localOk((await analyzeProject(request.repo, settings)) as T);
    }

    if (request.type === "analyze-feature") {
      return localOk((await analyzeFeature(request.repo, settings, request.feature)) as T);
    }

    if (request.type === "explain-file") {
      return localOk((await explainFile(request.repo, settings)) as T);
    }

    if (request.type === "answer-question") {
      return localOk((await answerQuestion(request.repo, settings, request.question, request.context)) as T);
    }

    return { ok: false, error: "Unknown request." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readLocalSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: window.localStorage.getItem("codepath.apiKey") || "",
    baseUrl: window.localStorage.getItem("codepath.baseUrl") || DEFAULT_SETTINGS.baseUrl,
    model: window.localStorage.getItem("codepath.model") || DEFAULT_SETTINGS.model,
    githubToken: window.localStorage.getItem("codepath.githubToken") || ""
  };
}

function writeLocalSettings(settings: Settings) {
  window.localStorage.setItem("codepath.apiKey", settings.apiKey || "");
  window.localStorage.setItem("codepath.baseUrl", settings.baseUrl || DEFAULT_SETTINGS.baseUrl);
  window.localStorage.setItem("codepath.model", settings.model || DEFAULT_SETTINGS.model);
  window.localStorage.setItem("codepath.githubToken", settings.githubToken || "");
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
      resolve({ ...DEFAULT_SETTINGS, ...patch });
    });
  });
}

function setExtensionSettings(settings: Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      reject(new Error("Extension storage is unavailable."));
      return;
    }

    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
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
): string {
  const parts = [
    overview ? `Project overview:\n${overview.summary}` : "",
    featurePath ? `Feature analysis (${featurePath.feature}):\n${featurePath.summary}` : "",
    fileExplanation ? `File explanation (${fileExplanation.path}):\n${fileExplanation.summary}` : "",
    ...answers.slice(-3).map((item) => `Previous question: ${item.question}\nAnswer: ${item.answer.summary}`)
  ].filter(Boolean);
  return parts.join("\n\n---\n\n");
}

function sendViaBridge<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener("codepath:page-response", listener);
      reject(new Error("Page bridge response timed out."));
    }, 5000);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string } & RuntimeResponse<T>>).detail;
      if (detail.id !== id) return;
      window.clearTimeout(timeout);
      window.removeEventListener("codepath:page-response", listener);
      resolve(detail);
    };
    window.addEventListener("codepath:page-response", listener);
    window.dispatchEvent(new CustomEvent("codepath:page-request", { detail: { id, request } }));
  });
}

function sendViaMessage<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response) {
        reject(new Error("Background returned no response."));
        return;
      }
      resolve(response as RuntimeResponse<T>);
    });
  });
}

function sendViaPort<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const port = chrome.runtime.connect({ name: "codepath" });
    const timeout = window.setTimeout(() => {
      reject(new Error("Background response timed out."));
    }, 120000);

    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Extract<PortMessage, { response: RuntimeResponse<unknown> }>;
      if (envelope.id !== id) return;
      window.clearTimeout(timeout);
      resolve(envelope.response as RuntimeResponse<T>);
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (error) {
        window.clearTimeout(timeout);
        reject(new Error(error.message));
      }
    });

    port.postMessage({ id, request } satisfies PortMessage);
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
  if (message.includes("401") || message.includes("Unauthorized")) {
    return "API Key 或 GitHub Token 被拒绝。请检查设置后再试。";
  }
  if (message.includes("Failed to fetch")) {
    return "网络请求失败。请检查仓库地址、Token 或模型 Base URL。";
  }
  return message;
}
