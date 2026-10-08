import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { SiteConfig } from "../lib/config";
import { routes } from "../lib/config";
import { Head, type PageMeta } from "./Head";
import { Icon, LogoMark } from "./icons";

export interface NavCategory {
  slug: string;
  name: string;
}

// Latest published article for the top-bar "MOI:" ticker (from getBreakingPost).
export interface BreakingPost {
  title: string;
  slug: string;
  categorySlug: string;
}

interface LayoutProps {
  site: SiteConfig;
  meta: PageMeta;
  nav: NavCategory[];
  currentPath?: string;
  bare?: boolean; // full-bleed page: skip the .container wrapper on <main>
  breaking?: BreakingPost | null; // top-bar latest-article ticker
  children?: Child;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Dateline for the top bar, e.g. "SATURDAY, JULY 4, 2026". Built by hand (not
// toLocaleDateString) so output does not depend on the runtime's ICU data.
// Uses UTC.
function topbarDate(): string {
  const d = new Date();
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`.toUpperCase();
}

// Compact date for narrow screens, e.g. "FRI, 07.10" - the full dateline would
// crowd out the ticker on mobile.
function topbarDateShort(): string {
  const d = new Date();
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3).toUpperCase()}, ${mm}.${dd}`;
}

// The ticker scrolls the full headline; cap only pathological lengths so the
// loop width stays bounded.
function breakingLabel(title: string): string {
  const t = title.trim();
  return t.length > 120 ? `NEW: ${t.slice(0, 119).trimEnd()}...` : `NEW: ${t}`;
}

export function Layout({
  site,
  meta,
  nav,
  currentPath,
  bare,
  breaking,
  children,
}: LayoutProps) {
  return (
    <html lang="en">
      <Head site={site} meta={meta} />
      <body>
        {site.gtmId ? (
          <noscript
            dangerouslySetInnerHTML={{
              __html: raw(
                `<iframe src="https://www.googletagmanager.com/ns.html?id=${site.gtmId}" height="0" width="0" style="display:none;visibility:hidden"></iframe>`,
              ) as unknown as string,
            }}
          />
        ) : null}

        <a class="skip-link" href="#main">
          Skip to content
        </a>

        {/* Top strip: date | latest-article ticker | utility links */}
        <div class="topbar">
          <div class="topbar__inner">
            <div class="topbar__left">
              <span class="topbar__date topbar__date--full">
                {topbarDate()}
              </span>
              <span class="topbar__date topbar__date--short">
                {topbarDateShort()}
              </span>
              {breaking ? (
                <>
                  <span class="topbar__sep" aria-hidden="true">
                    |
                  </span>
                  <a
                    class="topbar__breaking"
                    href={routes.post(breaking.categorySlug, breaking.slug)}
                  >
                    <span class="topbar__pulse" aria-hidden="true" />
                    {/* Two copies make the CSS loop seamless; the second is
                        decorative only. */}
                    <span class="topbar__ticker">
                      <span class="topbar__ticker-track">
                        <span class="topbar__ticker-item">
                          {breakingLabel(breaking.title)}
                        </span>
                        <span class="topbar__ticker-item" aria-hidden="true">
                          {breakingLabel(breaking.title)}
                        </span>
                      </span>
                    </span>
                  </a>
                </>
              ) : null}
            </div>
            <nav class="topbar__links" aria-label="Utility">
              <a href={routes.clusters()}>Topics</a>
              <a href={routes.newsletter()}>Newsletter</a>
              <a href="/about">About</a>
            </nav>
          </div>
        </div>

        {/* Header. The checkbox drives the zero-JS mobile menu (label toggles
            it; CSS shows .mobile-nav and swaps the burger/close icon). */}
        <header class="site-header">
          <input
            type="checkbox"
            id="nav-toggle"
            class="nav-toggle"
            aria-label="Open category menu"
          />
          <div class="container site-header__inner">
            <a class="site-logo" href={routes.home()} aria-label={site.name}>
              <LogoMark size={26} letter={site.name} />
              <span class="site-logo__word">{site.name}</span>
            </a>
            <nav class="site-nav" aria-label="Categories">
              <a
                href={routes.home()}
                class={currentPath === "/" ? "is-active" : undefined}
              >
                All
              </a>
              {nav.map((c) => {
                const href = routes.category(c.slug);
                const active = currentPath === href;
                return (
                  <a href={href} class={active ? "is-active" : undefined}>
                    {c.name}
                  </a>
                );
              })}
            </nav>
            <div class="site-actions">
              {/* Zero-JS expanding search: label focuses the input, form submits on Enter */}
              <form class="site-search" action={routes.search()} method="get" role="search">
                <label
                  class="site-search__icon"
                  for="site-search-input"
                  aria-label="Search"
                >
                  <Icon name="search" size={16} />
                </label>
                <input
                  id="site-search-input"
                  type="search"
                  name="q"
                  placeholder="Search articles..."
                  aria-label="Search"
                  minlength={2}
                />
              </form>
              <a class="btn-subscribe" href={routes.newsletter()}>
                <Icon name="bell" size={11} /> Subscribe
              </a>
              <label class="nav-burger" for="nav-toggle" aria-hidden="true">
                <span class="nav-burger__open">
                  <Icon name="menu" size={18} />
                </span>
                <span class="nav-burger__close">
                  <Icon name="x" size={18} />
                </span>
              </label>
            </div>
          </div>

          {/* Mobile category pills (Figma mobile menu) */}
          <nav class="container mobile-nav" aria-label="Categories">
            <a
              class={currentPath === "/" ? "pill is-active" : "pill"}
              href={routes.home()}
            >
              All
            </a>
            {nav.map((c) => {
              const href = routes.category(c.slug);
              return (
                <a
                  class={currentPath === href ? "pill is-active" : "pill"}
                  href={href}
                >
                  {c.name}
                </a>
              );
            })}
          </nav>
        </header>

        <main
          id="main"
          class={bare ? "site-main site-main--bare" : "container site-main"}
        >
          {children}
        </main>

        {/* Footer */}
        <footer class="site-footer">
          <div class="container site-footer__inner">
            <div class="footer-grid">
              <div class="footer-brand">
                <a
                  class="footer-brand__logo"
                  href={routes.home()}
                  aria-label={site.name}
                >
                  <LogoMark size={24} letter={site.name} />
                  <span class="footer-brand__name">{site.name}</span>
                </a>
                <p>
                  {site.description}
                </p>
              </div>
              <div class="footer-col footer-col--topics">
                <h5>Topics</h5>
                <ul>
                  {nav.map((c) => (
                    <li>
                      <a href={routes.category(c.slug)}>{c.name}</a>
                    </li>
                  ))}
                </ul>
              </div>
              <div class="footer-col">
                <h5>About</h5>
                <ul>
                  <li>
                    <a href={routes.clusters()}>Deep dives</a>
                  </li>
                  <li>
                    <a href="/about">About</a>
                  </li>
                  <li>
                    <a href={routes.newsletter()}>Newsletter</a>
                  </li>
                  {site.contactEmail ? (
                    <>
                      <li>
                        <a href="/write-for-us">Write for us</a>
                      </li>
                      <li>
                        <a href="/contact">Contact</a>
                      </li>
                    </>
                  ) : null}
                  <li>
                    <a href="/editorial-standards">Editorial standards</a>
                  </li>
                </ul>
              </div>
              <div class="footer-col">
                <h5>Legal</h5>
                <ul>
                  <li>
                    <a href="/privacy">Privacy policy</a>
                  </li>
                  <li>
                    <a href="/terms">Terms of use</a>
                  </li>
                  <li>
                    <a href="/cookie-policy">Cookie policy</a>
                  </li>
                </ul>
              </div>
            </div>
            <div class="footer-bottom">
              <span>
                © {new Date().getUTCFullYear()} {site.name}.
                {site.contactEmail ? (
                  <>
                    {" "}
                    Contact{" "}
                    <a href={`mailto:${site.contactEmail}`}>
                      {site.contactEmail}
                    </a>
                    .
                  </>
                ) : null}
              </span>
              <div class="footer-bottom__meta">
                <span class="footer-powered">
                  Built with{" "}
                  <a
                    href="https://github.com/mqa8668/edge-magazine"
                    target="_blank"
                    rel="noopener"
                  >
                    edge-magazine
                  </a>
                </span>
              </div>
            </div>
            <p class="footer-disclosure">
              {site.name} is an independent online magazine. Articles are drafted
              with AI assistance and reviewed under our{" "}
              <a href="/editorial-standards">editorial standards</a>; author
              names are AI editorial desks, not individual people. Content is
              for general information and does not replace professional medical,
              psychological or financial advice. See our{" "}
              <a href="/terms">Terms of use</a>.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
