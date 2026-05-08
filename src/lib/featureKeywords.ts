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
  配置: ["config", "setting", "preference"]
};

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
