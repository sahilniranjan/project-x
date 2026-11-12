"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, Database, Loader2, Square, RefreshCw, Ban, Check, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  DEFAULT_COMPANY_FILTER,
  MAX_COMPANIES_CAP,
  companyFilterCount,
  type CompanyFilter,
  type CompanyStats,
  type ExploreFilters,
  type IndexJobState,
} from "@/lib/explore";
import { KeywordField, Label } from "./filter-builder";

// Company targeting for the free scan (LOCAL). Every option list and count
// comes from the core (company-index.mjs) — this component only renders them,
// so a label shown here is always one the filter actually understands.

type ListKey = "sizes" | "industries" | "types" | "funding" | "workModels" | "regions" | "h1b";
type Option = { id: string; label: string };

const QUICK_COUNTS = [100, 500, 1000, 2500, 5000];

function fmtMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "under a minute";
  if (m < 60) return `~${Math.round(m)} min`;
  const h = m / 60;
  return `~${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)} h`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Plain toggle chip, with a live count. */
function OptionChip({ label, count, on, onClick }: { label: string; count?: number; on: boolean; onClick: () => void }) {
  const empty = !on && (count ?? 0) === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors max-sm:min-h-[44px]",
        on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
        empty && "opacity-50",
      )}
    >
      {on && <Check className="size-3" />}
      {label}
      {count !== undefined && <span className={cn("tabular-nums text-[11px]", on ? "text-brand/80" : "text-faint")}>{count.toLocaleString()}</span>}
    </button>
  );
}

/** Tri-state chip: off → include → exclude → off. */
function TriChip({ label, count, state, onClick }: { label: string; count?: number; state: "off" | "inc" | "exc"; onClick: () => void }) {
  const empty = state === "off" && (count ?? 0) === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={state === "off" ? "Click to include" : state === "inc" ? "Click again to exclude" : "Click to clear"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors max-sm:min-h-[44px]",
        state === "inc" && "border-brand/40 bg-brand-soft text-brand",
        state === "exc" && "border-border bg-surface-hover text-muted line-through decoration-1",
        state === "off" && "border-border text-muted hover:text-foreground",
        empty && "opacity-50",
      )}
    >
      {state === "inc" && <Check className="size-3" />}
      {state === "exc" && <Ban className="size-3 opacity-70" />}
      {label}
      {count !== undefined && <span className="tabular-nums text-[11px] text-faint no-underline">{count.toLocaleString()}</span>}
    </button>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label hint={hint}>{title}</Label>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[13px] text-foreground max-sm:min-h-[44px]">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-brand" />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-faint">{hint}</span>}
      </span>
    </label>
  );
}

function PercentSlider({ value, onChange, label, hint }: { value: number; onChange: (v: number) => void; label: string; hint: string }) {
  return (
    <div>
      <Label hint={value > 0 ? `at least ${value}%` : "any"}>{label}</Label>
      <input type="range" min={0} max={100} step={5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-brand" />
      <p className="text-[11px] text-faint">{hint}</p>
    </div>
  );
}

export function CompanyFilterPanel({ filters, onChange }: { filters: ExploreFilters; onChange: (f: ExploreFilters) => void }) {
  const [open, setOpen] = useState(true);
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [statsError, setStatsError] = useState("");
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<IndexJobState | null>(null);
  const c = filters.company ?? DEFAULT_COMPANY_FILTER;
  const active = companyFilterCount(c);

  const setC = (patch: Partial<CompanyFilter>) => onChange({ ...filters, company: { ...c, ...patch } });
  const toggle = (key: ListKey, id: string) => {
    const cur = c[key];
    setC({ [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } as Partial<CompanyFilter>);
  };
  const tri = (inc: "industries" | "types", exc: "excludeIndustries" | "excludeTypes", id: string) => {
    if (c[inc].includes(id)) setC({ [inc]: c[inc].filter((x) => x !== id), [exc]: [...c[exc], id] } as Partial<CompanyFilter>);
    else if (c[exc].includes(id)) setC({ [exc]: c[exc].filter((x) => x !== id) } as Partial<CompanyFilter>);
    else setC({ [inc]: [...c[inc], id] } as Partial<CompanyFilter>);
  };
  const triState = (inc: "industries" | "types", exc: "excludeIndustries" | "excludeTypes", id: string) =>
    c[inc].includes(id) ? "inc" : c[exc].includes(id) ? "exc" : "off";

  // Stats: debounced, latest-request-wins.
  const reqSeq = useRef(0);
  const statsKey = JSON.stringify({ company: c, ats: filters.ats, max: filters.maxCompanies });
  const loadStats = useCallback(async (key: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await fetch("/api/explore/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: key });
      const d = await r.json();
      if (seq !== reqSeq.current) return;
      if (!r.ok) {
        setStatsError(d.error || `Couldn't read the company index (${r.status}).`);
      } else {
        setStats(d as CompanyStats);
        setStatsError("");
      }
    } catch (e) {
      if (seq === reqSeq.current) setStatsError(e instanceof Error ? e.message : "Couldn't read the company index.");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => void loadStats(statsKey), 350);
    return () => window.clearTimeout(t);
  }, [statsKey, loadStats]);

  // Index build progress: poll while one is running, then refresh the counts.
  const pollJob = useCallback(async () => {
    try {
      const d = (await fetch("/api/explore/index", { cache: "no-store" }).then((r) => r.json())) as IndexJobState;
      setJob(d);
      return d;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void pollJob();
  }, [pollJob]);
  useEffect(() => {
    if (!job?.running) return;
    const t = window.setInterval(async () => {
      const d = await pollJob();
      if (d && !d.running) void loadStats(statsKey);
    }, 2500);
    return () => window.clearInterval(t);
  }, [job?.running, pollJob, loadStats, statsKey]);
  // Counts keep improving as the build goes — refresh them every ~30s.
  useEffect(() => {
    if (!job?.running) return;
    const t = window.setInterval(() => void loadStats(statsKey), 30000);
    return () => window.clearInterval(t);
  }, [job?.running, loadStats, statsKey]);

  const startBuild = async (staleDays?: number) => {
    const d = (await fetch("/api/explore/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staleDays }),
    }).then((r) => r.json())) as IndexJobState;
    setJob(d);
  };
  const stopBuild = async () => {
    const d = (await fetch("/api/explore/index", { method: "DELETE" }).then((r) => r.json())) as IndexJobState;
    setJob(d);
  };

  const cat = stats?.catalog;
  const fc = stats?.facets ?? {};
  const cov = stats?.coverage;
  const indexedPct = cov && cov.total ? Math.round((cov.indexed / cov.total) * 100) : 0;
  const matching = stats?.matching ?? 0;
  const maxC = filters.maxCompanies;
  const effective = maxC > 0 ? Math.min(maxC, matching) : matching;
  const setMax = (n: number) => onChange({ ...filters, maxCompanies: Math.max(0, Math.min(MAX_COMPANIES_CAP, Math.round(n))) });

  const renderList = (key: ListKey) =>
    (cat?.[key] ?? []).map((o: Option) => (
      <OptionChip key={o.id} label={o.label} count={fc[key]?.[o.id] ?? 0} on={c[key].includes(o.id)} onClick={() => toggle(key, o.id)} />
    ));

  return (
    <div className="rounded-xl border border-border bg-surface/30">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left max-sm:min-h-[44px]">
        <Building2 className="size-4 text-brand" />
        <span className="text-[13px] font-medium text-foreground">Companies to search</span>
        {active > 0 && <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold text-brand">{active}</span>}
        <span className="ml-auto truncate text-[12px] text-muted">
          {stats ? `${effective.toLocaleString()} of ${matching.toLocaleString()} matching · ${fmtMinutes(stats.estMinutes)}` : loading ? "counting…" : ""}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-3.5">
          {/* ── Index status ── */}
          <IndexCard
            stats={stats}
            job={job}
            indexedPct={indexedPct}
            onBuild={() => void startBuild()}
            onRefreshAll={() => void startBuild(0.01)}
            onStop={() => void stopBuild()}
          />
          {statsError && <p className="text-[12px] text-amber-600 dark:text-amber-400">{statsError}</p>}

          {/* ── How many ── */}
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-foreground">How many companies to scan</span>
              <span className="text-[12px] text-muted">
                {loading && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                {matching.toLocaleString()} match your filters
                {stats && stats.matching !== stats.matchingIndexed && ` (${stats.matchingIndexed.toLocaleString()} classified)`}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                max={MAX_COMPANIES_CAP}
                value={maxC > 0 ? maxC : ""}
                placeholder="All"
                onChange={(e) => setMax(Number(e.target.value) || 0)}
                className="w-28 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm tabular-nums text-foreground outline-none focus:border-brand/40 max-sm:min-h-[44px]"
                aria-label="Number of companies to scan"
              />
              {QUICK_COUNTS.filter((n) => n < matching).map((n) => (
                <OptionChip key={n} label={n.toLocaleString()} on={maxC === n} onClick={() => setMax(n)} />
              ))}
              <OptionChip label={`All ${matching.toLocaleString()}`} on={maxC === 0 || maxC >= matching} onClick={() => setMax(0)} />
            </div>
            {matching > 0 && (
              <input
                type="range"
                min={1}
                max={matching}
                step={Math.max(1, Math.round(matching / 200))}
                value={Math.min(effective || matching, matching)}
                onChange={(e) => setMax(Number(e.target.value) >= matching ? 0 : Number(e.target.value))}
                className="mt-2 w-full accent-brand"
                aria-label="Companies to scan"
              />
            )}
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-faint">
              <Info className="mt-px size-3 shrink-0" />
              <span>
                Scans the <b className="font-medium text-muted">{effective.toLocaleString()}</b> highest-priority matches first — boards that matched you before, then ones with more open roles and more engineering
                hiring. Estimated {stats ? fmtMinutes(stats.estMinutes) : "…"}
                {stats && effective < matching ? ` (all ${matching.toLocaleString()}: ${fmtMinutes(stats.estMinutesAll)})` : ""}. Long scans run in the background — you can leave this page.
              </span>
            </p>
          </div>

          {!cat ? (
            <p className="text-[12px] text-faint">{loading ? "Loading company filters…" : "Company filters appear once the index can be read."}</p>
          ) : (
            <>
              <Group title="Hiring size" hint="open roles on their board — a proxy for company size">
                {renderList("sizes")}
              </Group>

              <Group title="Industry" hint="click once to include, twice to exclude">
                {cat.industries.map((o) => (
                  <TriChip key={o.id} label={o.label} count={fc.industries?.[o.id] ?? 0} state={triState("industries", "excludeIndustries", o.id)} onClick={() => tri("industries", "excludeIndustries", o.id)} />
                ))}
              </Group>

              <Group title="Company type" hint="click once to include, twice to exclude">
                {cat.types.map((o) => (
                  <TriChip key={o.id} label={o.label} count={fc.types?.[o.id] ?? 0} state={triState("types", "excludeTypes", o.id)} onClick={() => tri("types", "excludeTypes", o.id)} />
                ))}
              </Group>

              <Group title="Funding & backing" hint="from posting language + YC / a16z lists">
                {renderList("funding")}
              </Group>

              <div className="grid gap-5 sm:grid-cols-2">
                <Group title="Work model" hint="share of remote postings">
                  {renderList("workModels")}
                </Group>
                <Group title="H-1B sponsorship" hint="your local DOL filing index">
                  {renderList("h1b")}
                </Group>
              </div>

              <Group title="Hires in" hint="where their open roles are located">
                {renderList("regions")}
              </Group>

              <div className="grid gap-5 sm:grid-cols-2">
                <PercentSlider
                  label="US share of roles"
                  value={c.minUsShare}
                  onChange={(v) => setC({ minUsShare: v })}
                  hint="Skip companies that mostly hire outside the US."
                />
                <PercentSlider
                  label="Engineering / data share"
                  value={c.minEngShare}
                  onChange={(v) => setC({ minEngShare: v })}
                  hint="Tech-heavy companies: share of roles that are engineering, data, ML."
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>Only companies named</Label>
                  <KeywordField values={c.nameInclude} tone="inc" placeholder="stripe, openai…" onChange={(v) => setC({ nameInclude: v })} />
                </div>
                <div>
                  <Label>Never these companies</Label>
                  <KeywordField values={c.nameExclude} tone="exc" placeholder="acme…" onChange={(v) => setC({ nameExclude: v })} />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle on={c.entryLevel} onChange={(v) => setC({ entryLevel: v })} label="Has entry-level / new-grad / intern roles" hint="at least one early-career posting when indexed" />
                <Toggle on={c.skipApplied} onChange={(v) => setC({ skipApplied: v })} label="Skip companies already in my tracker" />
                <Toggle on={c.skipEmpty} onChange={(v) => setC({ skipEmpty: v })} label="Skip boards with no open roles" hint="they can't produce a match — big time saver" />
                <Toggle
                  on={c.includeUnknown}
                  onChange={(v) => setC({ includeUnknown: v })}
                  label="Include unclassified companies"
                  hint="not indexed yet, or no signal for a filter — off = strict"
                />
              </div>

              {active > 0 && (
                <button
                  type="button"
                  onClick={() => onChange({ ...filters, company: { ...DEFAULT_COMPANY_FILTER } })}
                  className="text-[12px] text-muted underline-offset-2 hover:text-foreground hover:underline"
                >
                  Clear company filters
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IndexCard({
  stats,
  job,
  indexedPct,
  onBuild,
  onRefreshAll,
  onStop,
}: {
  stats: CompanyStats | null;
  job: IndexJobState | null;
  indexedPct: number;
  onBuild: () => void;
  onRefreshAll: () => void;
  onStop: () => void;
}) {
  const cov = stats?.coverage;
  if (job?.running) {
    const pct = job.total ? Math.round(((job.done ?? 0) / job.total) * 100) : 0;
    return (
      <div className="rounded-lg border border-brand/30 bg-brand-soft/40 p-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
          <Loader2 className="size-3.5 animate-spin text-brand" />
          {job.phase === "enrich"
            ? "Joining H-1B filings and VC lists…"
            : `Indexing companies — ${(job.done ?? 0).toLocaleString()} of ${(job.total ?? 0).toLocaleString()}${job.ats ? ` (${job.ats})` : ""}`}
          {job.etaMin != null && job.phase !== "enrich" && <span className="text-[12px] text-muted">· {fmtMinutes(job.etaMin)} left</span>}
          <button type="button" onClick={onStop} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:text-foreground max-sm:min-h-[44px]">
            <Square className="size-3" /> Stop
          </button>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] text-faint">Free — reads each public board once. Runs in the background; filters fill in as it goes. Stopping keeps what's done.</p>
      </div>
    );
  }
  const never = !cov || cov.indexed === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface/40 p-3">
      <Database className="size-4 text-muted" />
      <div className="min-w-0 flex-1 text-[13px]">
        {never ? (
          <>
            <span className="font-medium text-foreground">Company index not built yet.</span>{" "}
            <span className="text-muted">
              Size, industry, type and sponsorship filters need one pass over the {cov ? cov.total.toLocaleString() : "~28,000"} public boards (free, roughly an hour, runs in the background).
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {cov.indexed.toLocaleString()} of {cov.total.toLocaleString()} companies indexed ({indexedPct}%)
            </span>
            <span className="text-muted"> · {cov.unreachable.toLocaleString()} dead/unreachable boards skipped · updated {ago(stats?.index.updatedAt)}</span>
          </>
        )}
        {job?.phase === "error" && job.error && <span className="block text-[12px] text-amber-600 dark:text-amber-400">Last build failed: {job.error}</span>}
        {job?.phase === "cancelled" && <span className="block text-[12px] text-faint">Last build was stopped — Continue picks up where it left off.</span>}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBuild}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-brand-foreground transition hover:brightness-110 max-sm:min-h-[44px]"
        >
          <Database className="size-3.5" /> {never ? "Build index" : indexedPct < 100 ? "Continue indexing" : "Refresh stale"}
        </button>
        {!never && (
          <button
            type="button"
            onClick={onRefreshAll}
            title="Re-read every board, even ones indexed recently"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted hover:text-foreground max-sm:min-h-[44px]"
          >
            <RefreshCw className="size-3.5" /> Rebuild all
          </button>
        )}
      </div>
    </div>
  );
}
