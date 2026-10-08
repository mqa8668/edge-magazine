// Admin pages: review (approve/reject held drafts), posts, config form, the LLM
// gateway console, and operational tools. Pure SSR forms; the shared view kit +
// public/admin.css supply the redesigned chrome. All UI copy is English
// (admin chrome).

import type { ConfigAuditRow, ContentQueueItem, LlmCall } from "../db/schema";
import type { RuntimeConfig } from "../lib/runtime-config";
import { raw } from "hono/html";
import { cleanHtml } from "../lib/sanitize";
import type { DailyCost, GatewayStatus, ProviderStatus } from "./data";
import { builtinAllowPhrases, builtinBlacklist, type SafetyGroup } from "../pipeline/safety";
import { ARTICLE_TYPE_HINTS, FORMULA_CARDS } from "../pipeline/prompts";
import { Icon } from "./icons";
import {
  EmptyState,
  LineChartSVG,
  Meter,
  MetricCard,
  ProgressBar,
  SectionHead,
  StatusBadge,
  Tag,
  fmtIso,
  fmtMs,
  fmtTs,
  scoreClass,
  usd,
} from "./ui";

// Shape stored in content_queue.draft_json while an item awaits review.
export interface HeldDraft {
  title: string;
  excerpt: string;
  bodyHtml: string;
  metaTitle: string;
  metaDescription: string;
  tags: string[];
  imageQuery: string;
}

export function parseHeldDraft(json: string | null): HeldDraft | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<HeldDraft>;
    if (!o.title || !o.bodyHtml) return null;
    return {
      title: o.title,
      excerpt: o.excerpt ?? "",
      bodyHtml: o.bodyHtml,
      metaTitle: o.metaTitle ?? "",
      metaDescription: o.metaDescription ?? "",
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
      imageQuery: o.imageQuery ?? "",
    };
  } catch {
    return null;
  }
}

// ── Review ───────────────────────────────────────────────────────────────────

export function ReviewPage(props: { items: ContentQueueItem[]; reviewMode: boolean }) {
  return (
    <div class="stack-lg">
      {props.reviewMode ? (
        <div class="flash flash-ok">
          <b>publish.mode: review</b> - new posts are held here for manual review.
        </div>
      ) : (
        <div class="flash flash-warn">
          <b>publish.mode: auto</b> - new posts publish automatically and do not stop here. Switch to
          {" "}<b>review</b> on the <a href="/admin/config">Config</a> page if you want to review manually.
        </div>
      )}

      <SectionHead title="Drafts awaiting review" sub={`${props.items.length} posts awaiting review`} />

      {props.items.length ? (
        <div class="stack">
          {props.items.map((q) => {
            const score = q.qualityScore;
            return (
              <div class="review-card">
                <div class="review-meta">
                  <Tag color="blue">{q.categorySlug}</Tag>
                  <span class="mono">{q.personaSlug ?? "-"}</span>
                  <span>-</span>
                  <span>Updated: {fmtIso(q.updatedAt ?? q.createdAt)}</span>
                  {score != null ? (
                    <>
                      <span>-</span>
                      <span class={scoreClass(score)}>Score: {score}/10</span>
                    </>
                  ) : null}
                </div>
                <div class="review-topic">{q.topic}</div>
                <div class="review-foot">
                  {score != null ? (
                    <>
                      <span class="field-hint">Quality</span>
                      <ProgressBar pct={score * 10} ok />
                      <span class="mono" style="font-size:12px">{score} / 10</span>
                    </>
                  ) : (
                    <span class="field-hint">No critic score yet</span>
                  )}
                  <a href={`/admin/review/${q.id}`} class="btn btn-primary btn-sm">
                    <Icon name="eye" size={14} /> View + review
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div class="card">
          <EmptyState icon="check-square" title="No drafts awaiting review" sub="Everything has been handled or is running on auto-publish." />
        </div>
      )}
    </div>
  );
}

export function ReviewDetailPage(props: { item: ContentQueueItem; draft: HeldDraft | null; csrf: string }) {
  const { item, draft, csrf } = props;
  return (
    <div class="stack-lg">
      <a href="/admin/review" class="muted" style="font-size:12px">&lt;- Drafts awaiting review</a>

      <div class="card">
        <div class="review-meta">
          <b>#{item.id}</b>
          <Tag color="blue">{item.categorySlug}</Tag>
          <span class="mono">{item.personaSlug ?? "?"}</span>
          <StatusBadge s={item.status} />
          {item.qualityScore != null ? (
            <span class={scoreClass(item.qualityScore)}>Critic score: {item.qualityScore}/10</span>
          ) : null}
        </div>
        <div class="review-topic" style="margin-bottom:0">{item.topic}</div>
      </div>

      {draft ? (
        <>
          <div class="form-row">
            <form method="post" action={`/admin/review/${item.id}/approve`}>
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-success"><Icon name="check-circle" size={15} /> Approve + publish</button>
            </form>
            <form method="post" action={`/admin/review/${item.id}/reject`} class="form-row">
              <input type="hidden" name="csrf" value={csrf} />
              <input type="text" name="reason" placeholder="rejection reason (optional)" />
              <button type="submit" class="btn btn-danger"><Icon name="x-circle" size={15} /> Reject</button>
            </form>
          </div>

          <div class="cols-3">
            <div class="prose">
              <h2 style="margin-top:0">{draft.title}</h2>
              <p><i>{draft.excerpt}</i></p>
              {/* Draft body was model-generated; sanitize again before preview. */}
              <div>{raw(cleanHtml(draft.bodyHtml))}</div>
            </div>
            <div class="card">
              <div class="card-title" style="margin-bottom:12px">Meta</div>
              <p class="field-hint">meta title</p>
              <p style="margin-top:2px">{draft.metaTitle || "-"}</p>
              <p class="field-hint">meta description</p>
              <p style="margin-top:2px">{draft.metaDescription || "-"}</p>
              <p class="field-hint">tags</p>
              <p style="margin-top:2px">{draft.tags.join(", ") || "-"}</p>
              <p class="field-hint">image query</p>
              <p style="margin-top:2px">{draft.imageQuery || "-"}</p>
            </div>
          </div>
        </>
      ) : (
        <div class="flash flash-err">
          This item has no valid draft_json and cannot be approved. You can reject it to set its status to failed.
        </div>
      )}
    </div>
  );
}

// ── Posts ────────────────────────────────────────────────────────────────────

export function PostsPage(props: {
  posts: {
    id: number;
    slug: string;
    title: string;
    categorySlug: string;
    categoryName: string;
    publishedAt: string;
    isFeatured: number;
    viewCount: number;
    wordCount: number | null;
  }[];
  csrf: string;
}) {
  const { csrf } = props;
  return (
    <div class="stack-lg">
      <SectionHead title="Manage posts" sub={`${props.posts.length} posts`}>
        <div class="search-box" style="display:flex">
          <Icon name="search" size={14} />
          <input type="search" id="posts-search" placeholder="Search by title / category..." />
        </div>
      </SectionHead>

      <p class="field-hint">
        Unpublish = remove from the published projection (posts table). The queue ledger and R2 images are kept. This cannot be undone.
      </p>

      <div class="tbl-wrap">
        <table class="tbl">
          <tr>
            <th>Post</th>
            <th>Category</th>
            <th>Published</th>
            <th class="num">Words</th>
            <th class="num">Views</th>
            <th>Featured</th>
            <th>Actions</th>
          </tr>
          {props.posts.map((p) => (
            <tr data-post-row data-search={`${p.title} ${p.categoryName}`.toLowerCase()}>
              <td>
                <a href={`/${p.categorySlug}/${p.slug}`} target="_blank" rel="noreferrer">{p.title}</a>
              </td>
              <td>{p.categoryName}</td>
              <td class="mono">{fmtIso(p.publishedAt)}</td>
              <td class="num">{p.wordCount ?? "-"}</td>
              <td class="num">{p.viewCount}</td>
              <td>{p.isFeatured ? <Tag color="amber">featured</Tag> : ""}</td>
              <td>
                <div class="row-actions">
                  <form method="post" action={`/admin/posts/${p.id}/feature`}>
                    <input type="hidden" name="csrf" value={csrf} />
                    <button class="btn btn-outline btn-sm" type="submit">{p.isFeatured ? "Unfeature" : "Feature"}</button>
                  </form>
                  <form method="post" action={`/admin/posts/${p.id}/purge`}>
                    <input type="hidden" name="csrf" value={csrf} />
                    <button class="btn btn-outline btn-sm" type="submit">Purge</button>
                  </form>
                  <form method="post" action={`/admin/posts/${p.id}/delete`} class="row-actions">
                    <input type="hidden" name="csrf" value={csrf} />
                    <label style="font-size:12px;display:inline-flex;align-items:center;gap:4px">
                      <input type="checkbox" name="confirm" /> sure
                    </label>
                    <button class="btn btn-danger btn-sm" type="submit"><Icon name="trash" size={13} /> Unpublish</button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </table>
        <div id="posts-empty" class="empty" style="display:none">
          <div class="t">No posts found</div>
        </div>
      </div>
    </div>
  );
}

// ── Config ───────────────────────────────────────────────────────────────────

function Field(props: { label: string; hint?: string; children?: unknown }) {
  return (
    <div class="field">
      <div class="field-info">
        <div class="field-label">{props.label}</div>
        {props.hint ? <div class="field-hint">{props.hint}</div> : null}
      </div>
      <div class="field-control">{props.children as never}</div>
    </div>
  );
}

function Switch(props: { name: string; checked: boolean }) {
  return (
    <label class="switch">
      <input type="checkbox" name={props.name} checked={props.checked} />
      <span class="track"></span>
    </label>
  );
}

function NumInput(props: { name: string; value: number; min: number; max: number; step?: string }) {
  return (
    <input type="number" name={props.name} value={String(props.value)} min={String(props.min)} max={String(props.max)} step={props.step} />
  );
}

// English labels for the built-in safety taxonomy groups (src/pipeline/safety.ts).
const SAFETY_GROUP_LABELS: Record<string, string> = {
  sexual: "Sexual / adult",
  politics: "Politics / sovereignty",
  religion: "Religion (inflammatory)",
  illegal: "Illegal (drugs, gambling, weapons)",
  hate: "Hate / discrimination",
  self_harm: "Self-harm (methods)",
  violence_extreme: "Extreme violence",
  medical_claim: "Medical cure claims",
  violence: "Violence / gore",
  profanity: "Profanity / insults",
};

const PERSONA_LABELS: Record<string, string> = {
  "mia-tran": "Mia Tran",
  "lee-nguyen": "Lee Nguyen",
  "sam-park": "Sam Park",
  "alex-chen": "Alex Chen",
};

// Read-only display of one built-in blacklist group: label + severity + terms.
function BlacklistGroup(props: { g: SafetyGroup }) {
  const { g } = props;
  return (
    <div class="blk-group">
      <div class="blk-head">
        <span class="blk-name">{SAFETY_GROUP_LABELS[g.name] ?? g.name}</span>
        <Tag color={g.severity === "hard" ? "red" : "amber"}>{g.severity === "hard" ? "HARD - blocked" : "SOFT - restricted"}</Tag>
        <span class="blk-count mono">{g.terms.length} terms</span>
      </div>
      <div class="blk-terms">
        {g.terms.map((t) => <span class="blk-term mono">{t}</span>)}
      </div>
    </div>
  );
}

export function ConfigPage(props: {
  cfg: RuntimeConfig;
  source: "kv" | "default";
  audit: ConfigAuditRow[];
  csrf: string;
}) {
  const { cfg, csrf } = props;
  const safety = cfg.safety;
  const blacklist = builtinBlacklist();
  const allowPhrases = builtinAllowPhrases();
  const hardGroups = blacklist.filter((g) => g.severity === "hard");
  const softGroups = blacklist.filter((g) => g.severity === "soft");
  const personas = Object.entries(cfg.prompts.personas);

  return (
    <div class="stack-lg">
      <SectionHead title="System config" sub="Changes apply from the next run">
        <span class="field-hint">Source: <b>{props.source}</b></span>
      </SectionHead>

      <form method="post" action="/admin/config">
        <input type="hidden" name="csrf" value={csrf} />

        <div class="cols" style="display:grid;grid-template-columns:1fr;gap:16px">
          <div class="cols-eq">
            <div class="card">
              <div class="card-head"><div class="card-title">Pipeline</div></div>
              <Field label="Enable pipeline" hint="Turns the whole automated chain on or off (kill switch)">
                <Switch name="pipeline.enabled" checked={cfg.pipeline.enabled} />
              </Field>
              <Field label="Posts / day" hint="Maximum posts per day (1-10)">
                <NumInput name="pipeline.postsPerDay" value={cfg.pipeline.postsPerDay} min={1} max={10} />
              </Field>
              <Field label="Idea backlog size" hint="Backfill count (1-60)">
                <NumInput name="pipeline.backfillCount" value={cfg.pipeline.backfillCount} min={1} max={60} />
              </Field>
              <Field label="Max rewrites" hint="Regenerations per post (1-5)">
                <NumInput name="pipeline.maxGenAttempts" value={cfg.pipeline.maxGenAttempts} min={1} max={5} />
              </Field>
              <Field label="Time budget (ms)" hint="Stop the run early after this limit (5000-300000)">
                <NumInput name="pipeline.timeBudgetMs" value={cfg.pipeline.timeBudgetMs} min={5000} max={300000} />
              </Field>
              <Field label="Publish mode" hint="auto, or hold for manual review">
                <select name="publish.mode">
                  <option value="auto" selected={cfg.publish.mode === "auto"}>auto (publish automatically)</option>
                  <option value="review" selected={cfg.publish.mode === "review"}>review (hold for review)</option>
                </select>
              </Field>
            </div>

            <div class="card">
              <div class="card-head"><div class="card-title">Content quality</div></div>
              <Field label="Minimum words" hint="Min words (200-2000)">
                <NumInput name="quality.minWords" value={cfg.quality.minWords} min={200} max={2000} />
              </Field>
              <Field label="Duplicate threshold" hint="Duplicate post detection (0-1)">
                <NumInput name="quality.similarityThreshold" value={cfg.quality.similarityThreshold} min={0} max={1} step="0.05" />
              </Field>
              <Field label="Enable critic" hint="Uses ~1 extra LLM call per post for scoring">
                <Switch name="quality.criticEnabled" checked={cfg.quality.criticEnabled} />
              </Field>
              <Field label="Minimum critic score" hint="1-10">
                <NumInput name="quality.criticMinScore" value={cfg.quality.criticMinScore} min={1} max={10} />
              </Field>
            </div>
          </div>

          <div class="cols-eq">
            <div class="card">
              <div class="card-head"><div class="card-title">LLM settings</div></div>
              <Field label="Timeout (ms)" hint="10,000 - 300,000">
                <NumInput name="llm.timeoutMs" value={cfg.llm.timeoutMs} min={10000} max={300000} />
              </Field>
              <Field label="Retry count" hint="Per provider on transient errors (0-5)">
                <NumInput name="llm.maxRetries" value={cfg.llm.maxRetries} min={0} max={5} />
              </Field>
              <Field label="Daily budget ($)" hint="0 = no limit (0-100)">
                <NumInput name="llm.dailyBudgetUsd" value={cfg.llm.dailyBudgetUsd} min={0} max={100} step="0.1" />
              </Field>
              <Field label="Monthly budget ($)" hint="0-1000">
                <NumInput name="llm.monthlyBudgetUsd" value={cfg.llm.monthlyBudgetUsd} min={0} max={1000} step="1" />
              </Field>
              <p class="field-hint" style="margin:10px 0 0">
                Provider order: <span class="mono">{cfg.llm.providerOrder.join(" -> ")}</span><br />
                Models: <span class="mono">{JSON.stringify(cfg.llm.models)}</span><br />
                Photos: <span class="mono">{cfg.photos.providerOrder.join(" -> ")}</span>
              </p>
            </div>

            <div class="card">
              <div class="card-head"><div class="card-title">Alerts</div></div>
              <Field label="Enable alerts"><Switch name="alerts.enabled" checked={cfg.alerts.enabled} /></Field>
              <Field label="Email channel" hint="Resend"><Switch name="alerts.channel.email" checked={cfg.alerts.channels.includes("email")} /></Field>
              <Field label="Telegram channel"><Switch name="alerts.channel.telegram" checked={cfg.alerts.channels.includes("telegram")} /></Field>
              <Field label="Error rate threshold" hint="0.0 - 1.0">
                <NumInput name="alerts.failRateThreshold" value={cfg.alerts.failRateThreshold} min={0} max={1} step="0.05" />
              </Field>
              <Field label="Stalled run (hours)" hint="Alert if no run happens within N hours (1-168)">
                <NumInput name="alerts.staleRunHours" value={cfg.alerts.staleRunHours} min={1} max={168} />
              </Field>
            </div>
          </div>

          {/* ── Content safety ──────────────────────────────────────────────── */}
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">Content safety</div>
                <div class="card-sub">Blocks sensitive terms and topics. HARD terms are never published; exceeding the SOFT threshold triggers a rewrite.</div>
              </div>
              <span class="metric-ico accent"><Icon name="shield" size={15} /></span>
            </div>
            <Field label="Enable safety moderation" hint="Scans title + description + body against the blacklist">
              <Switch name="safety.enabled" checked={safety.enabled} />
            </Field>
            <Field label="SOFT threshold" hint="Maximum SOFT terms before a rewrite (0-20)">
              <NumInput name="safety.softThreshold" value={safety.softThreshold} min={0} max={20} />
            </Field>

            {/* Built-in blacklist (read-only): show the operator what is already
                blocked, so "kill / sex / politics..." are visibly covered. */}
            <div class="blk-panel">
              <div class="blk-panel-head">
                <span class="field-label">Built-in blocklist (read-only)</span>
                <span class="field-hint">{hardGroups.length} HARD groups, {softGroups.length} SOFT groups - covers killing, sex, politics, drugs...</span>
              </div>
              <div class="blk-groups">
                {hardGroups.map((g) => <BlacklistGroup g={g} />)}
                {softGroups.map((g) => <BlacklistGroup g={g} />)}
              </div>
              <div class="blk-group">
                <div class="blk-head">
                  <span class="blk-name">Harmless phrases allowed (idiom whitelist)</span>
                  <Tag color="emerald">ignored</Tag>
                  <span class="blk-count mono">{allowPhrases.length} phrases</span>
                </div>
                <div class="blk-terms">
                  {allowPhrases.map((p) => <span class="blk-term mono">{p}</span>)}
                </div>
              </div>
            </div>

            <div style="padding-top:12px">
              <label class="eyebrow">Add HARD terms (comma-separated)</label>
              <textarea name="safety.extraHardTerms" placeholder="e.g. term1, term2">{safety.extraHardTerms.join(", ")}</textarea>
              <label class="eyebrow" style="margin-top:12px">Add SOFT terms</label>
              <textarea name="safety.extraSoftTerms">{safety.extraSoftTerms.join(", ")}</textarea>
              <label class="eyebrow" style="margin-top:12px">Allowed harmless phrases (idiom whitelist)</label>
              <textarea name="safety.allowPhrases" placeholder="e.g. kill time">{safety.allowPhrases.join(", ")}</textarea>
              <p class="field-hint" style="margin:8px 0 0">The built-in blocklist lives in code (not editable here); the fields above only ADD to it. Enter terms without diacritics (the system matches both accented and unaccented forms).</p>
            </div>
          </div>

          {/* ── System prompt / author tone (editable) ──────────────────────── */}
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">System prompt &amp; author voice</div>
                <div class="card-sub">This is the prompt currently used to generate posts on the site. Leave a field empty to use the default in code.</div>
              </div>
              <span class="metric-ico accent"><Icon name="edit" size={15} /></span>
            </div>

            <label class="eyebrow">House voice - base voice (applies to every post)</label>
            <textarea name="prompts.houseVoice" class="prompt-area" rows={12}>{cfg.prompts.houseVoice}</textarea>

            <label class="eyebrow" style="margin-top:14px">Tone + content safety (applies to every post)</label>
            <textarea name="prompts.toneCard" class="prompt-area" rows={7}>{cfg.prompts.toneCard}</textarea>

            <div class="prompt-personas">
              {personas.map(([slug, seed]) => (
                <div class="pp">
                  <label class="eyebrow">Author voice: {PERSONA_LABELS[slug] ?? slug} <span class="mono" style="text-transform:none;letter-spacing:0">({slug})</span></label>
                  <textarea name={`prompts.personas.${slug}`} class="prompt-area" rows={3}>{seed}</textarea>
                </div>
              ))}
            </div>

            <details style="margin-top:14px">
              <summary class="field-hint" style="cursor:pointer">Copywriting formulas &amp; article types (read-only - edit in code)</summary>
              <div class="ref-grid">
                <div>
                  <div class="field-label" style="margin:10px 0 6px">Formulas ({Object.keys(FORMULA_CARDS).length})</div>
                  {Object.entries(FORMULA_CARDS).map(([k, v]) => (
                    <p class="ref-row"><span class="mono blk-term">{k}</span> {v}</p>
                  ))}
                </div>
                <div>
                  <div class="field-label" style="margin:10px 0 6px">Article types ({Object.keys(ARTICLE_TYPE_HINTS).length})</div>
                  {Object.entries(ARTICLE_TYPE_HINTS).map(([k, v]) => (
                    <p class="ref-row"><span class="mono blk-term">{k}</span> {v}</p>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </div>

        <div style="margin:18px 0">
          <button type="submit" class="btn btn-primary"><Icon name="check-circle" size={15} /> Save config</button>
        </div>
      </form>

      <div class="section-title" style="margin-bottom:10px">Recent config changes</div>
      {props.audit.length ? (
        <div class="log-panel">
          <pre>{props.audit.map((a) => `[${fmtTs(a.changedAt)}] ${a.actor} - ${truncate(a.diffJson, 600)}`).join("\n")}</pre>
        </div>
      ) : (
        <p class="muted">No changes recorded yet.</p>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// ── LLM gateway console ──────────────────────────────────────────────────────

// Filter options for the llm_calls console. Article generation stages come from
// generateArticle (docs/architecture/article-generation.md) - keep in sync when a
// stage is added. "draft"/"regen" are the retired one-shot stages, kept so old
// rows stay filterable.
const LLM_STAGES = [
  "ideation",
  "outline",
  "lead",
  "section",
  "ending",
  "expand",
  "patch",
  "critic",
  "test",
  "chat",
  "draft",
  "regen",
];

// One provider health card: model, failover position, circuit-breaker state,
// key presence, and 30-day usage.
function ProviderCard(props: { p: ProviderStatus }) {
  const { p } = props;
  const dotClass = p.circuitState === "open" ? "bad" : p.circuitState === "degraded" ? "warn" : "";
  const cbLabel =
    p.circuitState === "open"
      ? "Open (tripped)"
      : p.circuitState === "degraded"
        ? `Degraded (${p.circuitFails} failures)`
        : "Normal";
  return (
    <div class={`provider-card${p.active ? " on" : ""}`}>
      <div class="pc-head">
        <span class="pc-name">{p.label}</span>
        {p.active ? (
          <Tag color="blue">#{p.order + 1} in chain</Tag>
        ) : p.configured ? (
          <Tag color="zinc">unused</Tag>
        ) : (
          <Tag color="zinc">not configured</Tag>
        )}
      </div>
      <div class="pc-model mono">{p.model}</div>
      <div class="pc-rows">
        <div class="pc-row">
          <span class="pc-k">Circuit breaker</span>
          <span class="pc-v"><span class={`sys-dot ${dotClass}`}></span> {cbLabel}</span>
        </div>
        <div class="pc-row">
          <span class="pc-k">Key (API key/binding)</span>
          <span class="pc-v">{p.configured ? <span class="score-hi">yes</span> : <span class="neg">missing</span>}</span>
        </div>
        <div class="pc-row"><span class="pc-k">Calls 30d</span><span class="pc-v mono">{p.calls30d}</span></div>
        <div class="pc-row"><span class="pc-k">Cost 30d</span><span class="pc-v mono">{usd(p.costMicros30d)}</span></div>
      </div>
    </div>
  );
}

export function LlmPage(props: {
  calls: LlmCall[];
  daily: DailyCost[];
  gateway: GatewayStatus;
  filterProvider: string;
  filterStage: string;
  filterOk: string;
}) {
  const { gateway } = props;
  const shown = props.calls;
  const okN = shown.filter((c) => c.ok).length;
  const calls30 = props.daily.reduce((s, r) => s + r.calls, 0);
  const cost30 = props.daily.reduce((s, r) => s + r.costMicros, 0);
  const avgLatency = shown.length ? Math.round(shown.reduce((s, c) => s + (c.latencyMs ?? 0), 0) / shown.length) : 0;
  const okRate = shown.length ? Math.round((okN / shown.length) * 100) : 0;
  const shownCost = shown.reduce((s, c) => s + (c.costMicros ?? 0), 0);

  const chartData = [...props.daily].reverse().slice(-14).map((r) => ({ label: r.day.slice(5), a: r.costMicros, b: r.calls }));

  const b = gateway.budget;
  const dayPct = b.dayCapUsd > 0 ? (b.daySpentUsd / b.dayCapUsd) * 100 : 0;
  const monthPct = b.monthCapUsd > 0 ? (b.monthSpentUsd / b.monthCapUsd) * 100 : 0;
  const labelOf = (name: string) => gateway.providers.find((p) => p.name === name)?.label ?? name;

  return (
    <div class="stack-lg">
      <div class="grid kpi-grid" style="grid-template-columns:repeat(2,1fr)">
        <MetricCard eyebrow="Calls (30d)" value={String(calls30)} cap="last 30 days" icon="zap" accent />
        <MetricCard eyebrow="Cost (30d)" value={usd(cost30)} cap={`${calls30} calls`} icon="dollar-sign" />
        <MetricCard eyebrow="Avg latency" value={`${fmtMs(avgLatency)}`} cap={`over the last ${shown.length} calls`} icon="clock" />
        <MetricCard eyebrow="OK rate" value={`${okRate}%`} cap={`${okN} / ${shown.length} recent calls`} icon="activity" />
      </div>

      {/* Gateway console: failover chain, binding, timeouts, budget. */}
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">LLM Gateway</div>
            <div class="card-sub">Failover chain, circuit breaker, budget</div>
          </div>
          <Tag color={gateway.gatewayBinding ? "emerald" : "zinc"}>
            {gateway.gatewayBinding ? "Cloudflare AI Gateway" : "Direct connection"}
          </Tag>
        </div>

        <div class="gw-chain">
          {gateway.providerOrder.length ? (
            gateway.providerOrder.map((name, i) => (
              <>
                <span class="gw-node">{labelOf(name)}</span>
                {i < gateway.providerOrder.length - 1 ? <span class="gw-arrow">-&gt;</span> : null}
              </>
            ))
          ) : (
            <span class="muted">No provider configured.</span>
          )}
        </div>

        <div class="gw-meta">
          <div class="rs"><span class="rs-k">Timeout</span><span class="rs-v mono">{fmtMs(gateway.timeoutMs)}</span></div>
          <div class="rs"><span class="rs-k">Retries / provider</span><span class="rs-v mono">{gateway.maxRetries}</span></div>
          <div class="rs"><span class="rs-k">Gateway</span><span class="rs-v mono">{gateway.gatewayBinding ?? "direct"}</span></div>
        </div>

        <div class="gw-meters">
          <Meter
            label="Daily budget"
            left={`$${b.daySpentUsd.toFixed(4)}`}
            right={b.dayCapUsd > 0 ? `$${b.dayCapUsd.toFixed(2)}` : "no limit"}
            pct={dayPct}
            ok={dayPct < 80}
          />
          <Meter
            label="Monthly budget"
            left={`$${b.monthSpentUsd.toFixed(4)}`}
            right={b.monthCapUsd > 0 ? `$${b.monthCapUsd.toFixed(2)}` : "no limit"}
            pct={monthPct}
            ok={monthPct < 80}
          />
        </div>
      </div>

      {/* Provider health cards. */}
      <div class="provider-grid">
        {gateway.providers.map((p) => <ProviderCard p={p} />)}
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Cost and calls per day</div>
            <div class="card-sub">Last 14 days</div>
          </div>
        </div>
        {chartData.length >= 2 ? (
          <>
            <LineChartSVG data={chartData} />
            <div class="chart-legend">
              <span class="k"><span class="sw" style="background:#3b82f6"></span> Cost ($)</span>
              <span class="k"><span class="sw" style="background:#10b981"></span> Calls</span>
            </div>
          </>
        ) : (
          <p class="muted">At least 2 days of data are needed to draw the chart ({chartData.length} so far).</p>
        )}
      </div>

      <div class="card">
        <form method="get" action="/admin/llm" class="form-row">
          <div>
            <label class="eyebrow">Provider</label>
            <select name="provider">
              <option value="">All</option>
              {["deepseek", "workers-ai", "openai-compat"].map((p) => <option value={p} selected={props.filterProvider === p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label class="eyebrow">Stage</label>
            <select name="stage">
              <option value="">All</option>
              {LLM_STAGES.map((s) => <option value={s} selected={props.filterStage === s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label class="eyebrow">Result</label>
            <select name="ok">
              <option value="">All</option>
              <option value="1" selected={props.filterOk === "1"}>ok</option>
              <option value="0" selected={props.filterOk === "0"}>error</option>
            </select>
          </div>
          <button type="submit" class="btn btn-outline">Filter</button>
        </form>
      </div>

      <div class="stack">
        <div class="section-head" style="margin-bottom:0">
          <div class="section-title" style="font-size:14px">Recent calls ({shown.length})</div>
          <span class="field-hint">Shown cost: <b class="mono">{usd(shownCost)}</b></span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tr>
              <th>Time</th><th>Stage</th><th>Provider</th><th>OK</th>
              <th class="num">Try</th><th class="num">Latency</th>
              <th class="num">Tokens in/out</th><th class="num">Cost</th><th>Run</th><th>Error</th>
            </tr>
            {shown.map((x) => (
              <tr>
                <td class="mono">{fmtTs(x.createdAt)}</td>
                <td><Tag color={x.stage === "ideation" ? "violet" : x.stage === "test" ? "zinc" : "blue"}>{x.stage}</Tag></td>
                <td class="mono">{x.provider}</td>
                <td>{x.ok ? <span class="score-hi"><Icon name="check-circle" size={14} /></span> : <span class="neg"><Icon name="x-circle" size={14} /></span>}</td>
                <td class="num">{x.attempt}</td>
                <td class="num">{fmtMs(x.latencyMs)}</td>
                <td class="num">{x.promptTokens ?? "-"}/{x.completionTokens ?? "-"}</td>
                <td class="num">{usd(x.costMicros)}</td>
                <td>{x.runId ? <a href={`/admin/runs/${x.runId}`}>run</a> : "-"}</td>
                <td class="cell-err">{x.error ?? ""}</td>
              </tr>
            ))}
            {!shown.length ? (
              <tr><td colspan={10} class="muted" style="text-align:center;padding:24px">No calls match the filter.</td></tr>
            ) : null}
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tools ────────────────────────────────────────────────────────────────────

function HealthChip(props: { state: "ok" | "bad" | "info"; icon: string; title: string; detail: string }) {
  const ico = props.state === "ok" ? "check-circle" : props.state === "bad" ? "x-circle" : props.icon;
  return (
    <div class={`health-chip ${props.state}`}>
      <span class="ico"><Icon name={ico} size={18} /></span>
      <div>
        <div class="t">{props.title}</div>
        <div class="s">{props.detail}</div>
      </div>
    </div>
  );
}

export function ToolsPage(props: { csrf: string; health: Record<string, unknown> }) {
  const { csrf, health } = props;
  const checks = (health.checks ?? {}) as { db?: boolean; kv?: boolean; r2?: boolean };
  const queue = (health.queue ?? {}) as { byStatus?: Record<string, number> };
  const lastRun = (health.lastRun ?? null) as { status?: string; trigger?: string } | null;
  const pending = queue.byStatus?.pending ?? 0;
  const failedQ = queue.byStatus?.failed ?? 0;

  return (
    <div class="stack-lg">
      <SectionHead title="Tools" sub="Run the pipeline, check connections, maintenance" />

      <div class="cols-2">
        <div class="card">
          <div class="card-head"><div class="card-title">Run batch manually</div></div>
          <form method="post" action="/admin/tools/run" class="form-row" data-busy="Running...">
            <input type="hidden" name="csrf" value={csrf} />
            <div>
              <label class="eyebrow">Posts (1-5)</label>
              <input type="number" name="count" value="1" min="1" max="5" />
            </div>
            <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px">
              <input type="checkbox" name="force" /> force (bypass kill switch)
            </label>
            <button type="submit" class="btn"><Icon name="play" size={14} /> Run</button>
          </form>
          <p class="field-hint" style="margin:10px 0 0">Runs synchronously within this request - keep the post count small. Results are logged to Runs.</p>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Check connections</div></div>
          <div class="form-row">
            <form method="post" action="/admin/tools/test-llm">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="send" size={14} /> Test LLM</button>
            </form>
            <form method="post" action="/admin/tools/test-photo">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="send" size={14} /> Test photo API</button>
            </form>
            <form method="post" action="/admin/tools/test-telegram">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="send" size={14} /> Test Telegram</button>
            </form>
            <form method="post" action="/admin/tools/heartbeat">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="activity" size={14} /> Send digest now</button>
            </form>
          </div>
          <p class="field-hint" style="margin:12px 0 8px">Maintenance</p>
          <div class="form-row">
            <form method="post" action="/admin/tools/reindex">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="database" size={14} /> Reindex FTS</button>
            </form>
            <form method="post" action="/admin/tools/purge">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit" class="btn btn-outline"><Icon name="hard-drive" size={14} /> Purge cache</button>
            </form>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">System status</div>
          <StatusBadge s={health.ok ? "ok" : "failed"} label={health.ok ? "healthy" : "issues"} />
        </div>
        <div class="health-grid">
          <HealthChip state={checks.db ? "ok" : "bad"} icon="database" title="Database (D1)" detail={checks.db ? "connected" : "error"} />
          <HealthChip state={checks.kv ? "ok" : "bad"} icon="hard-drive" title="KV cache" detail={checks.kv ? "ok" : "error"} />
          <HealthChip state={checks.r2 ? "ok" : "bad"} icon="hard-drive" title="R2 storage" detail={checks.r2 ? "uploads ok" : "error"} />
          <HealthChip state="info" icon="list" title="Queue" detail={`${pending} pending / ${failedQ} failed`} />
          <HealthChip state="info" icon="clock" title="Last run" detail={lastRun ? `${lastRun.status ?? "?"} (${lastRun.trigger ?? "?"})` : "none yet"} />
        </div>
        <details style="margin-top:14px">
          <summary class="field-hint" style="cursor:pointer">Full health (JSON)</summary>
          <div class="log-panel" style="margin-top:8px"><pre>{JSON.stringify(health, null, 2)}</pre></div>
        </details>
      </div>
    </div>
  );
}
