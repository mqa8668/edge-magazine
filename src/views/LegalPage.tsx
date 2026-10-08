import type { Child } from "hono/jsx";
import { Icon } from "./icons";
import { Breadcrumb } from "./components";
import type { BreadcrumbItem } from "../seo/structured-data";

// The legal documents, shown as a sticky sidebar of tabs. Each is a real
// URL (zero-JS): the active one is highlighted, the others link across.
export const LEGAL_DOCS: {
  slug: string;
  path: string;
  label: string;
  icon: string;
}[] = [
  { slug: "privacy", path: "/privacy", label: "Privacy policy", icon: "shield" },
  { slug: "terms", path: "/terms", label: "Terms of use", icon: "book-open" },
  {
    slug: "cookie-policy",
    path: "/cookie-policy",
    label: "Cookie policy",
    icon: "circle-check",
  },
];

// Shown on every legal page: the copy is a generic starter, not legal advice.
export function TemplateBanner() {
  return (
    <p class="template-banner" role="note" id="template-banner">
      Template text: replace before launch. This is not legal advice.
    </p>
  );
}

export function LegalPageView({
  activeSlug,
  title,
  breadcrumb,
  updated,
  children,
}: {
  activeSlug: string;
  title: string;
  breadcrumb: BreadcrumbItem[];
  updated: string;
  children: Child;
}) {
  return (
    <div class="container legal-layout">
      <aside class="legal-sidebar">
        <div class="legal-sidebar__sticky">
          <div class="side-head">
            <Icon name="shield" size={12} />
            <span>Legal</span>
          </div>
          <nav class="legal-nav" aria-label="Legal documents">
            {LEGAL_DOCS.map((d) => {
              const active = d.slug === activeSlug;
              return (
                <a
                  class={active ? "legal-nav__link is-active" : "legal-nav__link"}
                  href={d.path}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon name={d.icon} size={14} />
                  <span>{d.label}</span>
                </a>
              );
            })}
          </nav>
          <p class="legal-sidebar__updated mono">Updated: {updated}</p>
        </div>
      </aside>

      <article class="legal-content prose">
        <Breadcrumb items={breadcrumb} />
        <h1>{title}</h1>
        <TemplateBanner />
        {children}
      </article>
    </div>
  );
}
