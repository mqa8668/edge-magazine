// Admin panel chrome + shared view kit (redesigned, Phase 3). Dark-sidebar
// console matching the Figma "Redesign News Page" admin. Styles live in
// /public/admin.css; the only client JS is /public/admin.js (progressive). All
// interactive controls are real forms/links (server-rendered), so the panel
// works without JS. Labels are English.

import { html, raw } from "hono/html";
import type { Context } from "hono";
import type { AdminEnv } from "./index";
import { Icon } from "./icons";

// Branding comes from the SITE_NAME / SITE_URL env vars; the admin middleware
// calls setBranding() on every request.
let siteName = "Edge Magazine";
let siteHost = "";
export function setBranding(name?: string, url?: string) {
  siteName = name || "Edge Magazine";
  try {
    siteHost = url ? new URL(url).host : "";
  } catch {
    siteHost = "";
  }
}

// Pipeline posture banner: drafting assistant on/off + publish mode.
export function PipelineBanner(props: { enabled: boolean; mode: "auto" | "review" }) {
  return (
    <div id="pipeline-banner" class={`flash ${props.enabled ? "flash-ok" : "flash-err"}`}>
      <strong>{props.enabled ? "Drafting assistant is on" : "Drafting assistant is off"}</strong>
      {props.enabled ? null : " - the daily cron will not generate drafts until pipeline.enabled is turned on in Config."}
      {" "}
      Publish mode:{" "}
      <strong>{props.mode === "review" ? "review (drafts wait for your approval)" : "auto (drafts go live automatically)"}</strong>
      {props.mode === "review" ? (
        <>
          {" "}
          - <a href="/admin/review">open the review queue</a>
        </>
      ) : null}
    </div>
  );
}

const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&family=DM+Mono:wght@400;500&display=swap";

// Restore the collapsed sidebar before paint (no flash); admin.js persists it.
const COLLAPSE_BOOT =
  "try{if(localStorage.getItem('em_admin_side_collapsed')==='1')document.documentElement.classList.add('side-collapsed')}catch(e){}";

export interface Flash {
  msg?: string;
  err?: string;
}

export interface NavCounts {
  review?: number;
  posts?: number;
  unread?: number; // unread notifications (topbar bell badge)
}

export function flashOf(c: Context<AdminEnv>): Flash {
  return {
    msg: c.req.query("msg") || undefined,
    err: c.req.query("err") || undefined,
  };
}

const NAV: { href: string; label: string; icon: string; badge?: keyof NavCounts }[] = [
  { href: "/admin", label: "Overview", icon: "dashboard" },
  { href: "/admin/runs", label: "Runs", icon: "play" },
  { href: "/admin/queue", label: "Queue", icon: "list" },
  { href: "/admin/review", label: "Review queue", icon: "check-square", badge: "review" },
  { href: "/admin/posts", label: "Posts", icon: "file-text", badge: "posts" },
  { href: "/admin/config", label: "Config", icon: "settings" },
  { href: "/admin/llm", label: "LLM", icon: "cpu" },
  { href: "/admin/tools", label: "Tools", icon: "wrench" },
];

// Orbit + Nova brand mark (matches the public site). White-on-dark in the
// sidebar; ink-on-light on the login card.
export function BrandMark(props: { size?: number; stroke?: string }) {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" fill="none" class="mark" aria-hidden="true">
      <path
        d="M 79.44 33 A 34 34 0 1 0 79.44 67"
        stroke={props.stroke ?? "#ffffff"}
        stroke-width="8"
        stroke-linecap="round"
      />
      <circle cx="86" cy="50" r="6" fill="#d9291b" />
    </svg>
  );
}

export function AdminLayout(props: {
  title: string;
  path: string;
  flash?: Flash;
  csrf?: string;
  navCounts?: NavCounts;
  refresh?: number; // seconds; adds a meta-refresh (live-watch a running run)
  children?: unknown;
}) {
  const counts = props.navCounts ?? {};
  const active = (href: string) =>
    href === "/admin" ? props.path === "/admin" : props.path.startsWith(href);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        {props.refresh ? <meta http-equiv="refresh" content={String(props.refresh)} /> : null}
        <title>{props.title} - {siteName} Admin</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href={FONTS} />
        <link rel="stylesheet" href="/admin.css" />
        <script>{raw(COLLAPSE_BOOT)}</script>
      </head>
      <body>
        <input type="checkbox" id="side-open" hidden />
        <div class="app">
          <label for="side-open" class="scrim" aria-hidden="true"></label>

          <aside class="sidebar">
            <div class="side-brand">
              <BrandMark size={26} />
              <div class="brand-text">
                <div class="brand-name">{siteName}</div>
                <div class="brand-sub">ADMIN PANEL</div>
              </div>
              <button class="side-collapse" data-collapse type="button" aria-label="Collapse sidebar">
                <Icon name="menu" size={16} />
              </button>
            </div>

            <nav class="nav">
              {NAV.map((it) => {
                const n = it.badge ? counts[it.badge] : undefined;
                return (
                  <a href={it.href} class={`nav-item${active(it.href) ? " on" : ""}`}>
                    <Icon name={it.icon} size={16} />
                    <span class="nav-label">{it.label}</span>
                    {n ? <span class="nav-badge">{n}</span> : null}
                  </a>
                );
              })}
            </nav>

            <div class="side-foot">
              <div class="acct">
                <div class="acct-avatar">A</div>
                <div class="acct-text">
                  <div class="acct-name">Admin</div>
                  <div class="acct-mail">{siteHost}</div>
                </div>
                {props.csrf ? (
                  <form method="post" action="/admin/logout">
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button class="acct-out" type="submit" aria-label="Sign out">
                      <Icon name="log-out" size={15} />
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          </aside>

          <div class="main">
            <header class="topbar">
              <label for="side-open" class="icon-btn hamburger" aria-label="Open menu">
                <Icon name="menu" size={18} />
              </label>
              <div class="topbar-title">{props.title}</div>
              <span class="sys">
                <span class="sys-dot"></span>
                <span class="sys-text">All systems operational</span>
              </span>
              <div class="topbar-right">
                <div class="search-box">
                  <Icon name="search" size={14} />
                  <span>Search...</span>
                </div>
                <a href="/admin/tools" class="btn btn-primary btn-sm">
                  <Icon name="play" size={14} /> Run now
                </a>
                <a
                  href="/admin/alerts"
                  class="icon-btn"
                  aria-label={counts.unread ? `${counts.unread} unread notifications` : "Notifications"}
                >
                  <Icon name="bell" size={17} />
                  {counts.unread ? <span class="notif-badge">{counts.unread > 99 ? "99+" : counts.unread}</span> : null}
                </a>
              </div>
            </header>

            <main class="content">
              {props.flash?.err ? <div class="flash flash-err">{props.flash.err}</div> : null}
              {props.flash?.msg ? <div class="flash flash-ok">{props.flash.msg}</div> : null}
              {props.children as never}
            </main>
          </div>
        </div>
        <script src="/admin.js" defer></script>
      </body>
    </html>
  );
}

export function LoginPage(props: { err?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>Sign in - {siteName} Admin</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href={FONTS} />
        <link rel="stylesheet" href="/admin.css" />
      </head>
      <body>
        <div class="login-page">
          <div class="login-card">
            <div class="login-head">
              <BrandMark size={40} stroke="#111111" />
              <h1 class="login-title">{siteName} Admin</h1>
              <p class="login-sub">Sign in to manage your site</p>
            </div>
            {props.err ? <div class="flash flash-err">{props.err}</div> : null}
            <form method="post" action="/admin/login">
              <label class="eyebrow" for="password">
                Password
              </label>
              <input type="password" id="password" name="password" required autofocus />
              <button type="submit" class="btn">
                Sign in
              </button>
            </form>
            <p class="login-foot">{siteHost} / admin</p>
          </div>
        </div>
      </body>
    </html>
  );
}

export function adminHtml(c: Context<AdminEnv>, node: unknown, status = 200) {
  return c.html(html`<!doctype html>${node as never}`, status as 200);
}

// ── Shared view kit ──────────────────────────────────────────────────────────

// Status pill. label defaults to the raw status; icon picked per status.
const STATUS_ICON: Record<string, string> = {
  ok: "check-circle",
  published: "check-circle",
  failed: "x-circle",
  fail: "x-circle",
  pending: "clock",
  partial: "clock",
  awaiting_review: "clock",
  generating: "refresh",
  running: "refresh",
  skipped: "minus",
  draft: "edit",
};

export function StatusBadge(props: { s: string; label?: string }) {
  const icon = STATUS_ICON[props.s];
  return (
    <span class={`pill pill-${props.s}`}>
      {icon ? <Icon name={icon} size={11} /> : null}
      {props.label ?? props.s}
    </span>
  );
}

export function TriggerBadge(props: { t: string }) {
  return <span class={`pill pill-${props.t}`}>{props.t}</span>;
}

export function Tag(props: { color?: string; children?: unknown }) {
  return <span class={`tag tag-${props.color ?? "zinc"}`}>{props.children as never}</span>;
}

export function CategoryDot(props: { color: string }) {
  return <span class="dot-cat" style={`background:${props.color}`}></span>;
}

export function SectionHead(props: { title: string; sub?: string; children?: unknown }) {
  return (
    <div class="section-head">
      <div>
        <div class="section-title">{props.title}</div>
        {props.sub ? <div class="section-sub">{props.sub}</div> : null}
      </div>
      {props.children ? <div class="section-actions">{props.children as never}</div> : null}
    </div>
  );
}

export function MetricCard(props: {
  eyebrow: string;
  value: string;
  cap?: string;
  icon: string;
  accent?: boolean;
  trend?: "up" | "down" | "flat";
}) {
  const trendIcon =
    props.trend === "up" ? "arrow-up-right" : props.trend === "down" ? "arrow-down-right" : "minus";
  return (
    <div class="metric">
      <div class="metric-top">
        <span class="metric-eyebrow">{props.eyebrow}</span>
        <span class={`metric-ico${props.accent ? " accent" : ""}`}>
          <Icon name={props.icon} size={15} />
        </span>
      </div>
      <div class="metric-val">
        {props.value}
        {props.trend ? (
          <span class={`trend ${props.trend}`}>
            <Icon name={trendIcon} size={14} />
          </span>
        ) : null}
      </div>
      {props.cap ? <div class="metric-cap">{props.cap}</div> : null}
    </div>
  );
}

export function ProgressBar(props: { pct: number; ok?: boolean }) {
  const w = Math.max(0, Math.min(100, props.pct));
  return (
    <div class="progress">
      <span class={props.ok ? "ok" : ""} style={`width:${w}%`}></span>
    </div>
  );
}

// Labeled meter: caption + left/right values over a progress bar. `danger`
// switches the bar red past 100%; `ok` renders emerald when under budget.
export function Meter(props: {
  label: string;
  left: string;
  right: string;
  pct: number;
  ok?: boolean;
}) {
  const over = props.pct >= 100;
  return (
    <div class="meter">
      <div class="meter-top">
        <span class="meter-label">{props.label}</span>
        <span class="meter-val">
          <b class={over ? "neg" : ""}>{props.left}</b> / {props.right}
        </span>
      </div>
      <ProgressBar pct={props.pct} ok={props.ok && !over} />
    </div>
  );
}

export function EmptyState(props: { icon: string; title: string; sub?: string }) {
  return (
    <div class="empty">
      <div class="ico">
        <Icon name={props.icon} size={30} />
      </div>
      <div class="t">{props.title}</div>
      {props.sub ? <div class="s">{props.sub}</div> : null}
    </div>
  );
}

// ── Charts (server-rendered inline SVG; no client JS) ────────────────────────

// Vertical bars. data.value drives height; data.title is the hover tooltip.
export function BarChartSVG(props: {
  data: { label: string; value: number; title?: string }[];
  height?: number;
}) {
  const data = props.data;
  if (!data.length) return <p class="muted">No data yet.</p>;
  const W = 640;
  const H = props.height ?? 150;
  const pad = { l: 6, r: 6, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = data.length;
  const step = iw / n;
  const bw = Math.min(40, step * 0.6);
  const every = Math.ceil(n / 6);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        <line x1={pad.l} y1={pad.t + ih} x2={W - pad.r} y2={pad.t + ih} stroke="#e4e4e7" />
        {data.map((d, i) => {
          const h = (d.value / max) * ih;
          const x = pad.l + i * step + (step - bw) / 2;
          const y = pad.t + ih - h;
          return (
            <>
              <rect x={x} y={y} width={bw} height={Math.max(0, h)} rx="2" fill="#3b82f6">
                <title>{d.title ?? `${d.label}: ${d.value}`}</title>
              </rect>
              {i % every === 0 ? (
                <text x={x + bw / 2} y={H - 6} text-anchor="middle" font-size="9" fill="#a1a1aa" font-family="monospace">
                  {d.label}
                </text>
              ) : null}
            </>
          );
        })}
      </svg>
    </div>
  );
}

// Dual-series line chart (each series normalized to its own max).
export function LineChartSVG(props: {
  data: { label: string; a: number; b: number }[];
  aColor?: string;
  bColor?: string;
}) {
  const data = props.data;
  if (!data.length) return <p class="muted">No data yet.</p>;
  const aColor = props.aColor ?? "#3b82f6";
  const bColor = props.bColor ?? "#10b981";
  const W = 640;
  const H = 160;
  const pad = { l: 6, r: 6, t: 12, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = data.length;
  const maxA = Math.max(1, ...data.map((d) => d.a));
  const maxB = Math.max(1, ...data.map((d) => d.b));
  const xi = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yA = (v: number) => pad.t + ih - (v / maxA) * ih;
  const yB = (v: number) => pad.t + ih - (v / maxB) * ih;
  const line = (sel: "a" | "b", y: (v: number) => number) =>
    data.map((d, i) => `${xi(i)},${y(d[sel])}`).join(" ");
  const every = Math.ceil(n / 6);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        <line x1={pad.l} y1={pad.t + ih} x2={W - pad.r} y2={pad.t + ih} stroke="#e4e4e7" />
        <polyline points={line("a", yA)} fill="none" stroke={aColor} stroke-width="2" />
        <polyline points={line("b", yB)} fill="none" stroke={bColor} stroke-width="2" />
        {data.map((d, i) => (
          <>
            <circle cx={xi(i)} cy={yA(d.a)} r="2.5" fill={aColor} />
            <circle cx={xi(i)} cy={yB(d.b)} r="2.5" fill={bColor} />
            {i % every === 0 ? (
              <text x={xi(i)} y={H - 6} text-anchor="middle" font-size="9" fill="#a1a1aa" font-family="monospace">
                {d.label}
              </text>
            ) : null}
          </>
        ))}
      </svg>
    </div>
  );
}

// ── formatting helpers ───────────────────────────────────────────────────────

export function StatusIconOnly(props: { ok: boolean }) {
  return props.ok ? (
    <span class="score-hi"><Icon name="check-circle" size={14} /></span>
  ) : (
    <span class="neg"><Icon name="x-circle" size={14} /></span>
  );
}

// Score color class by threshold (default thresholds hi>=8, mid>=7).
export function scoreClass(n: number | null | undefined, hi = 8, mid = 7): string {
  if (n == null) return "score-lo";
  return n >= hi ? "score-hi" : n >= mid ? "score-mid" : "score-lo";
}

// Admin timestamps display in VN time (GMT+7); stored values are UTC. We shift
// the instant by +7h then format the UTC string, and tag it "+7" so it is
// unambiguous. (Machine timestamps - sitemap/RSS/OG - stay UTC in src/lib/dates.)
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function fmtTs(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(5, 16).replace("T", " ") + " +7";
}

export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso.slice(5, 16).replace("T", " ") + " +7";
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(5, 16).replace("T", " ") + " +7";
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function usd(micros: number | null | undefined): string {
  return `$${((micros ?? 0) / 1e6).toFixed(4)}`;
}

// Compact token/count formatting: 950 -> "950", 12_300 -> "12.3K", 4_500_000 -> "4.5M".
export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
