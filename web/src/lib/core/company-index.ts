import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectXRoot, rootScript } from "@/lib/project-x";
import type { CompanyFilter, CompanyStats, IndexJobState } from "@/lib/explore";

/**
 * ACL for the LOCAL company index (company-index.mjs at the checkout root).
 * The core owns every rule — classification, filtering, priority, estimates —
 * and this file only spawns it, the same way lib/core/scan.ts spawns the
 * scanner. Nothing here reimplements a filter, so the panel's counts and the
 * scan's actual selection can't disagree.
 */

export function companyIndexAvailable(): boolean {
  return fs.existsSync(rootScript("company-index"));
}

function tempFile(tag: string): string {
  return path.join(os.tmpdir(), `project-x-${tag}-${randomUUID()}.json`);
}

function removeTemp(file: string) {
  try {
    if (file.startsWith(os.tmpdir()) && file.includes("project-x-")) fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

/** Run one JSON-printing company-index.mjs subcommand. */
function runJson<T>(args: string[], timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rootScript("company-index"), ...args], { cwd: projectXRoot(), env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(new Error(crashMessage(err.split("\n")) || `company-index exited ${code}`));
      }
    });
  });
}

export async function companyStats(filter: CompanyFilter, ats: string[], max: number): Promise<CompanyStats> {
  const f = tempFile("cofilter");
  fs.writeFileSync(f, JSON.stringify(filter));
  try {
    const args = ["stats", "--filter", f, "--ats", ats.join(",")];
    if (max > 0) args.push("--max", String(max));
    return await runJson<CompanyStats>(args);
  } finally {
    removeTemp(f);
  }
}

export type Selection = { file: string; selected: number; matching: number; estMinutes: number; perAts: Record<string, number> };

/** Write the prioritized board list a scan will walk. Caller removes `file`. */
export async function selectCompanies(filter: CompanyFilter, ats: string[], max: number): Promise<Selection> {
  const f = tempFile("cofilter");
  const out = tempFile("coselect");
  fs.writeFileSync(f, JSON.stringify(filter));
  try {
    const args = ["select", "--filter", f, "--ats", ats.join(","), "--out", out];
    if (max > 0) args.push("--max", String(max));
    const r = await runJson<Omit<Selection, "file">>(args);
    return { ...r, file: out };
  } finally {
    removeTemp(f);
  }
}

export function removeSelection(file: string) {
  removeTemp(file);
}

// ── Background index build ───────────────────────────────────────────
// One per process. globalThis so a dev-mode module reload doesn't orphan it.

type IndexRegistry = { state: IndexJobState; child: ChildProcess | null; log: string[] };
const g = globalThis as unknown as { __coIndexJob?: IndexRegistry };
function reg(): IndexRegistry {
  if (!g.__coIndexJob) g.__coIndexJob = { state: { running: false }, child: null, log: [] };
  return g.__coIndexJob;
}

const IDX_RE = /^⟦idx⟧(.+)$/;

/** The useful line of a crashed child's stderr. Node ends an uncaught throw with
 *  a stack and then `Node.js vX.Y.Z`, so the last line names the runtime, not the
 *  failure; prefer the last `SomethingError: …` line. */
function crashMessage(lines: string[]): string | undefined {
  const real = lines.map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l) && !/^at\s/.test(l));
  return [...real].reverse().find((l) => /\b[A-Z]\w*Error\b|^Error\b/.test(l)) ?? real[real.length - 1];
}

export function indexJobState(): IndexJobState & { log: string[] } {
  const r = reg();
  return { ...r.state, log: r.log.slice(-12) };
}

export function startIndexBuild(opts: { ats: string[]; staleDays?: number }): IndexJobState {
  const r = reg();
  if (r.state.running) return r.state;
  const args = [rootScript("company-index"), "build", "--ats", opts.ats.join(",")];
  if (opts.staleDays && opts.staleDays > 0) args.push("--stale-days", String(opts.staleDays));
  const child = spawn(process.execPath, args, { cwd: projectXRoot(), env: process.env });
  r.child = child;
  r.log = [];
  r.state = { running: true, startedAt: new Date().toISOString(), phase: "plan", done: 0, total: 0, ok: 0, failed: 0 };
  let buf = "";
  child.stderr.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = line.match(IDX_RE);
      if (!m) {
        if (line.trim()) {
          r.log.push(line.trim());
          if (r.log.length > 200) r.log.splice(0, r.log.length - 200);
        }
        continue;
      }
      try {
        const e = JSON.parse(m[1]) as Record<string, unknown>;
        if (e.kind === "plan") r.state = { ...r.state, phase: "fetch", total: Number(e.total) || 0 };
        else if (e.kind === "atsStart") r.state = { ...r.state, ats: String(e.ats) };
        else if (e.kind === "progress")
          r.state = { ...r.state, done: Number(e.done) || 0, total: Number(e.total) || r.state.total, ok: Number(e.ok) || 0, failed: Number(e.failed) || 0, etaMin: (e.etaMin as number | null) ?? null };
        else if (e.kind === "enrich") r.state = { ...r.state, phase: "enrich" };
        else if (e.kind === "done") r.state = { ...r.state, phase: "done" };
      } catch {
        /* one malformed line must not break the job */
      }
    }
  });
  child.stdout.on("data", () => {});
  child.on("error", (e) => {
    r.state = { ...r.state, running: false, phase: "error", error: e.message, finishedAt: new Date().toISOString() };
    r.child = null;
  });
  child.on("close", (code) => {
    const cancelled = r.state.phase === "cancelled";
    r.state = {
      ...r.state,
      running: false,
      finishedAt: new Date().toISOString(),
      phase: cancelled ? "cancelled" : code === 0 ? "done" : "error",
      error: cancelled || code === 0 ? undefined : crashMessage(r.log) || `index build exited ${code}`,
    };
    r.child = null;
  });
  return r.state;
}

export function cancelIndexBuild(): IndexJobState {
  const r = reg();
  if (r.child) {
    r.state = { ...r.state, phase: "cancelled" };
    try {
      r.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  return r.state;
}
