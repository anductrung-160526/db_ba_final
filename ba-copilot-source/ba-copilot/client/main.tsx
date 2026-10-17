import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { UIProvider } from "./components/ui.tsx";
import { Home } from "./views/Home.tsx";
import { ProjectView } from "./views/ProjectView.tsx";
import { ModuleView } from "./views/ModuleView.tsx";
import { get } from "./api.ts";

export function navigate(hash: string) {
  window.location.hash = hash;
}

function useHash() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const h = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const [settings, setSettings] = useState<{ provider: string; model: string; auth?: boolean } | null>(null);
  useEffect(() => {
    get("/api/settings").then(setSettings).catch(() => {});
  }, []);
  const parts = hash.replace(/^#\/?/, "").split("/");
  let view: React.ReactNode;
  if (parts[0] === "p" && parts[1]) view = <ProjectView id={parts[1]} tab={parts[2] || "modules"} initialModuleId={parts[3] || null} />;
  else if (parts[0] === "m" && parts[1]) view = <ModuleView id={parts[1]} tab={parts[2] || "design"} />;
  else view = <Home />;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo">BA</span>
          <span>
            BA Copilot<span className="brand-sub">Prompt → Thiết kế → Tài liệu → Test</span>
          </span>
        </a>
        {settings && (
          <span className={`ai-pill ${settings.provider === "claude" ? "on" : ""}`} title={settings.provider === "claude" ? "Đang dùng Claude API" : "Chưa có ANTHROPIC_API_KEY – đang chạy bộ sinh rule-based"}>
            {settings.provider === "claude" ? `Claude · ${settings.model}` : "Chế độ Mock (rule-based)"}
          </span>
        )}
        {settings?.auth && (
          <button className="btn btn-ghost btn-sm" onClick={() => fetch("/api/logout", { method: "POST" }).then(() => window.location.reload())}>
            Đăng xuất
          </button>
        )}
      </header>
      <main className="main">{view}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <UIProvider>
    <App />
  </UIProvider>,
);
