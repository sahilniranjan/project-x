import { NextRequest } from "next/server";
import fs from "node:fs";
import { rootScript } from "@/lib/project-x";
import { activeScanJob, cancelScanJob, getScanJob, startScanJob } from "@/lib/core/explore-jobs";
import { companyIndexAvailable } from "@/lib/core/company-index";
import { parseExplorePatch, DEFAULT_FILTERS } from "@/lib/explore";
import { scannerMissingBody, SCANNER_MISSING_STATUS } from "@/lib/explore-error.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Background scan jobs (LOCAL) — see lib/core/explore-jobs.ts.
//   POST   {filters}            → start (or join the running scan) → {id}
//   GET    ?id=…&cursor=N       → {events since N, next, done}
//   GET    (no id)              → the running scan's id, if any
//   DELETE ?id=…                → stop it; matches found so far are kept
export async function POST(req: NextRequest) {
  if (!fs.existsSync(rootScript("scan-ats-full")) || !companyIndexAvailable()) {
    return Response.json(scannerMissingBody(), { status: SCANNER_MISSING_STATUS });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const filters = parseExplorePatch(body, DEFAULT_FILTERS);
  const { job, alreadyRunning } = startScanJob(filters);
  return Response.json({ id: job.id, alreadyRunning });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    const j = activeScanJob();
    return Response.json({ id: j?.id ?? null, startedAt: j?.startedAt ?? null });
  }
  const job = getScanJob(id);
  if (!job) return Response.json({ error: "gone" }, { status: 404 });
  const cursor = Math.max(0, Number(req.nextUrl.searchParams.get("cursor")) || 0);
  const events = job.events.slice(cursor);
  return Response.json({ events, next: cursor + events.length, done: job.done, startedAt: job.startedAt, filters: job.filters });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || activeScanJob()?.id || "";
  return Response.json({ stopped: cancelScanJob(id) });
}
