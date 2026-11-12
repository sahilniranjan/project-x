// Client-safe types + codec for the Explorer (job discovery). NO node imports —
// both client components and server routes import this for the shared shapes, so
// the filter contract, the discovered-offer shape, and the stream-event grammar
// can never drift between the two halves. Server-only logic (spawning the scanner,
// writing temp files) lives in lib/core/{scan,portals,pipeline}.ts.

export type AtsSource = "greenhouse" | "lever" | "ashby" | "workday";
export const ATS_SOURCES: AtsSource[] = ["greenhouse", "lever", "ashby", "workday"];
export const ATS_LABEL: Record<AtsSource, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
};

/** The full UI filter state. The keyword/location lists mirror scan.mjs's
 *  buildTitleFilter / buildLocationFilter semantics; sinceDays/ats/limitPerAts map
 *  to scan-ats-full.mjs's --since / --ats / --limit. */
export type ExploreFilters = {
  positive: string[];
  negative: string[];
  allow: string[];
  block: string[];
  blockHard: string[];
  alwaysAllow: string[];
  sinceDays: number;
  ats: AtsSource[];
  limitPerAts: number;
  /** Company-level targeting (LOCAL: company-index.mjs). Decides WHICH boards a
   *  scan walks; the keyword/location lists above still decide which postings. */
  company: CompanyFilter;
  /** How many companies to scan, top-priority first. 0 = every match. */
  maxCompanies: number;
};

/** Mirrors lib/company-profile.mjs normalizeCompanyFilter (the core is the
 *  authority — it re-normalizes whatever the web sends). Within a group the
 *  options OR; groups AND. Option ids come from the core's CATALOG. */
export type CompanyFilter = {
  sizes: string[];
  industries: string[];
  excludeIndustries: string[];
  types: string[];
  excludeTypes: string[];
  funding: string[];
  workModels: string[];
  regions: string[];
  /** 0–100: at least this share of the company's postings are in the US */
  minUsShare: number;
  h1b: string[];
  entryLevel: boolean;
  /** 0–100: at least this share of open roles are engineering/data/ML */
  minEngShare: number;
  nameInclude: string[];
  nameExclude: string[];
  /** skip boards that had no open roles when indexed */
  skipEmpty: boolean;
  /** skip companies already in your tracker */
  skipApplied: boolean;
  /** let not-yet-indexed / unclassified companies through a filter */
  includeUnknown: boolean;
};

export const DEFAULT_COMPANY_FILTER: CompanyFilter = {
  sizes: [],
  industries: [],
  excludeIndustries: [],
  types: [],
  excludeTypes: [],
  funding: [],
  workModels: [],
  regions: [],
  minUsShare: 0,
  h1b: [],
  entryLevel: false,
  minEngShare: 0,
  nameInclude: [],
  nameExclude: [],
  skipEmpty: true,
  skipApplied: false,
  includeUnknown: true,
};

export const COMPANY_LIST_KEYS = [
  "sizes", "industries", "excludeIndustries", "types", "excludeTypes", "funding", "workModels", "regions", "h1b", "nameInclude", "nameExclude",
] as const;

/** Count of active company-filter controls (badge on the panel header). */
export function companyFilterCount(c: CompanyFilter): number {
  let n = 0;
  for (const k of COMPANY_LIST_KEYS) n += c[k].length;
  if (c.minUsShare > 0) n++;
  if (c.minEngShare > 0) n++;
  if (c.entryLevel) n++;
  if (c.skipApplied) n++;
  return n;
}

export function cleanCompanyFilter(v: unknown, base: CompanyFilter = DEFAULT_COMPANY_FILTER): CompanyFilter {
  const raw = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: CompanyFilter = { ...base };
  for (const k of COMPANY_LIST_KEYS) {
    if (raw[k] !== undefined) out[k] = cleanChips(raw[k]).map((x) => x.toLowerCase());
  }
  if (raw.minUsShare !== undefined) out.minUsShare = clampNum(raw.minUsShare, 0, 100, 0);
  if (raw.minEngShare !== undefined) out.minEngShare = clampNum(raw.minEngShare, 0, 100, 0);
  for (const k of ["entryLevel", "skipEmpty", "skipApplied", "includeUnknown"] as const) {
    if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  }
  return out;
}

/** Facet counts + coverage the core reports for a company filter (POST /api/explore/companies). */
export type CompanyStats = {
  catalog: Record<"sizes" | "industries" | "types" | "funding" | "workModels" | "regions" | "h1b", { id: string; label: string }[]>;
  coverage: { total: number; indexed: number; ok: number; unreachable: number };
  perAts: Record<string, { available: number; matching: number; dataset: string }>;
  matching: number;
  matchingIndexed: number;
  filterActive: boolean;
  selected: number;
  estMinutes: number;
  estMinutesAll: number;
  facets: Record<string, Record<string, number>>;
  index: { updatedAt: string | null; enrichedAt: string | null; buildStartedAt: string | null; buildFinishedAt: string | null };
};

/** State of the background company-index build (GET /api/explore/index). */
export type IndexJobState = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  total?: number;
  done?: number;
  ok?: number;
  failed?: number;
  ats?: string;
  etaMin?: number | null;
  phase?: "plan" | "fetch" | "enrich" | "done" | "error" | "cancelled";
  error?: string;
};

export const DEFAULT_FILTERS: ExploreFilters = {
  positive: [],
  negative: [],
  allow: [],
  block: [],
  blockHard: [],
  alwaysAllow: [],
  sinceDays: 7,
  ats: [...ATS_SOURCES],
  limitPerAts: 150,
  company: { ...DEFAULT_COMPANY_FILTER },
  maxCompanies: 600,
};

/** Upper bound for "how many companies" — the whole public directory and then some. */
export const MAX_COMPANIES_CAP = 100_000;

export type DiscoveredOffer = {
  url: string;
  company: string;
  title: string;
  location: string;
  /** YYYY-MM-DD, or "" when the engine reported n/a (AI offers always "") */
  postedAt: string;
  ats: string;
  source: string;
  /** which positive keyword matched the title (transparency, e.g. "ai" in "Nail") */
  matchedKeyword?: string;
  /** optional free-text ranking signal preserved to pipeline.md by the canonical
   *  writer (scan.mjs formatPipelineOffer). Generic and source-agnostic — an
   *  importer can attach a note; the deterministic scan omits it. */
  note?: string;
  // ── AI-search (modes/discover.md) additions — all optional, so the
  //    deterministic scan offer is unaffected (fields simply absent). ──
  /** present ONLY on AI offers → drives the "unverified" badge. AI finds can't be
   *  liveness-confirmed (AGENTS.md); the scan hits a live ATS API so it omits this. */
  verification?: "unconfirmed";
  /** one-line "why it matched" judgment (the thing a deterministic scan can't give) */
  why?: string;
  /** human freshness ("~5d ago", "unknown") shown when postedAt is "" */
  postedHint?: string;
  confidence?: "low" | "medium" | "high";
};

/** The two discovery surfaces: free deterministic Scan vs token-spending AI search. */
export type ExploreMode = "scan" | "ai";

/** Stream event grammar (NDJSON). `kind` discriminates. Discovery is FREE — the
 *  terminal `done` always carries cost {tokens:0, usd:0}. */
export type ScanEvent =
  | { kind: "start"; ats: string[]; sinceDays: number; limit: number; free: true }
  | { kind: "atsStart"; ats: string; companies: number }
  | { kind: "progress"; ats: string; scanned: number; total: number; matches: number }
  | { kind: "company"; ats: string; company: string; postings: number }
  | { kind: "atsDone"; ats: string; unreachable: number }
  | { kind: "offer"; offer: DiscoveredOffer }
  | {
      kind: "summary";
      companiesScanned: number;
      unreachable: number;
      matches: number;
      // Authoritative degraded-vs-empty signals from the scanner's --json mode (#1199).
      // Absent on older local checkouts (the legacy human-stdout parse can't supply them).
      companiesAvailable?: number;
      capHit?: boolean;
      datasetStatus?: Record<string, "ok" | "stale" | "empty">;
      postingsDroppedNoDate?: number;
    }
  | { kind: "log"; line: string }
  | { kind: "error"; message: string }
  /** Background scan job (LOCAL): the selection that was made before the scanner started. */
  | { kind: "selection"; selected: number; matching: number; estMinutes: number; perAts: Record<string, number> }
  | { kind: "done"; count: number; offers: DiscoveredOffer[]; cost?: { tokens: number; usd: number } };

// cleanChips is defined in clean-chips.mjs (plain JS) so it can be shared
// with the test suite without a TypeScript runner. Import for internal use
// and re-export for external consumers (filter-builder.tsx, etc.).
import { cleanChips } from "./clean-chips.mjs";
export { cleanChips };

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function cleanAts(v: unknown): AtsSource[] {
  if (!Array.isArray(v)) return [...ATS_SOURCES];
  const out = v
    .map((a) => String(a).toLowerCase())
    .filter((a): a is AtsSource => (ATS_SOURCES as string[]).includes(a));
  return out.length ? Array.from(new Set(out)) : [...ATS_SOURCES];
}

/** Apply a (possibly partial) action/assistant patch onto a base. The assistant
 *  emits {positive,negative,allow,block,alwaysAllow,since,ats,limit}. With
 *  merge=true, list fields are ADDED to the base; otherwise the given fields
 *  REPLACE. Unspecified fields are left as-is. */
export function parseExplorePatch(
  raw: Record<string, unknown>,
  base: ExploreFilters = DEFAULT_FILTERS,
  merge = false,
): ExploreFilters {
  const next: ExploreFilters = { ...base, ats: [...base.ats], company: { ...(base.company ?? DEFAULT_COMPANY_FILTER) } };
  const lists: [keyof ExploreFilters, string][] = [
    ["positive", "positive"],
    ["negative", "negative"],
    ["allow", "allow"],
    ["block", "block"],
    ["blockHard", "blockHard"],
    ["alwaysAllow", "alwaysAllow"],
  ];
  for (const [field, key] of lists) {
    if (raw[key] === undefined) continue;
    const incoming = cleanChips(raw[key]);
    next[field] = (merge ? cleanChips([...(base[field] as string[]), ...incoming]) : incoming) as never;
  }
  if (raw.since !== undefined) next.sinceDays = clampNum(raw.since, 1, 60, base.sinceDays);
  if (raw.sinceDays !== undefined) next.sinceDays = clampNum(raw.sinceDays, 1, 60, base.sinceDays);
  if (raw.limit !== undefined) next.limitPerAts = clampNum(raw.limit, 50, 500, base.limitPerAts);
  if (raw.limitPerAts !== undefined) next.limitPerAts = clampNum(raw.limitPerAts, 50, 500, base.limitPerAts);
  if (raw.ats !== undefined) next.ats = cleanAts(raw.ats);
  if (raw.company !== undefined) next.company = cleanCompanyFilter(raw.company, merge ? next.company : DEFAULT_COMPANY_FILTER);
  if (raw.maxCompanies !== undefined) next.maxCompanies = clampNum(raw.maxCompanies, 0, MAX_COMPANIES_CAP, base.maxCompanies);
  // A legacy per-source depth (the assistant still speaks `limit`) becomes a
  // total across the chosen sources, unless a total was given explicitly.
  else if (raw.limit !== undefined || raw.limitPerAts !== undefined) next.maxCompanies = next.limitPerAts * next.ats.length;
  return next;
}

/** URL <-> filters codec (so a search is shareable/restorable). */
export function filtersToParams(f: ExploreFilters): string {
  const sp = new URLSearchParams();
  if (f.positive.length) sp.set("q", f.positive.join(","));
  if (f.negative.length) sp.set("not", f.negative.join(","));
  if (f.allow.length) sp.set("loc", f.allow.join(","));
  if (f.block.length) sp.set("noloc", f.block.join(","));
  if (f.blockHard.length) sp.set("hardno", f.blockHard.join(","));
  if (f.alwaysAllow.length) sp.set("home", f.alwaysAllow.join(","));
  if (f.sinceDays !== DEFAULT_FILTERS.sinceDays) sp.set("since", String(f.sinceDays));
  if (f.ats.length !== ATS_SOURCES.length) sp.set("ats", f.ats.join(","));
  if (f.limitPerAts !== DEFAULT_FILTERS.limitPerAts) sp.set("limit", String(f.limitPerAts));
  if (f.maxCompanies !== DEFAULT_FILTERS.maxCompanies) sp.set("max", String(f.maxCompanies));
  if (f.company && companyFilterCount(f.company) > 0) sp.set("co", JSON.stringify(f.company));
  else if (f.company && (!f.company.skipEmpty || !f.company.includeUnknown)) sp.set("co", JSON.stringify(f.company));
  return sp.toString();
}

export function paramsToFilters(sp: URLSearchParams, base: ExploreFilters = DEFAULT_FILTERS): ExploreFilters {
  const split = (s: string | null) => (s ? s.split(",") : undefined);
  return parseExplorePatch(
    {
      positive: split(sp.get("q")),
      negative: split(sp.get("not")),
      allow: split(sp.get("loc")),
      block: split(sp.get("noloc")),
      blockHard: split(sp.get("hardno")),
      alwaysAllow: split(sp.get("home")),
      since: sp.get("since") ?? undefined,
      ats: split(sp.get("ats")),
      limit: sp.get("limit") ?? undefined,
      maxCompanies: sp.get("max") ?? undefined,
      company: parseJsonParam(sp.get("co")),
    },
    base,
  );
}

function parseJsonParam(s: string | null): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** AI-search URL codec (so an AI hunt is shareable/restorable). */
export function aiToParams(intent: string): string {
  const sp = new URLSearchParams();
  sp.set("mode", "ai");
  if (intent.trim()) sp.set("intent", intent.trim());
  return sp.toString();
}

export function paramsToAi(sp: URLSearchParams): string | null {
  if (sp.get("mode") !== "ai") return null;
  return sp.get("intent") ?? "";
}

/** Is the search broad enough that "nothing found" means "you're current"
 *  (good news) rather than "loosen your filters" (actionable)? */
export function isBroadSearch(f: ExploreFilters): boolean {
  return f.positive.length <= 1 && f.block.length === 0 && f.allow.length === 0;
}
