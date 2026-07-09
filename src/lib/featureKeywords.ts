const KEYWORDS: Record<string, string[]> = {
  登录: ["login", "signin", "sign-in", "auth", "token", "session", "user"],
  登陆: ["login", "signin", "sign-in", "auth", "token", "session", "user"],
  注册: ["register", "signup", "sign-up", "auth", "user"],
  上传: ["upload", "file", "attachment", "storage"],
  搜索: ["search", "query", "filter"],
  评论: ["comment", "reply", "discussion"],
  权限: ["permission", "role", "access", "guard", "auth"],
  支付: ["payment", "pay", "checkout", "order"],
  购物车: ["cart", "basket", "checkout"],
  用户: ["user", "profile", "account"],
  配置: ["config", "setting", "preference"],
  训练: ["train", "training", "trainer", "dataset", "dataloader", "config", "checkpoint", "eval", "evaluate"],
  推理: ["inference", "infer", "predict", "demo", "checkpoint", "model"],
  评估: ["eval", "evaluate", "metric", "visualization", "benchmark"],
  数据: ["data", "dataset", "dataloader", "loader", "worker"],
  缓存: ["cache", "storage", "persist", "clear", "delete"],
  侧边栏: ["sidebar", "content", "background", "runtime", "message", "wxt"],
  浏览器插件: ["extension", "content", "background", "manifest", "wxt", "sidebar"],
  插件: ["extension", "plugin", "content", "background", "manifest", "wxt"],
  流式: ["stream", "streaming", "delta", "sse", "fallback"],
  追问: ["question", "answer", "suggestion", "follow", "chat"],
  推荐追问: ["suggestion", "question", "follow", "chat"],
  mcp: ["mcp", "server", "registerTool", "tool", "openclaw"],
  OpenClaw: ["openclaw", "skill", "blueprint", "mcp"],
  Skill: ["skill", "blueprint", "openclaw", "markdown"]
};

export const FEATURE_KEYWORDS_FINGERPRINT = JSON.stringify(KEYWORDS);

export function expandFeatureKeywords(feature: string): string[] {
  const normalized = feature.trim();
  const base = new Set<string>([normalized.toLowerCase()]);
  for (const [key, values] of Object.entries(KEYWORDS)) {
    if (normalized.includes(key)) values.forEach((value) => base.add(value.toLowerCase()));
  }
  normalized
    .split(/[\s,，/]+/)
    .filter(Boolean)
    .forEach((part) => base.add(part.toLowerCase()));
  return [...base];
}
