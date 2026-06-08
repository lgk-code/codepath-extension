window.addEventListener("codepath:page-request", async (event) => {
  const detail = event.detail;
  if (!detail || !detail.id || !detail.request) return;

  const send = (payload) => {
    window.dispatchEvent(
      new CustomEvent("codepath:page-response", {
        detail: {
          id: detail.id,
          ...payload
        }
      })
    );
  };

  try {
    if (detail.request.type === "get-settings") {
      send({
        ok: true,
        data: {
          provider: normalizeProvider(localStorage.getItem("codepath.provider")),
          apiKey: localStorage.getItem("codepath.apiKey") || "",
          baseUrl: localStorage.getItem("codepath.baseUrl") || "",
          model: localStorage.getItem("codepath.model") || "",
          githubToken: localStorage.getItem("codepath.githubToken") || ""
        }
      });
      return;
    }

    if (detail.request.type === "save-settings") {
      const settings = detail.request.settings;
      localStorage.setItem("codepath.provider", normalizeProvider(settings.provider));
      localStorage.setItem("codepath.apiKey", settings.apiKey || "");
      localStorage.setItem("codepath.baseUrl", settings.baseUrl || "");
      localStorage.setItem("codepath.model", settings.model || "");
      localStorage.setItem("codepath.githubToken", settings.githubToken || "");
      send({ ok: true, data: { ...settings, provider: normalizeProvider(settings.provider) } });
      return;
    }

    send({ ok: false, error: "Extension background is not connected yet. Reload the extension and page, then try again." });
  } catch (error) {
    send({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

function normalizeProvider(value) {
  return value === "anthropic" ? "anthropic" : "openai";
}
