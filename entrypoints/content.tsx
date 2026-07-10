import React from "react";
import { createRoot } from "react-dom/client";
import { parseGithubUrl } from "../src/lib/githubUrl";
import { Sidebar } from "../src/components/Sidebar";
import "../src/styles.css";

const CONTENT_BUILD = "dev-2026-07-09-self-reload-v1";
const ROOT_ID = "codepath-dev-root";
const LEGACY_ROOT_ID = "codepath-root";
const OWNED_MARKER = "true";

let reactRoot: ReturnType<typeof createRoot> | null = null;
let ownedHost: HTMLElement | null = null;

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  main() {
    clearLegacyPageSecrets();
    mount();
    let lastUrl = location.href;
    const intervalId = window.setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        mount();
      }
    }, 800);
    return () => {
      window.clearInterval(intervalId);
      unmount();
    };
  }
});

function clearLegacyPageSecrets() {
  window.localStorage.removeItem("codepath.apiKey");
  window.localStorage.removeItem("codepath.githubToken");
}

function mount() {
  const repo = parseGithubUrl(location.href);
  if (!repo) {
    unmount();
    return;
  }

  const legacyHost = document.getElementById(LEGACY_ROOT_ID);
  if (legacyHost?.dataset.codepathOwned === OWNED_MARKER) legacyHost.remove();

  let host = getOwnedHost();
  if (host && host.dataset.codepathBuild !== CONTENT_BUILD) {
    unmount();
    host = getOwnedHost();
  }

  if (!host) {
    host = document.createElement("div");
    host.id = ROOT_ID;
    host.dataset.codepathBuild = CONTENT_BUILD;
    host.dataset.codepathOwned = OWNED_MARKER;
    document.body.appendChild(host);
    ownedHost = host;
    reactRoot = createRoot(host);
    reactRoot.render(<Sidebar />);
  }

  window.dispatchEvent(new CustomEvent("codepath:url-change"));
}

function getOwnedHost(): HTMLElement | null {
  if (ownedHost?.isConnected && ownedHost.dataset.codepathOwned === OWNED_MARKER) return ownedHost;
  const existing = document.getElementById(ROOT_ID);
  if (existing instanceof HTMLElement && existing.dataset.codepathOwned === OWNED_MARKER) {
    ownedHost = existing;
    return existing;
  }
  return null;
}

function unmount() {
  reactRoot?.unmount();
  reactRoot = null;
  const host = getOwnedHost();
  host?.remove();
  ownedHost = null;
}
