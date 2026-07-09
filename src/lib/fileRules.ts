const IGNORE_PREFIXES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".cache/",
  ".next/",
  ".nuxt/",
  ".vite/",
  "vendor/",
  "public/assets/"
];

const IGNORE_SUFFIXES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".zip",
  ".gz",
  ".lock"
];

const SOURCE_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".rb",
  ".md",
  ".json",
  ".toml",
  ".yaml",
  ".yml"
];

export const FILE_RULES_FINGERPRINT = JSON.stringify({
  IGNORE_PREFIXES,
  IGNORE_SUFFIXES,
  SOURCE_SUFFIXES,
  likelyImportantRules: [
    "readme.md",
    "package.json",
    "tsconfig.json",
    "vite.config",
    "next.config",
    "nuxt.config",
    "main.",
    "index.",
    "app.",
    "src/router/",
    "src/routes/",
    "src/pages/",
    "src/api/",
    "src/services/",
    "src/store/"
  ],
  classifyRules: [
    "页面:page,/pages/,/views/",
    "组件:/components/",
    "接口请求:/api/,request,client",
    "业务服务:/service,/services/",
    "状态管理:/store/,redux,zustand",
    "路由:/router/,/routes/",
    "测试:test,spec",
    "配置:config",
    "工具函数:/utils/,/lib/",
    "源码:default"
  ],
  functionSources: [isUsefulPath.toString(), hasIgnoredSegment.toString(), isLikelyImportant.toString(), classifyPath.toString()]
});

export function isUsefulPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (hasIgnoredSegment(normalized)) return false;
  if (IGNORE_SUFFIXES.some((suffix) => normalized.toLowerCase().endsWith(suffix))) return false;
  if (["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].includes(normalized)) return false;
  return SOURCE_SUFFIXES.some((suffix) => normalized.toLowerCase().endsWith(suffix));
}

function hasIgnoredSegment(path: string): boolean {
  const normalized = path.toLowerCase();
  if (IGNORE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const ignoredNames = new Set(IGNORE_PREFIXES.map((prefix) => prefix.replace(/\/$/, "")));
  return normalized.split("/").some((segment) => ignoredNames.has(segment));
}

export function isLikelyImportant(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p === "readme.md" ||
    p === "package.json" ||
    p === "tsconfig.json" ||
    p.includes("vite.config") ||
    p.includes("next.config") ||
    p.includes("nuxt.config") ||
    p.includes("main.") ||
    p.includes("index.") ||
    p.includes("app.") ||
    p.startsWith("src/router/") ||
    p.startsWith("src/routes/") ||
    p.startsWith("src/pages/") ||
    p.startsWith("src/api/") ||
    p.startsWith("src/services/") ||
    p.startsWith("src/store/")
  );
}

export function classifyPath(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("page") || p.includes("/pages/") || p.includes("/views/")) return "页面";
  if (p.includes("/components/")) return "组件";
  if (p.includes("/api/") || p.includes("request") || p.includes("client")) return "接口请求";
  if (p.includes("/service") || p.includes("/services/")) return "业务服务";
  if (p.includes("/store/") || p.includes("redux") || p.includes("zustand")) return "状态管理";
  if (p.includes("/router/") || p.includes("/routes/")) return "路由";
  if (p.includes("test") || p.includes("spec")) return "测试";
  if (p.includes("config")) return "配置";
  if (p.includes("/utils/") || p.includes("/lib/")) return "工具函数";
  return "源码";
}
