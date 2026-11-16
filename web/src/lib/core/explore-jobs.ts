import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { projectXRoot } from "@/lib/project-x";
import { runDiscovery } from "./scan";
import { selectCompanies, removeSelection } from "./company-index";
import type { DiscoveredOffer, ExploreFilters, ScanEvent } from "@/lib/explore";

/**
 * Background scan jobs (LOCAL). A filtered scan can now cover thousands of
 * boards — hours, not minutes — so it can't live inside one HTTP request the
 * browser has to hold open. The job runs in this (long-lived, launchd-managed)
 * server process; the page polls for events by cursor and can leave and come
 * back. A panel restart ends the job: that is reported, not hidden.
 *
 * Events use the exact ScanEvent grammar the streaming route used, so the
 * client's event handling is unchanged.
 */

export type ScanJob = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  filters: ExploreFilters;
  events: ScanEvent[];
  done: boolean;
  cancelled: boolean;
  child: ChildProcess | null;
  /** positions of `company` events, oldest first — for the trace cap */
  companyAt: number[];
};

type Registry = { jobs: Map<string, ScanJob>; active: string | null };
const g = globalThis as unknown as { __coScanJobs?: Registry };
function reg(): Registry {
  if (!g.__coScanJobs) g.__coScanJobs = { jobs: new Map(), active: null };
  return g.__coScanJobs;
}

// A finished job's events stay pollable this long, so a tab that was asleep
// still gets its results.
const KEEP_FINISHED_MS = 6 * 3_600_000;
// The per-company --trace feed is the bulk of a long run's events and the page
// only ever shows the tail; cap what we hold.
const MAX_COMPANY_EVENTS = 4000;

function gc() {
  const r = reg();
  const now = Date.now();
  for (const [id, j] of r.jobs) if (j.done && j.finishedAt && now - j.finishedAt > KEEP_FINISHED_MS) r.jobs.delete(id);
}

export function activeScanJob(): ScanJob | null {
  const r = reg();
  const j = r.active ? r.jobs.get(r.active) : null;
  return j && !j.done ? j : null;
}

export function getScanJob(id: string): ScanJob | null {
  gc();
  return reg().jobs.get(id) ?? null;
}

/** Start a scan. Only one runs at a time — a second start returns the running one. */
export function startScanJob(filters: ExploreFilters): { job: ScanJob; alreadyRunning: boolean } {
  gc();
  const r = reg();
  const running = activeScanJob();
  if (running) return { job: running, alreadyRunning: true };
  const job: ScanJob = { id: randomUUID(), startedAt: Date.now(), filters, events: [], done: false, cancelled: false, child: null, companyAt: [] };
  r.jobs.set(job.id, job);
  r.active = job.id;
  void run(job);
  return { job, alreadyRunning: false };
}

export function cancelScanJob(id: string): boolean {
  const j = reg().jobs.get(id);
  if (!j || j.done) return false;
  j.cancelled = true;
  try {
    j.child?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  return true;
}

function push(job: ScanJob, e: ScanEvent) {
  if (e.kind === "log") return; // stderr noise — the client ignores it anyway
  if (e.kind === "company") {
    job.companyAt.push(job.events.length);
    if (job.companyAt.length > MAX_COMPANY_EVENTS) {
      // Blank the oldest trace line in place: positions are the polling
      // cursor, so the array must never shift.
      const i = job.companyAt.shift()!;
      job.events[i] = { kind: "log", line: "" };
    }
  }
  job.events.push(e);
}

async function run(job: ScanJob) {
  const f = job.filters;
  push(job, { kind: "start", ats: f.ats, sinceDays: f.sinceDays, limit: f.maxCompanies, free: true });
  let selFile = "";
  let offers: DiscoveredOffer[] = [];
  const rates = new RateMeter();
  try {
    const sel = await selectCompanies(f.company, f.ats, f.maxCompanies);
    selFile = sel.file;
    push(job, { kind: "selection", selected: sel.selected, matching: sel.matching, estMinutes: sel.estMinutes, perAts: sel.perAts });
    if (sel.selected === 0) {
      push(job, { kind: "error", message: "No companies match your company filters. Loosen them (or turn on “Include unclassified companies”) and try again." });
    } else if (!job.cancelled) {
      // Size-scaled backstop against a hung child, never a budget: 3× the
      // estimate, at least 30 min, at most 24 h.
      const timeoutMs = Math.min(24 * 3_600_000, Math.max(1_800_000, sel.estMinutes * 3 * 60_000));
      offers = await runDiscovery(
        f,
        (e) => {
          rates.observe(e);
          // A cancel kill surfaces as "stopped early" — replace it with the truth below.
          if (job.cancelled && e.kind === "error") return;
          push(job, e);
        },
        { companiesFile: sel.file, timeoutMs, onChild: (c) => (job.child = c) },
      );
      if (job.cancelled) {
        push(job, { kind: "error", message: offers.length ? `Scan stopped — showing the ${offers.length} role${offers.length === 1 ? "" : "s"} found before you stopped it.` : "Scan stopped before anything matched." });
      }
    }
  } catch (err) {
    push(job, { kind: "error", message: err instanceof Error ? err.message : "discovery failed" });
  } finally {
    if (selFile) removeSelection(selFile);
    if (!job.cancelled) rates.save();
    push(job, { kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } });
    job.done = true;
    job.child = null;
    job.finishedAt = Date.now();
  }
}

/**
 * Measures boards/minute per source from the scan's own progress events and
 * folds it into data/cache/scan-rates.json, which company-index.mjs reads for
 * its time estimates — so "~40 min" gets more honest every scan.
 */
class RateMeter {
  private cur: { ats: string; t0: number; done: number } | null = null;
  private samples: Record<string, { boards: number; ms: number }> = {};
  observe(e: ScanEvent) {
    if (e.kind === "atsStart") {
      this.close();
      this.cur = { ats: e.ats, t0: Date.now(), done: 0 };
    } else if (e.kind === "progress" && this.cur && e.ats === this.cur.ats) {
      this.cur.done = e.scanned;
    } else if (e.kind === "atsDone" || e.kind === "summary") {
      this.close();
    }
  }
  private close() {
    if (!this.cur) return;
    const ms = Date.now() - this.cur.t0;
    if (this.cur.done >= 20 && ms > 15_000) {
      const s = (this.samples[this.cur.ats] ||= { boards: 0, ms: 0 });
      s.boards += this.cur.done;
      s.ms += ms;
    }
    this.cur = null;
  }
  save() {
    this.close();
    if (!Object.keys(this.samples).length) return;
    const file = path.join(projectXRoot(), "data/cache/scan-rates.json");
    let prev: Record<string, number> = {};
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* first measurement */
    }
    for (const [ats, s] of Object.entries(this.samples)) {
      const rate = s.boards / (s.ms / 60_000);
      // Moving average, so one throttled run doesn't swing the estimate.
      prev[ats] = Math.round(prev[ats] ? prev[ats] * 0.6 + rate * 0.4 : rate);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(prev));
    } catch {
      /* estimates just stay on defaults */
    }
  }
}
