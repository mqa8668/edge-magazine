// Admin pages: dashboard, run history (+ drill-down), and the content queue.
// Pure SSR - every action is a plain form POST followed by a redirect. Uses the
// shared view kit + tokens from ui.tsx / public/admin.css. All UI copy is
// English (admin chrome).

import type { ContentQueueItem, LlmCall, Notification, PipelineIdea, PipelineRun } from "../db/schema";
import type { RunPhase } from "../pipeline/telemetry";
import { totalTokens } from "../pipeline/telemetry";
import type { DashboardData, DailyCost } from "./data";
import { BULK_RETRY_ATTEMPTS_CAP } from "./data";
import { categoryColor } from "../lib/category";
import { Icon } from "./icons";
import {
  BarChartSVG,
  CategoryDot,
  EmptyState,
  MetricCard,
  ProgressBar,
  SectionHead,
  StatusBadge,
  Tag,
  TriggerBadge,
  fmtIso,
  fmtMs,
  fmtTokens,
  fmtTs,
  scoreClass,
  usd,
} from "./ui";

// ── Dashboard ────────────────────────────────────────────────────────────────

export function DashboardPage(props: {
  d: DashboardData;
  daily: DailyCost[];
  recentRuns: PipelineRun[];
}) {
  const { d, recentRuns } = props;
  const failRate7d = d.runs7d.requested > 0 ? d.runs7d.failed / d.runs7d.requested : 0;

  // Cost-by-day bars (oldest -> newest left to right).
  const bars = [...props.daily]
    .reverse()
    .map((r) => ({ label: r.day.slice(5), value: r.costMicros, title: `${r.day}: ${usd(r.costMicros)} (${r.calls} calls)` }));

  const monthlySpent = d.cost30d.costMicros / 1e6;
  const monthlyCap = d.config.llm.monthlyBudgetUsd || 0;
  const budgetPct = monthlyCap > 0 ? (monthlySpent / monthlyCap) * 100 : 0;
  const providers = Object.entries(d.cost7d.byProvider);
  const stages = Object.entries(d.cost7d.byStage).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));

  return (
    <div class="stack-lg">
      {d.awaitingReview > 0 ? (
        <div class="flash flash-ok">
          {d.awaitingReview} post(s) awaiting approval on the <a href="/admin/review">Review</a> page.
        </div>
      ) : null}

      <div class="grid kpi-grid">
        <MetricCard eyebrow="Total posts" value={String(d.postsTotal)} cap={`${d.postsByCategory.length} categories`} icon="file-text" accent />
        <MetricCard eyebrow="Queue pending" value={String(d.queueByStatus["pending"] ?? 0)} cap={`failed ${d.queueByStatus["failed"] ?? 0} / skipped ${d.queueByStatus["skipped"] ?? 0}`} icon="list" />
        <MetricCard eyebrow="Awaiting review" value={String(d.awaitingReview)} cap="Needs attention" icon="check-square" />
        <MetricCard eyebrow="Failure rate 7d" value={`${(failRate7d * 100).toFixed(0)}%`} cap={`${d.runs7d.failed} / ${d.runs7d.requested} requested`} icon="activity" />
        <MetricCard eyebrow="LLM cost 7d" value={usd(d.cost7d.costMicros)} cap={`${d.cost7d.calls} calls`} icon="dollar-sign" />
        <MetricCard eyebrow="LLM cost 30d" value={usd(d.cost30d.costMicros)} cap={`${d.cost30d.calls} calls`} icon="bar-chart" />
        <MetricCard eyebrow="LLM tokens 7d" value={fmtTokens(totalTokens(d.cost7d))} cap={`in ${fmtTokens(d.cost7d.promptTokens)} / out ${fmtTokens(d.cost7d.completionTokens)}`} icon="cpu" />
        <MetricCard eyebrow="LLM tokens 30d" value={fmtTokens(totalTokens(d.cost30d))} cap={`in ${fmtTokens(d.cost30d.promptTokens)} / out ${fmtTokens(d.cost30d.completionTokens)}`} icon="cpu" />
      </div>

      <div class="cols-3">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">LLM cost by day</div>
              <div class="card-sub">Last 10 days</div>
            </div>
            <Tag color="blue">{d.config.llm.providerOrder.join(" + ")}</Tag>
          </div>
          <BarChartSVG data={bars} />
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Posts by category</div>
          </div>
          <div class="legend-list">
            {d.postsByCategory
              .filter((c) => c.count > 0)
              .map((c) => (
                <div class="legend-row">
                  <CategoryDot color={categoryColor(c.slug)} />
                  <span class="name">{c.name}</span>
                  <span class="n">{c.count}</span>
                </div>
              ))}
          </div>
        </div>

      </div>

      <div class="cols-2">
        <div class="card">
          <div class="card-head">
            <div class="card-title">Recent runs</div>
            <Tag color="zinc">{recentRuns.length} runs</Tag>
          </div>
          {recentRuns.length ? (
            <div class="tbl-wrap">
              <table class="tbl">
                <tr>
                  <th>Time</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th class="num">Published</th>
                  <th class="num">Failed</th>
                  <th class="num">Duration</th>
                </tr>
                {recentRuns.map((r) => (
                  <tr>
                    <td class="mono"><a href={`/admin/runs/${r.id}`}>{fmtTs(r.startedAt)}</a></td>
                    <td><TriggerBadge t={r.trigger} /></td>
                    <td><StatusBadge s={r.status} /></td>
                    <td class="num pos">{r.published ?? 0}</td>
                    <td class={`num${(r.failed ?? 0) > 0 ? " neg" : ""}`}>{r.failed ?? 0}</td>
                    <td class="num">{fmtMs(r.durationMs)}</td>
                  </tr>
                ))}
              </table>
            </div>
          ) : (
            <p class="muted">No runs recorded yet.</p>
          )}
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">LLM 7 days by provider</div>
          </div>
          {providers.length ? (
            <div class="tbl-wrap">
              <table class="tbl">
                <tr>
                  <th>Provider</th>
                  <th class="num">Calls</th>
                  <th class="num">Tokens</th>
                  <th class="num">Cost</th>
                </tr>
                {providers.map(([p, s]) => (
                  <tr>
                    <td class="mono">{p}</td>
                    <td class="num">{s.calls}</td>
                    <td class="num">{fmtTokens(totalTokens(s))}</td>
                    <td class="num">{usd(s.costMicros)}</td>
                  </tr>
                ))}
              </table>
            </div>
          ) : (
            <p class="muted">No calls in the last 7 days.</p>
          )}
          <div style="margin-top:14px">
            <div class="field" style="border:none;padding:0 0 6px">
              <span class="field-hint">Monthly budget</span>
              <span class="mono" style="font-size:12px">{usd(d.cost30d.costMicros)} / ${monthlyCap.toFixed(2)}</span>
            </div>
            <ProgressBar pct={budgetPct} ok={budgetPct < 80} />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">LLM by stage - 7 days</div>
            <div class="card-sub">Tokens &amp; cost by pipeline stage (optimization levers)</div>
          </div>
        </div>
        {stages.length ? (
          <div class="tbl-wrap">
            <table class="tbl">
              <tr>
                <th>Stage</th>
                <th class="num">Calls</th>
                <th class="num">Tokens in</th>
                <th class="num">Tokens out</th>
                <th class="num">Total tokens</th>
                <th class="num">Cost</th>
              </tr>
              {stages.map(([stage, s]) => (
                <tr>
                  <td><Tag color="zinc">{stage}</Tag></td>
                  <td class="num">{s.calls}</td>
                  <td class="num">{fmtTokens(s.promptTokens)}</td>
                  <td class="num">{fmtTokens(s.completionTokens)}</td>
                  <td class="num">{fmtTokens(totalTokens(s))}</td>
                  <td class="num">{usd(s.costMicros)}</td>
                </tr>
              ))}
            </table>
          </div>
        ) : (
          <p class="muted">No calls in the last 7 days.</p>
        )}
      </div>
    </div>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export function RunsPage(props: { runs: PipelineRun[] }) {
  return (
    <div class="stack">
      <SectionHead title="Run history" sub={`${props.runs.length} runs recorded`} />
      {props.runs.length ? (
        <div class="tbl-wrap">
          <table class="tbl">
            <tr>
              <th>Started</th>
              <th>Trigger</th>
              <th>Status</th>
              <th class="num">Requested</th>
              <th class="num">Ideas</th>
              <th class="num">Enqueued</th>
              <th class="num">Duplicates</th>
              <th class="num">Published</th>
              <th class="num">Failed</th>
              <th class="num">Duration</th>
              <th></th>
            </tr>
            {props.runs.map((r) => (
              <tr>
                <td class="mono">{fmtTs(r.startedAt)}</td>
                <td><TriggerBadge t={r.trigger} /></td>
                <td><StatusBadge s={r.status} /></td>
                <td class="num">{r.requested ?? "-"}</td>
                <td class="num">{r.ideated ?? "-"}</td>
                <td class="num">{r.enqueued ?? "-"}</td>
                <td class="num">{r.skippedDup ?? "-"}</td>
                <td class={`num${(r.published ?? 0) > 0 ? " pos" : ""}`}>{r.published ?? "-"}</td>
                <td class={`num${(r.failed ?? 0) > 0 ? " neg" : ""}`}>{r.failed ?? "-"}</td>
                <td class="num">{fmtMs(r.durationMs)}</td>
                <td><a href={`/admin/runs/${r.id}`}>Details</a></td>
              </tr>
            ))}
          </table>
        </div>
      ) : (
        <div class="card"><EmptyState icon="play" title="No runs yet" sub="Run the pipeline from the Tools page (or click 'Run now' on a Queue item) to create the first run." /></div>
      )}
    </div>
  );
}

// One node in the pipeline funnel (run detail). `tone` colors the count.
function FunnelStage(props: { label: string; value: number; tone?: "pos" | "neg" | "muted"; last?: boolean }) {
  const toneClass = props.tone === "pos" ? "pos" : props.tone === "neg" ? "neg" : props.tone === "muted" ? "muted" : "";
  return (
    <>
      <div class="funnel-stage">
        <div class={`funnel-val ${toneClass}`}>{props.value}</div>
        <div class="funnel-label">{props.label}</div>
      </div>
      {!props.last ? <div class="funnel-arrow"><Icon name="arrow-up-right" size={14} /></div> : null}
    </>
  );
}

// Coarse pipeline-phase labels (KV heartbeat -> label).
const PHASE_LABEL: Record<string, string> = {
  ideation: "Brainstorming topic ideas",
  generating: "Writing post (LLM calls)",
  publishing: "Fetching photo + publishing",
};

// Compact duration, e.g. "8s" / "2m 5s".
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// One LLM call as an expandable "stage card" - summary line always visible, full
// data (tokens, attempt, exact time, full error) behind a toggle.
function StageCard(props: { x: LlmCall }) {
  const { x } = props;
  return (
    <details class="stage-card">
      <summary>
        <Tag color={x.stage === "ideation" ? "violet" : x.stage === "test" ? "zinc" : "blue"}>{x.stage}</Tag>
        <span class="sc-model mono">{x.provider}/{x.model}</span>
        {x.ok ? (
          <span class="score-hi"><Icon name="check-circle" size={13} /></span>
        ) : (
          <span class="neg"><Icon name="x-circle" size={13} /></span>
        )}
        <span class="sc-meta mono">{fmtMs(x.latencyMs)}</span>
        <span class="sc-meta mono">{usd(x.costMicros)}</span>
        <span class="sc-time mono">{fmtTs(x.createdAt)}</span>
        <Icon name="chevron-down" size={14} class="sc-caret" />
      </summary>
      <div class="stage-body">
        <div class="kv-row"><span>Tokens in / out</span><span class="mono">{x.promptTokens ?? "-"} / {x.completionTokens ?? "-"}</span></div>
        <div class="kv-row"><span>Attempt</span><span class="mono">{x.attempt}</span></div>
        <div class="kv-row"><span>Model</span><span class="mono">{x.model}</span></div>
        <div class="kv-row"><span>Time</span><span class="mono">{fmtTs(x.createdAt)}</span></div>
        {x.error ? <div class="stage-err">{x.error}</div> : <div class="field-hint" style="margin-top:8px">No errors.</div>}
      </div>
    </details>
  );
}

// Idea outcome badge + human note (why it was dropped, and against what).
const DUP_REASON_LABEL: Record<string, string> = {
  "exact-key": "Exact key match",
  similar: "Near duplicate",
  "unique-conflict": "Key conflict (race)",
  "empty-after-normalize": "Empty after normalization",
};

function IdeaStatus(props: { s: string }) {
  if (props.s === "enqueued") return <Tag color="emerald">Enqueued</Tag>;
  if (props.s === "safety_blocked") return <Tag color="red">Safety blocked</Tag>;
  if (props.s === "unused") return <Tag color="amber">Reserve</Tag>;
  return <Tag color="zinc">Duplicate</Tag>;
}

function ideaNote(it: PipelineIdea): string {
  if (it.status !== "dup") return "";
  const reason = DUP_REASON_LABEL[it.dupReason ?? ""] ?? it.dupReason ?? "";
  const score = it.dupScore != null ? ` (${Math.round(it.dupScore * 100)}%)` : "";
  const match = it.matchedTitle ? ` - matches: "${it.matchedTitle}"` : "";
  return `${reason}${score}${match}`;
}

export function RunDetailPage(props: {
  run: PipelineRun;
  calls: LlmCall[];
  phase: RunPhase | null;
  items: ContentQueueItem[];
  ideas: PipelineIdea[];
  csrf: string;
}) {
  const { run, calls, phase, items, ideas, csrf } = props;
  let report: {
    published?: { slug: string; title: string; category: string; photo: string }[];
    failed?: { topic: string; error: string }[];
    held?: { topic: string; category: string }[];
  } | null = null;
  try {
    report = run.reportJson ? JSON.parse(run.reportJson) : null;
  } catch {
    report = null;
  }
  const totalCost = calls.reduce((s, x) => s + (x.costMicros ?? 0), 0);
  const promptTok = calls.reduce((s, x) => s + (x.promptTokens ?? 0), 0);
  const complTok = calls.reduce((s, x) => s + (x.completionTokens ?? 0), 0);
  const running = run.status === "running";
  const heldN = report?.held?.length ?? 0;

  const now = Date.now();
  const runElapsed = running ? now - run.startedAt : (run.durationMs ?? 0);
  const phaseElapsed = phase ? now - phase.at : null;
  const stalled = running && phaseElapsed != null && phaseElapsed > 90_000;

  return (
    <div class="stack-lg">
      <a href="/admin/runs" class="muted" style="font-size:12px">&lt;- Run history</a>

      {/* Live progress banner: current phase + how long it has sat there. This is
          the answer to "where is it stuck?" - it covers the non-LLM steps (photo,
          publish) that emit no calls, so the page never looks silently frozen. */}
      {running ? (
        <div class={`flash ${stalled ? "flash-err" : "flash-warn"}`}>
          <div>
            <Icon name="refresh" size={14} /> Run in progress - page refreshes every 4 seconds.
          </div>
          {phase ? (
            <div style="margin-top:8px">
              <b>Current stage: {PHASE_LABEL[phase.phase] ?? phase.phase}</b>
              {phaseElapsed != null ? <span> ({fmtDur(phaseElapsed)})</span> : null}
              {phase.detail ? <div class="field-hint" style="margin-top:2px">{phase.detail}</div> : null}
              {stalled ? (
                <div style="margin-top:6px">Looks stuck (no progress for over 90s). Click "Reclaim run" below, or the system will reclaim it automatically after ~15 minutes.</div>
              ) : phase.phase === "publishing" ? (
                <div class="field-hint" style="margin-top:4px">The photo + publish step makes no LLM calls, so the table below stays still - a longer wait is normal.</div>
              ) : null}
            </div>
          ) : (
            <div class="field-hint" style="margin-top:6px">Starting up (waiting for first heartbeat)...</div>
          )}
          <form method="post" action={`/admin/runs/${run.id}/reclaim`} style="margin-top:10px">
            <input type="hidden" name="csrf" value={csrf} />
            <button class="btn btn-danger btn-sm" type="submit">
              <Icon name="x-circle" size={13} /> Reclaim run (mark failed, return posts to queue)
            </button>
          </form>
        </div>
      ) : null}

      {/* Summary header: identity + status + timings + cost in one card. */}
      <div class="card">
        <div class="run-head">
          <div class="run-id">
            <span class="mono">{run.id}</span>
            <div class="run-badges">
              <TriggerBadge t={run.trigger} />
              <StatusBadge s={run.status} />
            </div>
          </div>
        </div>
        <div class="run-stats">
          <div class="rs"><span class="rs-k">Started</span><span class="rs-v mono">{fmtTs(run.startedAt)}</span></div>
          <div class="rs"><span class="rs-k">Finished</span><span class="rs-v mono">{run.finishedAt ? fmtTs(run.finishedAt) : "-"}</span></div>
          <div class="rs"><span class="rs-k">Duration</span><span class="rs-v mono">{running ? `${fmtDur(runElapsed)} (running)` : fmtMs(run.durationMs)}</span></div>
          <div class="rs"><span class="rs-k">LLM cost</span><span class="rs-v mono">{usd(totalCost)}</span></div>
          <div class="rs"><span class="rs-k">LLM calls</span><span class="rs-v mono">{calls.length}</span></div>
          <div class="rs"><span class="rs-k">Tokens (in/out)</span><span class="rs-v mono">{fmtTokens(promptTok + complTok)} ({fmtTokens(promptTok)}/{fmtTokens(complTok)})</span></div>
        </div>
        {run.error ? <div class="flash flash-err" style="margin:14px 0 0">{run.error}</div> : null}
      </div>

      {/* Queue items this run is working (live status - shows exactly which
          article and where it is). */}
      {items.length ? (
        <div class="card">
          <div class="card-head"><div class="card-title">Posts in this run ({items.length})</div></div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tr><th class="num">#</th><th>Status</th><th>Topic</th><th class="num">Tries</th><th>Last error</th></tr>
              {items.map((q) => (
                <tr>
                  <td class="num">{q.id}</td>
                  <td><StatusBadge s={q.status} label={STATUS_VI[q.status] ?? q.status} /></td>
                  <td>
                    <div class="cell-topic">{q.topic}</div>
                    {q.publishedSlug ? <div class="muted mono" style="font-size:11px">-&gt; {q.publishedSlug}</div> : null}
                  </td>
                  <td class="num">{q.attempts}</td>
                  <td class="cell-err">{q.lastError ?? ""}</td>
                </tr>
              ))}
            </table>
          </div>
        </div>
      ) : null}

      {/* Pipeline funnel - only meaningful once finished (the counts are written
          at finishRun; while running they are null, so we skip it and rely on the
          phase banner + queue-item panel above). */}
      {!running ? (
        <div class="card">
          <div class="card-head"><div class="card-title">Pipeline stages</div></div>
          <div class="funnel">
            <FunnelStage label="Requested" value={run.requested ?? 0} />
            <FunnelStage label="Ideas" value={run.ideated ?? 0} />
            <FunnelStage label="Enqueued" value={run.enqueued ?? 0} />
            <FunnelStage label="Duplicates" value={run.skippedDup ?? 0} tone="muted" />
            <FunnelStage label="Published" value={run.published ?? 0} tone="pos" />
            {heldN ? <FunnelStage label="Held for review" value={heldN} /> : null}
            <FunnelStage label="Failed" value={run.failed ?? 0} tone="neg" last />
          </div>
        </div>
      ) : null}

      {/* Ideas & dedup: the planning detail behind the funnel's Ideas /
          Enqueued / Duplicates numbers - every idea, kept or dropped, and why. */}
      {ideas.length ? (
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Ideas & dedup ({ideas.length})</div>
              <div class="card-sub">Every idea planning produced: enqueued, duplicate, or safety blocked</div>
            </div>
          </div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tr>
                <th>Category</th>
                <th>Topic</th>
                <th>Keyword</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
              {ideas.map((it) => (
                <tr>
                  <td class="mono">{it.categorySlug}</td>
                  <td><div class="cell-topic">{it.topic}</div></td>
                  <td class="mono">{it.keyword ?? "-"}</td>
                  <td><IdeaStatus s={it.status} /></td>
                  <td class="cell-err">{ideaNote(it)}</td>
                </tr>
              ))}
            </table>
          </div>
        </div>
      ) : null}

      {report?.published?.length ? (
        <div class="stack">
          <div class="section-title">Published ({report.published.length})</div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tr><th>Post</th><th>Category</th><th>Photo</th></tr>
              {report.published.map((p) => (
                <tr>
                  <td><a href={`/${p.category}/${p.slug}`} target="_blank" rel="noreferrer">{p.title}</a></td>
                  <td>{p.category}</td>
                  <td class="mono">{p.photo}</td>
                </tr>
              ))}
            </table>
          </div>
        </div>
      ) : null}

      {report?.held?.length ? (
        <div class="stack">
          <div class="section-title">Held for review ({report.held.length})</div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tr><th>Topic</th><th>Category</th></tr>
              {report.held.map((h) => (
                <tr><td><a href="/admin/review">{h.topic}</a></td><td>{h.category}</td></tr>
              ))}
            </table>
          </div>
        </div>
      ) : null}

      {report?.failed?.length ? (
        <div class="stack">
          <div class="section-title">Failed ({report.failed.length})</div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tr><th>Topic</th><th>Error</th></tr>
              {report.failed.map((f) => (
                <tr><td>{f.topic}</td><td class="cell-err">{f.error}</td></tr>
              ))}
            </table>
          </div>
        </div>
      ) : null}

      <div class="stack">
        <div class="section-head" style="margin-bottom:0">
          <div class="section-title" style="font-size:14px">LLM calls ({calls.length})</div>
          <span class="field-hint">Click a stage to see details</span>
        </div>
        {calls.length ? (
          <div class="stage-list">
            {calls.map((x) => <StageCard x={x} />)}
          </div>
        ) : (
          <p class="muted">{running ? "No LLM calls yet - starting up / on a step that does not use the LLM." : "No calls are linked to this run."}</p>
        )}
      </div>
    </div>
  );
}

// ── Notifications / alerts feed ──────────────────────────────────────────────

// Labels for each notification kind (falls back to the raw kind).
const NOTIF_KIND_VI: Record<string, string> = {
  "run-crashed": "Run crashed",
  "empty-run": "Run produced no posts",
  "high-fail-rate": "High failure rate",
  "stale-run": "No recent successful run",
  "budget-exceeded": "LLM budget exceeded",
  "provider-down": "Provider outage",
  "review-pending": "Posts awaiting review",
};

export function AlertsPage(props: { items: Notification[]; csrf: string }) {
  const { items, csrf } = props;
  const unread = items.filter((n) => n.readAt == null).length;
  return (
    <div class="stack-lg">
      <SectionHead title="Notifications" sub={`${items.length} notification(s)${unread ? ` - ${unread} unread` : ""}`}>
        {unread ? (
          <form method="post" action="/admin/alerts/read">
            <input type="hidden" name="csrf" value={csrf} />
            <button class="btn btn-sm" type="submit">
              <Icon name="check-circle" size={13} /> Mark all as read
            </button>
          </form>
        ) : null}
      </SectionHead>

      {items.length ? (
        <div class="card">
          <div class="notif-list">
            {items.map((n) => (
              <div class={`notif-row${n.readAt == null ? " unread" : ""}`}>
                <span class={`notif-sev sev-${n.severity}`} aria-hidden="true"></span>
                <div class="notif-main">
                  <div class="notif-title">{n.title}</div>
                  {n.body ? <div class="notif-body mono">{n.body}</div> : null}
                  <div class="notif-meta mono">{NOTIF_KIND_VI[n.kind] ?? n.kind} - {fmtTs(n.createdAt)}</div>
                </div>
                <div class="notif-actions">
                  {n.href ? (
                    <form method="post" action={`/admin/alerts/${n.id}/read`}>
                      <input type="hidden" name="csrf" value={csrf} />
                      <input type="hidden" name="href" value={n.href} />
                      <button class="btn btn-sm" type="submit">View</button>
                    </form>
                  ) : n.readAt == null ? (
                    <form method="post" action={`/admin/alerts/${n.id}/read`}>
                      <input type="hidden" name="csrf" value={csrf} />
                      <button class="btn btn-outline btn-sm" type="submit">Mark read</button>
                    </form>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div class="card">
          <EmptyState icon="bell" title="No notifications" sub="Operational alerts (failed runs, budget exceeded, provider outages) will appear here." />
        </div>
      )}
    </div>
  );
}

// ── Queue ────────────────────────────────────────────────────────────────────

const QUEUE_STATUSES = ["pending", "generating", "awaiting_review", "published", "failed", "skipped"];

// Human labels for the status filter dropdown + legend.
const STATUS_VI: Record<string, string> = {
  pending: "pending",
  generating: "generating",
  awaiting_review: "awaiting review",
  published: "published",
  failed: "failed",
  skipped: "skipped",
};

export function QueuePage(props: {
  items: ContentQueueItem[];
  categories: { slug: string; name: string }[];
  filterStatus: string;
  filterCategory: string;
  failedCount: number;
  csrf: string;
}) {
  const { items, csrf } = props;
  return (
    <div class="stack-lg">
      <SectionHead title="Post queue" sub={`${items.length} item(s) in the queue`} />

      <div class="card">
        <div class="card-head"><div class="card-title">Add topic manually</div></div>
        <form method="post" action="/admin/queue/new" class="form-row">
          <input type="hidden" name="csrf" value={csrf} />
          <div class="grow">
            <label class="eyebrow">Topic</label>
            <input type="text" name="topic" required style="width:100%" />
          </div>
          <div>
            <label class="eyebrow">Category</label>
            <select name="category" required>
              {props.categories.map((c) => <option value={c.slug}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label class="eyebrow">Keyword (optional)</label>
            <input type="text" name="keyword" />
          </div>
          <button type="submit" class="btn btn-primary"><Icon name="plus" size={15} /> Add</button>
        </form>
        <p class="field-hint" style="margin:10px 0 0">Manually added topics still go through the duplicate filter and get priority 5.</p>
      </div>

      {/* Help legend: what each status + action means. */}
      <div class="card help-card">
        <div class="card-head"><div class="card-title">Statuses &amp; actions</div></div>
        <div class="help-grid">
          <div class="help-col">
            <div class="help-h">Status</div>
            <div class="help-row"><StatusBadge s="pending" label="pending" /><span>queued, will be picked up by cron/generation</span></div>
            <div class="help-row"><StatusBadge s="generating" label="generating" /><span>being written right now</span></div>
            <div class="help-row"><StatusBadge s="awaiting_review" label="awaiting review" /><span>written, waiting for manual approval in Review</span></div>
            <div class="help-row"><StatusBadge s="published" label="published" /><span>live on the site</span></div>
            <div class="help-row"><StatusBadge s="failed" label="failed" /><span>generation failed, see 'Last error'</span></div>
            <div class="help-row"><StatusBadge s="skipped" label="skipped" /><span>marked not to be generated</span></div>
          </div>
          <div class="help-col">
            <div class="help-h">Actions</div>
            <div class="help-row"><span class="help-act pos"><Icon name="play" size={12} /> Run now</span><span>generate this item immediately and open the Run page to follow the whole pipeline</span></div>
            <div class="help-row"><span class="help-act"><Icon name="minus" size={12} /> Skip</span><span>mark as skipped - will not be generated (can Retry later)</span></div>
            <div class="help-row"><span class="help-act"><Icon name="bar-chart" size={12} /> Priority</span><span>higher numbers run first (0-99); click 'Save' to apply</span></div>
            <div class="help-row"><span class="help-act"><Icon name="refresh" size={12} /> Retry</span><span>move failed/skipped items back to 'pending'</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/admin/queue" class="form-row">
          <div>
            <label class="eyebrow">Status</label>
            <select name="status">
              <option value="">All statuses</option>
              {QUEUE_STATUSES.map((s) => <option value={s} selected={props.filterStatus === s}>{STATUS_VI[s] ?? s}</option>)}
            </select>
          </div>
          <div>
            <label class="eyebrow">Category</label>
            <select name="category">
              <option value="">All categories</option>
              {props.categories.map((c) => <option value={c.slug} selected={props.filterCategory === c.slug}>{c.name}</option>)}
            </select>
          </div>
          <button type="submit" class="btn btn-outline">Filter</button>
        </form>
      </div>

      {props.failedCount > 0 ? (
        <div class="card">
          <form method="post" action="/admin/queue/retry-failed" class="form-row" data-busy="Queueing...">
            <input type="hidden" name="csrf" value={csrf} />
            <button type="submit" class="btn btn-outline" title="Move all failed jobs back to pending and start generating in the background now">
              <Icon name="refresh" size={15} /> Retry all failed jobs ({props.failedCount})
            </button>
            <p class="field-hint" style="margin:0">
              Only applies to failed jobs with fewer than {BULK_RETRY_ATTEMPTS_CAP} attempts; jobs with {BULK_RETRY_ATTEMPTS_CAP} or more
              attempts are skipped to avoid endless loops - use the per-row 'Retry' button to force a re-run.
            </p>
          </form>
        </div>
      ) : null}

      {items.length ? (
        <div class="tbl-wrap">
          <table class="tbl">
            <tr>
              <th class="num">#</th>
              <th>Status</th>
              <th>Topic</th>
              <th>Category</th>
              <th class="num">Score</th>
              <th class="num">Priority</th>
              <th class="num">Tries</th>
              <th>Last error</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
            {items.map((q) => (
              <tr>
                <td class="num">{q.id}</td>
                <td><StatusBadge s={q.status} label={STATUS_VI[q.status] ?? q.status} /></td>
                <td>
                  <div class="cell-topic">{q.topic}</div>
                  {q.publishedSlug ? <div class="muted mono" style="font-size:11px">-&gt; {q.publishedSlug}</div> : null}
                </td>
                <td>{q.categorySlug}</td>
                <td class={`num ${scoreClass(q.qualityScore)}`}>{q.qualityScore ?? "-"}</td>
                <td class="num">{q.priority}</td>
                <td class="num">{q.attempts}</td>
                <td class="cell-err">{q.lastError ?? ""}</td>
                <td class="mono">{fmtIso(q.updatedAt ?? q.createdAt)}</td>
                <td>
                  <div class="row-actions">
                    {q.status === "pending" ? (
                      <>
                        <form method="post" action={`/admin/queue/${q.id}/run`} data-busy="Running...">
                          <input type="hidden" name="csrf" value={csrf} />
                          <button class="btn btn-success btn-sm" type="submit" title="Generate this item now and follow it on the Run page">
                            <Icon name="play" size={13} /> Run now
                          </button>
                        </form>
                        <form method="post" action={`/admin/queue/${q.id}/skip`}>
                          <input type="hidden" name="csrf" value={csrf} />
                          <button class="btn btn-outline btn-sm" type="submit" title="Mark as not to be generated (can Retry later)">Skip</button>
                        </form>
                        <form method="post" action={`/admin/queue/${q.id}/priority`} class="row-actions" title="Higher numbers run first">
                          <input type="hidden" name="csrf" value={csrf} />
                          <input type="number" name="priority" value={String(q.priority)} min="0" max="99" style="width:56px" aria-label="Priority" />
                          <button class="btn btn-outline btn-sm" type="submit">Save</button>
                        </form>
                      </>
                    ) : q.status === "failed" || q.status === "skipped" ? (
                      <form method="post" action={`/admin/queue/${q.id}/retry`}>
                        <input type="hidden" name="csrf" value={csrf} />
                        <button class="btn btn-outline btn-sm" type="submit" title="Move back to pending">Retry</button>
                      </form>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </table>
        </div>
      ) : (
        <div class="card"><EmptyState icon="list" title="Queue is empty" sub="Run the pipeline to create new ideas." /></div>
      )}
    </div>
  );
}
