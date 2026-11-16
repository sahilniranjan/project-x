"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_FILTERS,
  ATS_LABEL,
  filtersToParams,
  aiToParams,
  isBroadSearch,
  parseExplorePatch,
  companyFilterCount,
  type AtsSource,
  type DiscoveredOffer,
  type ExploreFilters,
  type ExploreMode,
  type ScanEvent,
} from "@/lib/explore";
import { makeAiStreamParser, type AiTraceChunk } from "@/lib/explore-ai";
import { MAX_OFFER_LIMIT } from "@/lib/whats-new.mjs";
import { isScannerMissing } from "@/lib/explore-error.mjs";

export type Phase =
  | "idle"
  | "casting"
  | "scanning"
  | "revealing"
  | "results"
  | "empty-current"
  | "empty-loose"
  | "failed"
  | "degraded" // scan completed but searched nothing (transient fetch/rate-limit) — not "all caught up"
  | "hunting" // AI search streaming
  | "blocked"; // AI search needs a CLI
export type AiCost = { searches: number; candidates: number; fetches: number };
// One board the scanner has actually walked. Fed by the --trace lines the core
// emits per company, so the scanning screen can name what it is touching right
// now instead of showing an opaque spinner for four minutes.
export type ScanTraceEntry = { id: number; ats: string; company: string; postings: number };

export type SourceState = {
  state: "queued" | "active" | "swept" | "noisy";
  companies?: number;
  done?: number;
  total?: number;
  matches?: number;
  unreachable?: number;
};

type ExploreCtx = {
  filters: ExploreFilters;
  setFilters: (f: ExploreFilters) => void;
  /** Set filters from a seed/URL only if the user/assistant hasn't touched them
   *  yet — so a fresh page mount can't clobber assistant-set filters. */
  initFilters: (f: ExploreFilters) => void;
  phase: Phase;
  running: boolean;
  offers: DiscoveredOffer[];
  sources: Partial<Record<AtsSource, SourceState>>;
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  status: string;
  partial: boolean;
  error: string;
  /** The failure was the structured "scanner absent from this checkout" 400,
   *  not a runtime scan error, so it drives the "full toolkit" panel over a retry. */
  scannerMissing: boolean;
  added: Set<string>;
  adding: Set<string>;
  discover: () => Promise<void>;
  /** Stop the running background scan (results so far are kept). */
  cancelScan: () => Promise<void>;
  /** The company selection the running/last scan walked. */
  selection: { selected: number; matching: number; estMinutes: number } | null;
  /** Load the SUPPLY-loop offers Today's "Fresh matches this week" already
   *  fetched from /api/whats-new, straight into the results phase — no scan. */
  loadFresh: () => Promise<void>;
  addToPipeline: (offers: DiscoveredOffer[]) => Promise<number>;
  applyPatch: (raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void;
  reset: () => void;
  // ── AI search (modes/discover.md) ──
  mode: ExploreMode;
  setMode: (m: ExploreMode) => void;
  aiIntent: string;
  setAiIntent: (s: string) => void;
  discoverAI: () => Promise<void>;
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  scanTrace: ScanTraceEntry[];
};

// Deep enough to scroll back through a stall, shallow enough to stay cheap.
const SCAN_TRACE_MAX = 120;
// Running background scan, so a reload re-attaches instead of starting over.
const JOB_KEY = "project-x:explore-job";
const POLL_MS = 1200;

const Ctx = createContext<ExploreCtx | null>(null);
export function useExplore(): ExploreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useExplore must be used within <ExploreProvider>");
  return c;
}

// Explore results are expensive (a scan walks the ATS network; an AI search spends
// tokens). Persist the SETTLED result set per-tab so a reload or a mode toggle never
// throws the work away (disc#5 — "came back to explore, work is lost").
const RESULTS_KEY = "project-x:explore-results";
type ResultSnapshot = {
  v: number;
  mode: ExploreMode;
  phase: Phase;
  offers: DiscoveredOffer[];
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  sources: Partial<Record<AtsSource, SourceState>>;
  partial: boolean;
  status: string;
  error: string;
  scannerMissing: boolean;
  added: string[];
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  aiIntent: string;
};

export function ExploreProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [filters, setFiltersState] = useState<ExploreFilters>({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] });
  const touched = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [offers, setOffers] = useState<DiscoveredOffer[]>([]);
  const [sources, setSources] = useState<Partial<Record<AtsSource, SourceState>>>({});
  const [matchCount, setMatchCount] = useState(0);
  const [companiesScanned, setCompaniesScanned] = useState(0);
  // Authoritative scan-health signals (scanner --json mode, #1199): tell a capped /
  // degraded scan from a genuinely empty one, and power a "scanned X of Y" banner.
  const [companiesAvailable, setCompaniesAvailable] = useState(0);
  const [capHit, setCapHit] = useState(false);
  const [droppedNoDate, setDroppedNoDate] = useState(0);
  const [status, setStatus] = useState("");
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState("");
  const [scannerMissing, setScannerMissing] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [mode, setModeState] = useState<ExploreMode>("scan");
  const [aiIntent, setAiIntent] = useState("");
  const [aiTrace, setAiTrace] = useState<AiTraceChunk[]>([]);
  // Bounded: a wide sweep walks thousands of boards and we only ever render
  // the tail, so the array is capped rather than grown for the whole run.
  const [scanTrace, setScanTrace] = useState<ScanTraceEntry[]>([]);
  // Monotonic. Deriving the key from array length breaks as soon as the list is
  // capped: length freezes at SCAN_TRACE_MAX and every later row reuses that key.
  const scanSeqRef = useRef(0);
  const [aiCost, setAiCost] = useState<AiCost>({ searches: 0, candidates: 0, fetches: 0 });
  const runningRef = useRef(false);
  const jobIdRef = useRef<string | null>(null);
  const [selection, setSelection] = useState<{ selected: number; matching: number; estMinutes: number } | null>(null);
  const aiIntentRef = useRef(aiIntent);
  aiIntentRef.current = aiIntent;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setFilters = useCallback((f: ExploreFilters) => {
    touched.current = true;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);
  const initFilters = useCallback((f: ExploreFilters) => {
    if (touched.current) return;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);

  // Background scan job (LOCAL): start it server-side, then follow its events by
  // cursor. The scan no longer lives inside one HTTP response, so a multi-hour
  // sweep survives navigation, a reload, or a sleeping tab.
  const follow = useCallback(async (jobId: string, f: ExploreFilters) => {
    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let companiesScannedAcc = 0; // 0 at the end = the directories never downloaded → degraded, not empty
    let capHitAcc = false; // scan was capped (only a slice of the universe searched)
    let datasetIssueAcc = false; // some ATS dataset was stale/empty/unreachable
    let droppedNoDateAcc = 0; // postings dropped for lacking a publish date
    let finalOffers: DiscoveredOffer[] | null = null;
    jobIdRef.current = jobId;

    const handle = (ev: ScanEvent) => {
      switch (ev.kind) {
        case "selection":
          setSelection({ selected: ev.selected, matching: ev.matching, estMinutes: ev.estMinutes });
          setStatus(`Scanning the top ${ev.selected.toLocaleString()} of ${ev.matching.toLocaleString()} matching companies…`);
          break;
        case "atsStart":
          setPhase("scanning");
          setStatus(`Walking ${ATS_LABEL[ev.ats as AtsSource] ?? ev.ats} — ${ev.companies.toLocaleString()} companies`);
          setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", companies: ev.companies } }));
          break;
        case "progress":
          // `matches` is the GLOBAL running total (the engine batches the
          // offer list to the very end), so it drives the live hero counter.
          setMatchCount((m) => Math.max(m, ev.matches));
          setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", done: ev.scanned, total: ev.total } }));
          break;
        case "atsDone":
          setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: ev.unreachable > 0 ? "noisy" : "swept", unreachable: ev.unreachable } }));
          break;
        case "company": {
          // Read outside the updater: React may invoke it twice in dev.
          const id = ++scanSeqRef.current;
          setScanTrace((t) => {
            const next = [...t, { id, ats: ev.ats, company: ev.company, postings: ev.postings }];
            return next.length > SCAN_TRACE_MAX ? next.slice(-SCAN_TRACE_MAX) : next;
          });
          break;
        }
        case "offer":
          acc.push(ev.offer);
          setOffers((o) => [...o, ev.offer]);
          break;
        case "summary": {
          companiesScannedAcc = ev.companiesScanned;
          setCompaniesScanned(ev.companiesScanned);
          if (typeof ev.companiesAvailable === "number") setCompaniesAvailable(ev.companiesAvailable);
          if (ev.capHit) {
            capHitAcc = true;
            setCapHit(true);
          }
          const datasetIssue = ev.datasetStatus ? Object.values(ev.datasetStatus).some((s) => s !== "ok") : false;
          if (datasetIssue) datasetIssueAcc = true;
          if (typeof ev.postingsDroppedNoDate === "number" && ev.postingsDroppedNoDate > 0) {
            droppedNoDateAcc = ev.postingsDroppedNoDate;
            setDroppedNoDate(ev.postingsDroppedNoDate);
          }
          if (ev.unreachable > 0 || datasetIssue) setPartial(true);
          break;
        }
        case "error":
          sawError = ev.message;
          break;
        case "done":
          finalOffers = ev.offers;
          break;
        default:
          break;
      }
    };

    let cursor = 0;
    let misses = 0;
    for (;;) {
      if (jobIdRef.current !== jobId) return; // superseded by reset()/a new run
      try {
        const r = await fetch(`/api/explore/jobs?id=${encodeURIComponent(jobId)}&cursor=${cursor}`, { cache: "no-store" });
        if (r.status === 404) {
          sawError = "This scan is no longer running — the panel restarted while it was in progress. Start it again to pick up from the top.";
          break;
        }
        if (!r.ok) throw new Error(`poll ${r.status}`);
        const d = (await r.json()) as { events: ScanEvent[]; next: number; done: boolean };
        misses = 0;
        for (const ev of d.events) handle(ev);
        cursor = d.next;
        if (d.done) break;
      } catch (e) {
        // The server is local; a few missed polls (sleep, restart) are normal.
        if (++misses > 30) {
          sawError = e instanceof Error ? e.message : "lost contact with the scan";
          break;
        }
      }
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    if (jobIdRef.current !== jobId) return;
    jobIdRef.current = null;
    try {
      sessionStorage.removeItem(JOB_KEY);
    } catch {
      /* ignore */
    }

    // The done event's list is authoritative (late filtering — blacklist,
    // content rules — happens after the per-offer events).
    const list: DiscoveredOffer[] = finalOffers ?? acc;
    if (finalOffers) setOffers(finalOffers);

    // Mark any still-active sources as swept (stream ended).
    setSources((s) => {
      const next = { ...s };
      for (const k of Object.keys(next) as AtsSource[]) if (next[k]?.state === "active" || next[k]?.state === "queued") next[k] = { ...next[k]!, state: "swept" };
      return next;
    });

    runningRef.current = false;
    if (list.length > 0) {
      setMatchCount(list.length);
      if (sawError) setError(sawError);
      setPhase("revealing");
      setStatus(`${list.length} fresh role${list.length === 1 ? "" : "s"} found — free.`);
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setPhase("failed");
    } else if (capHitAcc || datasetIssueAcc || droppedNoDateAcc > 0 || companiesScannedAcc === 0) {
      // Maintainer's RULE (#1199): it is NOT "all caught up" if the scan was capped,
      // a dataset was stale/unreachable, postings were dropped for missing a date, OR
      // nothing was searched at all (legacy 0-companies fallback when --json is absent).
      // Truly-empty is only when live datasets were fully searched and found nothing.
      setPhase("degraded");
    } else {
      setPhase(isBroadSearch(f) && companyFilterCount(f.company) === 0 ? "empty-current" : "empty-loose");
    }
  }, []);

  const beginRun = useCallback((f: ExploreFilters) => {
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setScanTrace([]);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setSelection(null);
    setStatus("Picking companies that match your filters…");
    const init: Partial<Record<AtsSource, SourceState>> = {};
    for (const a of f.ats) init[a] = { state: "queued" };
    setSources(init);
  }, []);

  const discover = useCallback(async () => {
    if (runningRef.current) return;
    const f = filtersRef.current;
    beginRun(f);
    if (typeof window !== "undefined") {
      const qs = filtersToParams(f);
      window.history.replaceState(null, "", `/explore${qs ? `?${qs}` : ""}`);
    }
    let id = "";
    try {
      const r = await fetch("/api/explore/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      // Every non-OK response is decided from the parsed body, not the status.
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) {
        const missing = isScannerMissing(d);
        runningRef.current = false;
        setError(d.error || (missing ? "The scanner isn't available." : `Discovery failed (${r.status}).`));
        setScannerMissing(missing);
        setPhase("failed");
        return;
      }
      id = d.id;
    } catch (e) {
      runningRef.current = false;
      setError(e instanceof Error ? e.message : "Couldn't start the scan.");
      setPhase("failed");
      return;
    }
    try {
      sessionStorage.setItem(JOB_KEY, JSON.stringify({ id, filters: f }));
    } catch {
      /* ignore */
    }
    await follow(id, f);
  }, [beginRun, follow]);

  /** Stop the running scan; what it found so far still comes back as results. */
  const cancelScan = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    setStatus("Stopping — keeping what was found so far…");
    try {
      await fetch(`/api/explore/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* the poll loop still settles */
    }
  }, []);

  // Re-attach to a scan that is still running server-side (reload, new tab,
  // came back later). The job replays its events from cursor 0, so the
  // progress screen rebuilds exactly.
  useEffect(() => {
    if (runningRef.current) return;
    let cancelled = false;
    (async () => {
      let saved: { id?: string; filters?: ExploreFilters } | null = null;
      try {
        saved = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null");
      } catch {
        saved = null;
      }
      let id = saved?.id || "";
      if (!id) {
        try {
          const d = await fetch("/api/explore/jobs", { cache: "no-store" }).then((r) => r.json());
          id = d?.id || "";
        } catch {
          id = "";
        }
      }
      if (!id || cancelled || runningRef.current) return;
      const probe = await fetch(`/api/explore/jobs?id=${encodeURIComponent(id)}&cursor=0`, { cache: "no-store" }).catch(() => null);
      if (!probe || !probe.ok || cancelled || runningRef.current) return;
      const d = (await probe.json()) as { done: boolean; filters?: ExploreFilters };
      // A finished job's results are already in the settled-results snapshot.
      if (d.done) {
        try {
          sessionStorage.removeItem(JOB_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      const f = parseExplorePatch((d.filters ?? saved?.filters ?? {}) as Record<string, unknown>, DEFAULT_FILTERS);
      setModeState("scan");
      filtersRef.current = f;
      setFiltersState(f);
      touched.current = true;
      beginRun(f);
      setPhase("scanning");
      await follow(id, f);
    })();
    return () => {
      cancelled = true;
    };
  }, [beginRun, follow]);

  // Today's "See all N" link (#84) routes here with ?view=fresh instead of leaving
  // the user on a bare config form. Re-fetch the same free, zero-token /api/whats-new
  // history the dashboard already reads and drop it straight into the results phase
  // — no scan, so it never touches sources/companiesScanned like discover() does.
  const loadFresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("casting");
    setStatus("Loading fresh matches…");
    setOffers([]);
    setMatchCount(0);
    setScanTrace([]);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setSources({});
    setError("");
    try {
      // A finite ceiling, not `all`: explorer-view renders every offer it gets,
      // so an unbounded list would be an unbounded DOM. `count` below stays the
      // complete total, which is what the header actually reports.
      const r = await fetch(`/api/whats-new?limit=${MAX_OFFER_LIMIT}`);
      if (!r.ok) {
        setError(`Couldn't load fresh matches (${r.status}).`);
        setPhase("failed");
        return;
      }
      const d = await r.json().catch(() => null);
      if (!d || !Array.isArray(d.offers)) {
        setError("Couldn't load fresh matches — unexpected response.");
        setPhase("failed");
        return;
      }
      const list: DiscoveredOffer[] = d.offers;
      setOffers(list);
      const count = Number(d.count);
      setMatchCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : list.length);
      setPhase(list.length > 0 ? "results" : "empty-current");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load fresh matches.");
      setPhase("failed");
    } finally {
      runningRef.current = false;
    }
  }, []);

  const addToPipeline = useCallback(async (list: DiscoveredOffer[]) => {
    const fresh = list.filter((o) => !added.has(o.url));
    if (fresh.length === 0) return 0;
    setAdding((s) => new Set([...s, ...fresh.map((o) => o.url)]));
    try {
      const r = await fetch("/api/explore/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offers: fresh }),
      });
      const d = (await r.json()) as { added?: number };
      if (d.added && d.added > 0) {
        setAdded((s) => new Set([...s, ...fresh.map((o) => o.url)]));
        // The new inbox rows were written server-side. Invalidate the Next router
        // cache so the (server-rendered) Pipeline view shows them instead of a stale
        // snapshot, and ping live listeners (today's dashboard, pipeline provider) —
        // otherwise the user adds a job, opens Pipeline, and sees it empty (disc#5).
        router.refresh();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "explore-add" } }));
        }
      }
      return d.added ?? 0;
    } catch {
      return 0;
    } finally {
      setAdding((s) => {
        const next = new Set(s);
        for (const o of fresh) next.delete(o.url);
        return next;
      });
    }
  }, [added, router]);

  const applyPatch = useCallback((raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => {
    const next = parseExplorePatch(raw, filtersRef.current, opts?.merge ?? false);
    setFilters(next);
    filtersRef.current = next;
    if (opts?.run) void discover();
  }, [discover]);

  const reset = useCallback(() => {
    runningRef.current = false;
    jobIdRef.current = null;
    setPhase("idle");
    setOffers([]);
    setSources({});
    setMatchCount(0);
    setScanTrace([]);
    setCompaniesScanned(0);
    setStatus("");
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    try {
      sessionStorage.removeItem(RESULTS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // AI search — orchestrate modes/discover.md via the user's CLI, streamed.
  const discoverAI = useCallback(async () => {
    if (runningRef.current) return;
    const intent = aiIntentRef.current.trim();
    if (!intent) return;
    let cliId: string | null = null;
    try {
      cliId = JSON.parse(localStorage.getItem("project-x:config") || "{}").cliId || null;
    } catch {
      cliId = null;
    }
    if (!cliId) {
      setPhase("blocked");
      return;
    }
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setScanTrace([]);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    setError("");
    setScannerMissing(false);
    setStatus("Casting across the open web…");
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/explore?${aiToParams(intent)}`);

    let knownUrls = new Set<string>();
    try {
      const k = await fetch("/api/explore/ai/known").then((r) => r.json());
      knownUrls = new Set<string>(Array.isArray(k.urls) ? k.urls : []);
    } catch {
      /* best-effort dedup */
    }
    const parser = makeAiStreamParser({ knownUrls });

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false; // the structured 400 (capability absent from this checkout), not a runtime error
    const handle = (chunks: AiTraceChunk[]) => {
      for (const ch of chunks) {
        if (ch.kind === "offer") {
          acc.push(ch.offer);
          setOffers((o) => [...o, ch.offer]);
          setMatchCount(acc.length);
          setAiCost((c) => ({ ...c, candidates: acc.length }));
          setPhase("hunting");
        } else {
          setAiTrace((t) => [...t, ch]);
          if (ch.kind === "narration") {
            const s = (ch.text.match(/\bsearch(ing|ed)?\b/gi) || []).length;
            const f = (ch.text.match(/\bfetch(ing|ed)?\b/gi) || []).length;
            if (s || f) setAiCost((c) => ({ ...c, searches: c.searches + s, fetches: c.fetches + f }));
            setPhase((p) => (p === "casting" ? "hunting" : p));
          }
        }
      }
    };

    try {
      const r = await fetch("/api/explore/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: intent, cliId }),
      });
      if (r.status === 404) {
        runningRef.current = false;
        setPhase("blocked");
        return;
      }
      // Same rule as the scan path, and this is the call site the status-based
      // check actually broke: /api/explore/ai returns three different 400s
      // (malformed JSON, missing parameters, MODE_MISSING), and all three were
      // reported as "this checkout has no scanner". MODE_MISSING carries its own
      // copy about AI search, which the scanner panel overwrote.
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = d.error || (sawScannerMissing ? "AI search isn't available." : `AI search failed (${r.status}).`);
      } else if (!r.body) {
        sawError = "No response stream.";
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          handle(parser.feed(dec.decode(value, { stream: true })));
        }
        handle(parser.flush());
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : "stream error";
    }

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(`${acc.length} candidate${acc.length === 1 ? "" : "s"} found.`);
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setScannerMissing(sawScannerMissing);
      setPhase("failed");
    } else {
      setPhase("empty-loose");
    }
  }, []);

  // Switch surface but PRESERVE the current results + filters — toggling scan↔AI must
  // not throw away a completed search (disc#5). A new search (discover/discoverAI)
  // clears + repopulates; an explicit reset() clears. Just stop any half-run.
  const setMode = useCallback((m: ExploreMode) => {
    runningRef.current = false;
    setModeState(m);
  }, []);

  // Rehydrate the last settled result set on mount (per-tab sessionStorage), unless a
  // search is already running. Done in an effect (not a useState initializer) to avoid
  // an SSR hydration mismatch.
  useEffect(() => {
    if (runningRef.current) return;
    let snap: ResultSnapshot | null = null;
    try {
      snap = JSON.parse(sessionStorage.getItem(RESULTS_KEY) || "null") as ResultSnapshot | null;
    } catch {
      snap = null;
    }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.offers)) return;
    setModeState(snap.mode === "ai" ? "ai" : "scan");
    setOffers(snap.offers);
    setMatchCount(typeof snap.matchCount === "number" ? snap.matchCount : snap.offers.length);
    setCompaniesScanned(snap.companiesScanned ?? 0);
    setCompaniesAvailable(snap.companiesAvailable ?? 0);
    setCapHit(!!snap.capHit);
    setDroppedNoDate(snap.droppedNoDate ?? 0);
    setSources(snap.sources ?? {});
    setPartial(!!snap.partial);
    setStatus(typeof snap.status === "string" ? snap.status : "");
    setError(typeof snap.error === "string" ? snap.error : "");
    setScannerMissing(!!snap.scannerMissing);
    setAdded(new Set(Array.isArray(snap.added) ? snap.added : []));
    setAiTrace(Array.isArray(snap.aiTrace) ? snap.aiTrace : []);
    setAiCost(snap.aiCost ?? { searches: 0, candidates: 0, fetches: 0 });
    if (typeof snap.aiIntent === "string") setAiIntent(snap.aiIntent);
    // Never rehydrate INTO a running phase — no live stream backs it.
    const RUNNING = new Set<Phase>(["casting", "scanning", "revealing", "hunting"]);
    setPhase(RUNNING.has(snap.phase) ? (snap.offers.length ? "results" : "idle") : snap.phase);
  }, []);

  // Persist only SETTLED states (never mid-stream) so a reload restores a complete set.
  useEffect(() => {
    const SETTLED = new Set<Phase>(["results", "empty-current", "empty-loose", "failed", "degraded", "blocked"]);
    if (!SETTLED.has(phase)) return;
    try {
      const snap: ResultSnapshot = {
        v: 1, mode, phase, offers, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, sources,
        partial, status, error, scannerMissing, added: [...added], aiTrace, aiCost, aiIntent,
      };
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(snap));
    } catch {
      /* sessionStorage full/unavailable — non-fatal */
    }
  }, [phase, mode, offers, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, sources, partial, status, error, scannerMissing, added, aiTrace, aiCost, aiIntent]);

  const value = useMemo(
    () => ({
      filters, setFilters, initFilters, phase,
      running: phase === "casting" || phase === "scanning" || phase === "revealing" || phase === "hunting",
      offers, sources, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, status, partial, error, scannerMissing, added, adding,
      discover, cancelScan, selection, loadFresh, addToPipeline, applyPatch, reset,
      mode, setMode, aiIntent, setAiIntent, discoverAI, aiTrace, aiCost, scanTrace,
    }),
    [filters, setFilters, initFilters, phase, offers, sources, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, status, partial, error, scannerMissing, added, adding, discover, cancelScan, selection, loadFresh, addToPipeline, applyPatch, reset, mode, setMode, aiIntent, discoverAI, aiTrace, aiCost, scanTrace],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
