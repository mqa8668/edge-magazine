import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import { getNavCategories } from "../db/queries";
import { siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { Breadcrumb } from "../views/components";
import { TemplateBanner } from "../views/LegalPage";
import * as ld from "../seo/structured-data";

export interface PageCtx {
  name: string; // site name
  email: string; // contact email, empty when not configured
}

interface StaticPage {
  slug: string;
  title: string;
  description: string;
  legal?: boolean; // shows the "template text" banner
  body: (ctx: PageCtx) => Child;
}

// Contact line used across pages; renders nothing useful when no mailbox is set.
function Mail({ email, fallback }: { email: string; fallback?: string }) {
  return email ? (
    <a href={`mailto:${email}`}>{email}</a>
  ) : (
    <>{fallback ?? "the contact address listed on this site"}</>
  );
}

// Generic starter copy for a self-hosted magazine. Legal pages are TEMPLATES:
// they are flagged with a visible banner and must be reviewed before launch.
export const STATIC_PAGES: Record<string, StaticPage> = {
  about: {
    slug: "about",
    title: "About",
    description:
      "About this independent online magazine: what we publish, how it is made, and how to reach us.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          {name} is an independent online magazine. We publish practical,
          readable articles that are easy to apply, and we are open about how
          they are made.
        </p>

        <h2>What we believe</h2>
        <p>
          Good writing respects the reader's time. We prefer plain language to
          jargon, honesty to sensationalism, and clear caveats to confident
          guesses. If the evidence behind an idea is weak, we say so.
        </p>

        <h2>How we work</h2>
        <p>
          Articles on {name} are drafted with the help of large language models
          (LLMs), following a written set of editorial standards, and pass
          automated quality checks before publication. Depending on how the
          site is configured, drafts may also be reviewed by a human editor
          before they go live. The author names on articles are AI editorial
          desks, not real individuals. Read the details in our{" "}
          <a href="/editorial-standards">Editorial standards</a>.
        </p>
        <p>
          Content here is for general information only and does not replace
          professional medical, psychological, legal or financial advice.
        </p>

        {email ? (
          <>
            <h2>Contact</h2>
            <p>
              Questions, corrections or feedback are welcome at{" "}
              <Mail email={email} />.
            </p>
          </>
        ) : null}
      </>
    ),
  },
  "editorial-standards": {
    slug: "editorial-standards",
    title: "Editorial standards",
    description:
      "How content is made: drafts may be produced with LLM assistance, reviewed by a human before publication, and authored by AI editorial desks.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          You trust what you read on {name}, and we treat that as a
          responsibility. This page says plainly how our content is made so you
          know what you are reading.
        </p>

        <h2>How content is made</h2>
        <p>
          Articles on {name} may be drafted with the assistance of large
          language models (LLMs). Drafts follow a written editorial standard
          covering voice, topic scope, length and structure. After a draft is
          generated it goes through automated checks for quality, structure,
          language and safety.
        </p>

        <h2>Human review</h2>
        <p>
          When the site runs in review mode, every draft is held in a queue and
          a human editor reviews it before it is published. Nothing is
          published until it has been approved. If a site operator turns on
          automatic publishing, the automated checks above remain in place and
          the operator is responsible for the result.
        </p>

        <h2>Author desks are AI personas</h2>
        <p>
          The author names shown on articles are AI editorial desks. Each desk
          has its own voice and subject area. They are editorial pen names, not
          real people, and their bios do not describe real individuals.
        </p>

        <h2>Sources and evidence</h2>
        <p>
          Articles may mention studies, figures or examples. Because the text is
          produced with AI assistance, treat these as a starting point for your
          own reading rather than as verified academic citations. Where a
          question is contested, we try to say so rather than present a single
          answer as settled.
        </p>

        <h2>Limits, updates and corrections</h2>
        <p>
          Machine-assisted writing can contain errors or fall out of date. Our
          articles are not professional medical, psychological, legal or
          financial advice.
          {email ? (
            <>
              {" "}
              If you spot a mistake, tell us at <Mail email={email} /> and we
              will review and correct it.
            </>
          ) : null}
        </p>

        <div class="prose-note">
          <p>
            {name} does not publish advertising disguised as articles. Any
            sponsored content is labeled clearly.
          </p>
        </div>
      </>
    ),
  },
  contact: {
    slug: "contact",
    title: "Contact",
    description: "How to get in touch with the editorial team.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          We would like to hear from you, whether it is a question, a
          correction or a thank-you.
        </p>

        {email ? (
          <>
            <h2>Email</h2>
            <p>
              Write to <Mail email={email} />. Include the link to the article
              you are writing about, if any. For pitches see{" "}
              <a href="/write-for-us">Write for us</a>; for copyright notices see
              the <a href="/dmca">DMCA policy</a>.
            </p>

            <h2>Response time</h2>
            <p>
              {name} is run by a small team, so replies can take a few working
              days.
            </p>
          </>
        ) : (
          <p>
            No public contact address has been configured for {name} yet.
          </p>
        )}
      </>
    ),
  },
  privacy: {
    slug: "privacy",
    title: "Privacy policy",
    legal: true,
    description:
      "How this site collects, uses and protects your data, and the rights you have over it.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          This policy explains what information {name} collects when you visit
          the site or subscribe to the newsletter, and how it is used.
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Newsletter:</strong> your email address, if you subscribe.
          </li>
          <li>
            <strong>Usage data:</strong> standard request data such as IP
            address, browser type, pages viewed and referrer, collected by our
            hosting provider and, if enabled, analytics tools.
          </li>
          <li>
            <strong>Cookies:</strong> see the <a href="/cookie-policy">Cookie
            policy</a>.
          </li>
        </ul>

        <h2>How we use information</h2>
        <p>
          We use it to deliver the site, send the newsletter you asked for,
          understand how the site is used, prevent abuse and keep the service
          secure. We do not sell your personal data.
        </p>

        <h2>Cookies and similar technologies</h2>
        <p>
          The site may use cookies or similar technologies for analytics,
          security and, if enabled, advertising. See the{" "}
          <a href="/cookie-policy">Cookie policy</a> for details and choices.
        </p>

        <h2>Sharing data</h2>
        <p>
          We share data only with service providers that help us run the site
          (for example hosting, email delivery, bot protection and analytics),
          and when required by law.
        </p>

        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access,
          correct, delete or export your personal data, or to object to its
          processing. You can unsubscribe from the newsletter at any time using
          the link in every email.
          {email ? (
            <>
              {" "}
              To make a request, contact <Mail email={email} />.
            </>
          ) : null}
        </p>

        <h2>Data security</h2>
        <p>
          We use reasonable technical measures to protect your data, but no
          system is completely secure.
        </p>

        <p class="prose-updated">Last updated: [date]</p>
      </>
    ),
  },
  terms: {
    slug: "terms",
    title: "Terms of use",
    legal: true,
    description: "The terms that govern your use of this website and its content.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          By using {name} you agree to these terms. If you do not agree, please
          do not use the site.
        </p>

        <h2>Acceptance of terms</h2>
        <p>
          Using the site means you accept these terms and our{" "}
          <a href="/privacy">Privacy policy</a>.
        </p>

        <h2>Use of content</h2>
        <p>
          You may read and share links to our articles. You may not copy,
          republish or scrape the content at scale without permission, or use
          the site in a way that harms it or other users.
        </p>

        <h2>AI-assisted content</h2>
        <p>
          Articles are produced with AI assistance and may contain errors. See
          our <a href="/editorial-standards">Editorial standards</a>. Author
          names are AI editorial desks, not real people.
        </p>

        <h2>Not professional advice</h2>
        <p>
          Content is for general information only. It is not medical,
          psychological, legal or financial advice. Consult a qualified
          professional about your situation.
        </p>

        <h2>Newsletter</h2>
        <p>
          If you subscribe, you can unsubscribe at any time using the link in
          each email.
        </p>

        <h2>Intellectual property</h2>
        <p>
          The site design and original content belong to {name} or its
          licensors unless stated otherwise. Third-party trademarks belong to
          their owners.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          The site and its content are provided "as is" without warranties. To
          the extent permitted by law, {name} is not liable for losses arising
          from your use of the site or reliance on its content.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Continued use of the
          site means you accept the updated terms.
          {email ? (
            <>
              {" "}
              Questions: <Mail email={email} />.
            </>
          ) : null}
        </p>

        <p class="prose-updated">Last updated: [date]</p>
      </>
    ),
  },
  "write-for-us": {
    slug: "write-for-us",
    title: "Write for us",
    description: "How to pitch an article to the editorial team.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          Have a useful perspective to share? {name} is open to thoughtful
          contributions.
        </p>

        <h2>What we look for</h2>
        <ul>
          <li>Practical articles grounded in evidence or real experience.</li>
          <li>Clear, plain writing that respects the reader's time.</li>
          <li>Original work that has not been published elsewhere.</li>
        </ul>

        <h2>How to pitch</h2>
        {email ? (
          <p>
            Send a short outline (one page at most) with your topic, the key
            points and why it helps readers to <Mail email={email} />. If you
            have published before, include a few links.
          </p>
        ) : (
          <p>No pitch address has been configured for this site yet.</p>
        )}

        <h2>Editorial process</h2>
        <p>
          Every article goes through our editorial process, described in the{" "}
          <a href="/editorial-standards">Editorial standards</a>. We do not
          publish advertising disguised as articles.
        </p>
      </>
    ),
  },
  "cookie-policy": {
    slug: "cookie-policy",
    title: "Cookie policy",
    legal: true,
    description:
      "How this site uses cookies and similar technologies, and how you can control them.",
    body: ({ name }) => (
      <>
        <p class="lead">
          This policy explains how {name} uses cookies and similar technologies.
        </p>

        <h2>What cookies are</h2>
        <p>
          Cookies are small text files stored on your device by your browser.
          They help a site remember information about your visit.
        </p>

        <h2>Why we use them</h2>
        <p>
          To keep the site working and secure, to understand how it is used
          and, if enabled by the operator, to measure or serve advertising.
        </p>

        <h2>Types of cookies</h2>
        <ul>
          <li>
            <strong>Essential:</strong> needed for security and core features.
          </li>
          <li>
            <strong>Analytics:</strong> aggregate usage statistics, if enabled.
          </li>
          <li>
            <strong>Advertising:</strong> only if the operator enables ads.
          </li>
        </ul>

        <h2>Third-party cookies</h2>
        <p>
          Analytics, advertising or bot-protection providers may set their own
          cookies, governed by their own policies.
        </p>

        <h2>Managing your choices</h2>
        <p>
          You can block or delete cookies in your browser settings. Blocking
          some cookies may affect how parts of the site work.
        </p>

        <h2>Changes to this policy</h2>
        <p>We may update this policy from time to time.</p>

        <p class="prose-updated">Last updated: [date]</p>
      </>
    ),
  },
  dmca: {
    slug: "dmca",
    title: "DMCA policy",
    legal: true,
    description: "How to submit a copyright takedown notice for content on this site.",
    body: ({ name, email }) => (
      <>
        <p class="lead">
          {name} respects intellectual property rights and responds to valid
          copyright notices.
        </p>

        <h2>Submitting a notice</h2>
        {email ? (
          <p>
            Send a notice to <Mail email={email} /> that includes: your contact
            details; a description of the copyrighted work; the URL of the
            material you say infringes it; a statement that you believe in good
            faith the use is not authorized; and a statement, under penalty of
            perjury, that the information is accurate and that you are the
            owner or authorized to act for the owner. Include your physical or
            electronic signature.
          </p>
        ) : (
          <p>
            No copyright contact address has been configured for this site
            yet.
          </p>
        )}

        <h2>After we receive a notice</h2>
        <p>
          We review notices and may remove or disable access to the material.
          We may forward the notice to the person who published the content.
        </p>

        <h2>Counter-notice</h2>
        <p>
          If you believe material was removed by mistake, you may send a
          counter-notice with your contact details, the location of the removed
          material, and a statement under penalty of perjury that you believe
          the removal was a mistake.
        </p>

        <p class="prose-updated">Last updated: [date]</p>
      </>
    ),
  },
};

export function staticPageRoute(slug: string) {
  return async (c: Context<AppEnv>) => {
    const pageDef = STATIC_PAGES[slug];
    if (!pageDef) return c.notFound();

    return withEdgeCache(c, TTL.navStatic, async () => {
      const site = siteConfig(c.env, new URL(c.req.url).origin);
      const nav = await getNavCategories(db(c.env.DB));
      const path = `/${pageDef.slug}`;
      const breadcrumb = [
        { name: "Home", url: site.url },
        { name: pageDef.title, url: `${site.url}${path}` },
      ];

      const meta = {
        title: pageTitle(site, pageDef.title),
        description: pageDef.description,
        canonical: `${site.url}${path}`,
        ogType: "website" as const,
        jsonLd: [ld.breadcrumb(breadcrumb)],
      };

      const body = (
        <article class="prose">
          <Breadcrumb items={breadcrumb} />
          <h1>{pageDef.title}</h1>
          {pageDef.legal ? <TemplateBanner /> : null}
          {pageDef.body({ name: site.name, email: site.contactEmail })}
        </article>
      );

      return renderPage(c, { site, meta, nav, body });
    });
  };
}
