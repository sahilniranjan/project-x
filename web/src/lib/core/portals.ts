import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as yaml from "js-yaml";
import { projectXRoot } from "@/lib/project-x";
import { DEFAULT_FILTERS, cleanChips, type ExploreFilters } from "@/lib/explore";
import { profileTargetKeywords } from "@/lib/profile-keywords.mjs";

/**
 * ACL for portals.yml — the core's scan-filter config (a CONTRACT entry-point,
 * see reference_web_core_sync_protocol). The Explorer NEVER mutates the user's
 * real portals.yml: it writes an EPHEMERAL filter file and points the scanner at
 * it via PROJECT_X_PORTALS, so an ad-hoc search can't clobber the curated config.
 * We also read the real portals.yml + config/profile.yml (tolerantly) only to
 * SEED sensible defaults for the first search.
 *
 * Filter semantics mirror scan.mjs::buildTitleFilter / buildLocationFilter:
 *   title positive → substring match (empty = everything matches)
 *   title negative → substring reject
 *   location block_hard > always_allow > block > allow (case-insensitive substring);
 *   block_hard is the one tier always_allow cannot override (scan.mjs, #2956)
 */
type FilterLists = Pick<ExploreFilters, "positive" | "negative" | "allow" | "block" | "alwaysAllow" | "blockHard">;

function listFrom(v: unknown): string[] {
  return cleanChips(v);
}

// serializePortals lives in portals-serialize.mjs (pure, no TS deps) so the web
// `node --test` suite can load it — the block_hard round-trip (#3102) is exactly
// a "don't silently drop a tier" property that has to be asserted, not eyeballed.
export { serializePortals } from "./portals-serialize.mjs";
import { serializePortals } from "./portals-serialize.mjs";

/** Write the ephemeral filter file to a temp path; caller cleans it up. */
export function writeTempPortals(f: FilterLists): string {
  const file = path.join(os.tmpdir(), `project-x-explore-${randomUUID()}.yml`);
  fs.writeFileSync(file, serializePortals(withLocationFloor(f)), "utf8");
  return file;
}

/**
 * Fall back to portals.yml's location_filter when the request carries none.
 *
 * seedExploreFilters() already seeds these tiers, but the seed only applies to a
 * FRESH session: a browser holding saved filters from before portals.yml had a
 * location_filter sends four empty lists, and an empty list here means "no
 * location filtering at all". The user's standing location policy then silently
 * does not apply to Explore while it does apply to every CLI scan — the two
 * halves disagreeing, which is exactly what web/AGENTS.md rule 1 warns about.
 *
 * Only fills tiers the request left empty, so an explicit UI choice still wins.
 */
function withLocationFloor(f: FilterLists): FilterLists {
  const hasLocation = f.allow.length || f.block.length || f.alwaysAllow.length || f.blockHard.length;
  if (hasLocation) return f;
  const lf = (loadYaml("portals.yml")?.location_filter ?? null) as Record<string, unknown> | null;
  if (!lf) return f;
  return {
    ...f,
    allow: listFrom(lf.allow),
    block: listFrom(lf.block),
    alwaysAllow: listFrom(lf.always_allow),
    blockHard: listFrom(lf.block_hard),
  };
}

export function cleanupTempPortals(file: string): void {
  try {
    if (file.startsWith(os.tmpdir()) && file.includes("project-x-explore-")) fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

function loadYaml(rel: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(projectXRoot(), rel), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Tolerantly seed first-search defaults from the user's real config. Reads
 * portals.yml (title_filter / location_filter) and falls back to
 * config/profile.yml (target_roles, location) for the positive keywords when
 * portals has none. Never throws — a bare checkout just yields DEFAULT_FILTERS.
 */
export function seedExploreFilters(): { filters: ExploreFilters; seededFrom: string[] } {
  const filters: ExploreFilters = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] };
  const seededFrom: string[] = [];

  const portals = loadYaml("portals.yml");
  if (portals) {
    const tf = (portals.title_filter ?? {}) as Record<string, unknown>;
    const lf = (portals.location_filter ?? {}) as Record<string, unknown>;
    filters.positive = listFrom(tf.positive);
    filters.negative = listFrom(tf.negative);
    filters.allow = listFrom(lf.allow);
    filters.block = listFrom(lf.block);
    filters.alwaysAllow = listFrom(lf.always_allow);
    filters.blockHard = listFrom(lf.block_hard);
    if (filters.positive.length || filters.allow.length || filters.block.length || filters.blockHard.length) seededFrom.push("portals.yml");
  }

  if (filters.positive.length === 0) {
    // Shape-reading lives in profile-keywords.mjs, mirroring the core's
    // providers/_profile-keywords.mjs. Inlined here it had drifted from the
    // core on BOTH fields — `primary` read as a string when it is a list,
    // `archetypes` spread raw when its entries are objects — so this fallback
    // returned nothing for every profile.yml the app itself writes.
    const fromRoles = listFrom(profileTargetKeywords(loadYaml("config/profile.yml")));
    if (fromRoles.length) {
      filters.positive = fromRoles;
      seededFrom.push("profile.yml");
    }
  }

  return { filters, seededFrom };
}

export { listFrom as normalizeKeywords };

/**
 * A prompt-facing statement of the user's location policy, read from
 * portals.yml. Returns "" when no location_filter is configured.
 *
 * This is a SOFT guard: AI-search offers are parsed in the browser from a text
 * stream, so unlike the free scan there is no server-side seam where they can be
 * filtered deterministically. Saying it in the prompt is the available lever.
 */
export function locationConstraintLine(): string {
  const lf = (loadYaml("portals.yml")?.location_filter ?? null) as Record<string, unknown> | null;
  if (!lf) return "";
  const allow = [...listFrom(lf.always_allow), ...listFrom(lf.allow)];
  const block = [...listFrom(lf.block_hard), ...listFrom(lf.block)];
  if (!allow.length && !block.length) return "";
  const parts = ["\n--- LOCATION CONSTRAINT (hard) ---"];
  if (allow.length) parts.push(`ONLY propose roles located in: ${allow.slice(0, 24).join(", ")}. Remote counts only if it is open to those locations.`);
  if (block.length) parts.push(`NEVER propose roles located in: ${block.slice(0, 60).join(", ")}.`);
  parts.push("This is a hard filter, not a preference: the GENEROUS FINDER rule above does NOT apply to geography. Discard an out-of-scope role rather than flagging it.");
  return parts.join("\n") + "\n";
}
