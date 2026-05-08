import React, { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, FileCode2, KeyRound, Map, MessageSquare, Route, Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FeaturePath, FileExplanation, PortMessage, ProjectOverview, RepoRef, RuntimeRequest, RuntimeResponse, Settings } from "../types";
import { DEFAULT_SETTINGS } from "../lib/defaults";
import { parseGithubUrl } from "../lib/githubUrl";
import { analyzeFeature, analyzeProject, answerQuestion, explainFile } from "../lib/analyzer";

type Tab = "overview" | "feature" | "file" | "ask" | "settings";

type ChatTurn = {
  question: string;
  answer: ProjectOverview;
};

const DEFAULT_QUESTIONS = [
  "What should I read first in this project?",
  "Explain the main runtime flow step by step.",
  "Which files are most important for secondary development?"
];

export function Sidebar() {
  const [repo, setRepo] = useState<RepoRef | null>(() => parseGithubUrl(location.href));
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(() => readPanelWidth());
  const [tab, setTab] = useState<Tab>("overview");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [feature, setFeature] = useState("");
  const [featurePath, setFeaturePath] = useState<FeaturePath | null>(null);
  const [fileExplanation, setFileExplanation] = useState<FileExplanation | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<ChatTurn[]>([]);

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

  const title = useMemo(() => (repo ? `${repo.owner}/${repo.repo}` : "No GitHub repository detected"), [repo]);

  async function run<T>(label: string, action: () => Promise<T>, onDone: (value: T) => void) {
    setLoading(label);
    setError("");
    try {
      onDone(await action());
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading("");
    }
  }

  async function saveSettings(next: Settings) {
    setSettings(next);
    await send<Settings>({ type: "save-settings", settings: next });
  }

  function ask(text = question) {
    const trimmed = text.trim();
    if (!repo || !trimmed || loading) return;

    run(
      "Answering question...",
      () =>
        send<ProjectOverview>({
          type: "answer-question",
          repo,
          question: trimmed,
          context: buildAskContext(overview, featurePath, fileExplanation, answers)
        }),
      (answer) => {
        setAnswers((items) => [...items, { question: trimmed, answer }]);
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
        <TabButton active={tab === "overview"} icon={<Map size={15} />} onClick={() => setTab("overview")} label="Overview" />
        <TabButton active={tab === "feature"} icon={<Route size={15} />} onClick={() => setTab("feature")} label="Feature Path" />
        <TabButton active={tab === "file"} icon={<FileCode2 size={15} />} onClick={() => setTab("file")} label="File" />
        <TabButton active={tab === "ask"} icon={<MessageSquare size={15} />} onClick={() => setTab("ask")} label="History" />
        <TabButton active={tab === "settings"} icon={<KeyRound size={15} />} onClick={() => setTab("settings")} label="Settings" />
      </nav>

      {error && <div className="cp-alert">{error}</div>}
      {loading && <div className="cp-loading">{loading}</div>}

      <main className="cp-content">
        {tab === "overview" && (
          <section className="cp-section">
            <p>Analyze the project idea, tech stack, directory roles, entry points, and suggested reading route.</p>
            <button
              className="cp-primary"
              disabled={!repo || !!loading}
              onClick={() => repo && run("Analyzing project...", () => send<ProjectOverview>({ type: "analyze-project", repo }), setOverview)}
            >
              <BookOpen size={16} />
              Analyze Project
            </button>
            {overview && (
              <>
                <MarkdownBlock repo={repo} text={overview.summary} sources={overview.sources.map((item) => item.path)} />
                <SuggestionList suggestions={overviewSuggestions()} onAsk={ask} />
              </>
            )}
          </section>
        )}

        {tab === "feature" && (
          <section className="cp-section">
            <p>Enter a feature, such as login, upload, search, training, evaluation, or permissions. CodePath will find related files and connect them into an implementation path.</p>
            <input className="cp-input" value={feature} onChange={(event) => setFeature(event.target.value)} placeholder="Example: training flow" />
            <button
              className="cp-primary"
              disabled={!repo || !feature.trim() || !!loading}
              onClick={() => repo && run("Analyzing feature path...", () => send<FeaturePath>({ type: "analyze-feature", repo, feature }), setFeaturePath)}
            >
              <Route size={16} />
              Analyze Feature
            </button>
            {featurePath && (
              <>
                <MarkdownBlock repo={repo} text={featurePath.summary} sources={featurePath.sources.map((item) => item.path)} />
                <SuggestionList suggestions={featureSuggestions(featurePath.feature)} onAsk={ask} />
              </>
            )}
          </section>
        )}

        {tab === "file" && (
          <section className="cp-section">
            <p>Explain the current GitHub file page: purpose, main structure, dependencies, and modification risks.</p>
            {repo?.path && <div className="cp-path">{repo.path}</div>}
            <button
              className="cp-primary"
              disabled={!repo || repo.pageType !== "file" || !!loading}
              onClick={() => repo && run("Explaining current file...", () => send<FileExplanation>({ type: "explain-file", repo }), setFileExplanation)}
            >
              <FileCode2 size={16} />
              Explain Current File
            </button>
            {fileExplanation && (
              <>
                <MarkdownBlock repo={repo} text={fileExplanation.summary} sources={fileExplanation.sources.map((item) => item.path)} />
                <SuggestionList suggestions={fileSuggestions(fileExplanation.path)} onAsk={ask} />
              </>
            )}
          </section>
        )}

        {tab === "ask" && (
          <section className="cp-section">
            <p>Conversation history for follow-up questions. You can ask from the input fixed at the bottom of the sidebar.</p>
            {answers.length === 0 ? (
              <SuggestionList suggestions={DEFAULT_QUESTIONS} onAsk={ask} />
            ) : (
              <div className="cp-chat-list">
                {answers.map((item, index) => (
                  <article className="cp-chat-item" key={`${item.question}-${index}`}>
                    <strong>Q: {item.question}</strong>
                    <MarkdownBlock repo={repo} text={item.answer.summary} sources={item.answer.sources.map((source) => source.path)} />
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "settings" && <SettingsPanel settings={settings} onChange={saveSettings} />}
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
        placeholder="Ask a follow-up about this repository..."
        rows={2}
      />
      <button className="cp-send-btn" disabled={props.disabled || props.loading || !props.question.trim()} onClick={props.onAsk} title="Send">
        <Send size={16} />
      </button>
    </footer>
  );
}

function SettingsPanel(props: { settings: Settings; onChange: (settings: Settings) => void }) {
  const [draft, setDraft] = useState(props.settings);

  useEffect(() => setDraft(props.settings), [props.settings]);

  return (
    <section className="cp-section">
      <label className="cp-label">
        Provider
        <select className="cp-input" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as Settings["provider"] })}>
          <option value="qwen">Qwen</option>
          <option value="custom">Custom OpenAI-compatible</option>
        </select>
      </label>
      <label className="cp-label">
        API Key
        <input className="cp-input" type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="sk-..." />
      </label>
      <label className="cp-label">
        Base URL
        <input className="cp-input" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      </label>
      <label className="cp-label">
        Model
        <input className="cp-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
      </label>
      <label className="cp-label">
        GitHub Token (optional)
        <input className="cp-input" type="password" value={draft.githubToken ?? ""} onChange={(event) => setDraft({ ...draft, githubToken: event.target.value })} />
      </label>
      <button className="cp-primary" onClick={() => props.onChange(draft)}>
        Save Settings
      </button>
      <p className="cp-muted">Default Qwen DashScope base URL: {DEFAULT_SETTINGS.baseUrl}</p>
    </section>
  );
}

function SuggestionList(props: { suggestions: string[]; onAsk: (question: string) => void }) {
  return (
    <div className="cp-suggestions">
      <strong>Follow up</strong>
      {props.suggestions.map((suggestion) => (
        <button key={suggestion} className="cp-suggestion" onClick={() => props.onAsk(suggestion)}>
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function MarkdownBlock(props: { repo: RepoRef | null; text: string; sources: string[] }) {
  return (
    <div className="cp-result">
      <div className="cp-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
      </div>
      {props.sources.length > 0 && (
        <div className="cp-sources">
          <strong>Sources</strong>
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
    "Explain the main execution flow step by step.",
    "Which files should I read first for secondary development?",
    "Where are the training, inference, and evaluation entry points?"
  ];
}

function featureSuggestions(feature: string): string[] {
  return [
    `Explain the ${feature} flow with file-by-file steps.`,
    `If I want to modify ${feature}, which files should I change?`,
    `What are the risks when changing ${feature}?`
  ];
}

function fileSuggestions(path: string): string[] {
  return [
    `Explain ${path} line by line at a high level.`,
    `Who depends on ${path}, and what does it depend on?`,
    `What should I be careful about before editing ${path}?`
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

function githubFileUrl(repo: RepoRef, path: string): string {
  const branch = repo.branch || "main";
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function send<T>(request: RuntimeRequest): Promise<T> {
  const response = await sendBestEffort<T>(request);
  if (!response.ok) throw new Error(response.error || "Request failed.");
  return response.data as T;
}

async function sendBestEffort<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  const portResponse = await sendViaPort<T>(request).catch(() => undefined);
  if (portResponse?.ok) return portResponse;

  const bridgeResponse = await sendViaBridge<T>(request).catch(() => undefined);
  if (bridgeResponse?.ok) return bridgeResponse;

  return handleLocally<T>(request);
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

function localOk<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data };
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

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("API rate limit")) {
    return "GitHub API rate limit reached. Add a GitHub Token in Settings and try again.";
  }
  if (message.includes("401") || message.includes("Unauthorized")) {
    return "The API key or token was rejected. Check Settings and try again.";
  }
  if (message.includes("Failed to fetch")) {
    return "Network request failed. Check the repository URL, token, or model base URL.";
  }
  return message;
}
