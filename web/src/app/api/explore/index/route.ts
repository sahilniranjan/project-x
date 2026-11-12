import { NextRequest } from "next/server";
import { cancelIndexBuild, companyIndexAvailable, indexJobState, startIndexBuild } from "@/lib/core/company-index";
import { ATS_SOURCES } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Background company-index build (LOCAL). GET = progress, POST = start (or
// return the running build), DELETE = stop (what was indexed so far is kept).
export async function GET() {
  return Response.json(indexJobState());
}

export async function POST(req: NextRequest) {
  if (!companyIndexAvailable()) return Response.json({ error: "company-index.mjs is missing from this checkout" }, { status: 404 });
  let body: { ats?: unknown; staleDays?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }
  const ats = Array.isArray(body.ats) ? body.ats.map(String).filter((a) => (ATS_SOURCES as string[]).includes(a)) : [...ATS_SOURCES];
  const staleDays = Number(body.staleDays);
  startIndexBuild({ ats: ats.length ? ats : [...ATS_SOURCES], staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : undefined });
  return Response.json(indexJobState());
}

export async function DELETE() {
  cancelIndexBuild();
  return Response.json(indexJobState());
}
