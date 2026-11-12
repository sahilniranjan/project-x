import { NextRequest } from "next/server";
import { companyIndexAvailable, companyStats } from "@/lib/core/company-index";
import { parseExplorePatch, DEFAULT_FILTERS } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Facet counts, coverage and a time estimate for a company filter (LOCAL).
// Read-only and free: the core reads data/company-index.json + the cached ATS
// directories; nothing is fetched from a job board here.
export async function POST(req: NextRequest) {
  if (!companyIndexAvailable()) return Response.json({ error: "company-index.mjs is missing from this checkout" }, { status: 404 });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const f = parseExplorePatch(body, DEFAULT_FILTERS);
  try {
    return Response.json(await companyStats(f.company, f.ats, f.maxCompanies));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "company stats failed" }, { status: 500 });
  }
}
