"use client";
import Link from "@/components/navigation-link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  FlaskConical,
  LayoutDashboard,
  Compass,
  Inbox,
  Layers3,
  Sparkles,
  Settings2,
  Moon,
  Sun,
  ArrowUpRight,
  Menu,
  X,
  CircleHelp,
} from "lucide-react";
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const labels: Record<string, string> = {
    "/": "Overview",
    "/ideas": "Idea explorer",
    "/ideas/new": "Capture an idea",
    "/ideas/semantic": "Semantic search",
    "/review": "Review center",
    "/review/compare": "Compare ideas",
    "/review/merge": "Merge ideas",
    "/sources": "Sources & imports",
    "/settings": "Settings",
    "/evaluations": "Scoring workbench",
    "/analyst": "Idea analyst",
  };
  const breadcrumb =
    labels[path] ??
    (path.startsWith("/claude/connect/")
      ? "Connect Claude"
      : path.startsWith("/capture/assistant/")
        ? "Review assistant capture"
        : path.startsWith("/ideas/")
          ? path.endsWith("/evaluate")
            ? "Evaluate idea"
            : path.endsWith("/edit")
              ? "Edit idea"
              : "Idea detail"
          : path.startsWith("/review/assessments/")
            ? "Assessment proposal"
            : path.startsWith("/review/proposals/")
              ? "Extraction proposal"
              : path.startsWith("/review/")
                ? "Review decision"
                : "Workspace");
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("idea-lab-theme");
    const value = saved
      ? saved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(value);
    document.documentElement.dataset.theme = value ? "dark" : "light";
  }, []);
  function toggle() {
    setDark(!dark);
    document.documentElement.dataset.theme = !dark ? "dark" : "light";
    localStorage.setItem("idea-lab-theme", !dark ? "dark" : "light");
  }
  const links = [
    { href: "/", name: "Overview", icon: LayoutDashboard },
    { href: "/ideas", name: "Idea explorer", icon: Compass },
    { href: "/review", name: "Review center", icon: Inbox },
    { href: "/sources", name: "Sources & imports", icon: Layers3 },
  ];
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <button
        className="mobile-menu"
        aria-expanded={open}
        aria-controls="workspace-navigation"
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen(!open)}
      >
        {open ? <X /> : <Menu />}
      </button>
      <aside
        id="workspace-navigation"
        className={open ? "sidebar mobile-open" : "sidebar"}
      >
        <Link className="brand" href="/" onClick={() => setOpen(false)}>
          <span className="brand-mark">
            <FlaskConical size={23} />
          </span>
          <span>
            idea lab<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <nav aria-label="Main navigation">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              aria-current={
                (l.href === "/" ? path === "/" : path.startsWith(l.href))
                  ? "page"
                  : undefined
              }
              className={
                (l.href === "/" ? path === "/" : path.startsWith(l.href))
                  ? "nav-item selected"
                  : "nav-item"
              }
            >
              <l.icon size={18} />
              {l.name}
            </Link>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <Link
          className={"nav-item " + (path === "/analyst" ? "selected" : "")}
          href="/analyst"
          onClick={() => setOpen(false)}
        >
          <Sparkles size={18} />
          Idea analyst<span className="soon">SOON</span>
        </Link>
        <div className="sidebar-bottom">
          <div className="lab-note">
            <span className="little-star">✧</span>
            <strong>A home for your next big thing.</strong>
            <p>Connect the dots. Find your focus. Make something matter.</p>
            <Link href="/ideas">
              Explore your ideas <ArrowUpRight size={14} />
            </Link>
          </div>
          <Link
            className="nav-item"
            href="/settings"
            onClick={() => setOpen(false)}
          >
            <Settings2 size={17} />
            Settings
          </Link>
          <button className="nav-item theme-toggle" onClick={toggle}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}{" "}
            {dark ? "Light appearance" : "Dark appearance"}
          </button>
          <div className="profile">
            <span className="avatar">Y</span>
            <div>
              <strong>Your workspace</strong>
              <small>Private workspace</small>
            </div>
            <CircleHelp size={17} />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <span className="crumb">/</span>{" "}
            <strong>{breadcrumb}</strong>
          </span>
          <span className="demo-indicator">
            <span />
            Private workspace · Notion
          </span>
        </header>
        <main id="main">{children}</main>
        <footer className="footer">
          <span>Good ideas deserve a place to grow.</span>
          <span>Idea Lab / Foundation preview</span>
        </footer>
      </div>
    </div>
  );
}
