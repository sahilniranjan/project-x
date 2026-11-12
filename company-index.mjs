#!/usr/bin/env node

/**
 * company-index.mjs — local company index for filtered reverse-ATS scans.
 * LOCAL to this checkout (not upstream career-ops); `update-system` leaves it
 * alone because it is not a tracked system file.
 *
 * The public ATS directories scan-ats-full.mjs walks (~27k boards) are bare IDs.
 * This script fetches each board ONCE, derives company traits from its postings
 * (lib/company-profile.mjs), joins the local H-1B DOL index and VC portfolio
 * lists, and stores one record per board in data/company-index.json. Explore's
 * company filter then picks WHICH boards a scan walks, and in what order.
 *
 * Zero LLM tokens — HTTP + JSON only, the same providers the scanner uses.
 * Workday boards are read one page deep (plus the API's reported total), so
 * indexing is far cheaper than scanning them.
 *
 * Usage:
 *   node company-index.mjs build [--ats greenhouse,lever] [--stale-days 14] [--limit N]
 *        index every board not indexed in the last --stale-days (default 14);
 *        re-running continues where an interrupted build stopped
 *   node company-index.mjs enrich          re-join H-1B + VC lists without refetching boards
 *   node company-index.mjs stats  --filter <file.json> [--ats ...] [--max N]
 *        JSON: totals, coverage, matching count, per-option counts, time estimate
 *   node company-index.mjs select --filter <file.json> [--ats ...] [--max N] --out <file.json>
 *        write the prioritized board list scan-ats-full.mjs --companies-file reads
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';

import { SOURCES, loadCompanyList, parallelEach, withTimeout } from './scan-ats-full.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { loadDeadBoards, shouldSkipDeadBoard, boardKey } from './dead-boards.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  CATALOG, profileFromJobs, displayNameFromSlug, joinKey, companyTypes, workModel, sizeBand,
  normalizeCompanyFilter, matchesCompanyFilter, priorityScore, isFilterActive,
} from './lib/company-profile.mjs';

const ROOT = getCareerOpsRoot();
export const INDEX_PATH = path.join(ROOT, 'data/company-index.json');
const SEEDS_CACHE = path.join(ROOT, 'data/cache/company-index-seeds.json');
const RATES_PATH = path.join(ROOT, 'data/cache/scan-rates.json');
const DEAD_BOARDS_PATH = path.join(ROOT, 'data/dead-boards.tsv');
const H1B_INDEX = process.env.H1B_INDEX_PATH || path.join(ROOT, 'data/h1b/index.ndjson.gz');
const SCAN_HISTORY = path.join(ROOT, 'data/scan-history.tsv');
const DEFAULT_ATS = ['greenhouse', 'lever', 'ashby', 'workday'];
const SAVE_EVERY = 250;
const BOARD_TIMEOUT_MS = 60_000;
const SEEDS_TTL_DAYS = 7;

// Scan throughput (boards/minute) when nothing has been measured yet. Rough
// figures from real sweeps: Workday tenants paginate and dominate wall-clock.
const DEFAULT_SCAN_RATES = { greenhouse: 110, lever: 140, ashby: 140, workday: 45, icims: 30 };

/** A dataset item's stable key inside its source ("acme", "tenant|wd1|site"). */
export const itemKey = (item) => (typeof item === 'string' ? item : JSON.stringify(item));
const recKey = (ats, item) => `${ats}:${itemKey(item)}`;

// ── Storage ─────────────────────────────────────────────────────────

export function loadIndex(file = INDEX_PATH) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && j.records && typeof j.records === 'object') return j;
  } catch { /* fresh */ }
  return { version: 1, updatedAt: null, records: {}, build: null };
}

export function saveIndex(idx, file = INDEX_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  idx.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx));
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── Side sources: H-1B index + VC portfolios ────────────────────────

/** joinKey → best H-1B record (highest filing volume). Null when no index. */
async function loadH1bMap() {
  if (!existsSync(H1B_INDEX)) return null;
  let classifyTier;
  try {
    ({ classifyTier } = await import('./plugins/h1b-sponsor/lib/tier.mjs'));
  } catch {
    return null;
  }
  const map = new Map();
  const source = createReadStream(H1B_INDEX);
  const gunzip = createGunzip();
  source.on('error', (e) => gunzip.destroy(e));
  const rl = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.n !== 'string') continue;
    const k = joinKey(r.n);
    if (k.length < 3) continue;
    const vol = (Number(r.filed) || 0) + (Number(r.perm) || 0) + (Number(r.pwd) || 0);
    const prev = map.get(k);
    if (prev && prev.vol >= vol) continue;
    map.set(k, { vol, r });
  }
  const out = new Map();
  for (const [k, { r }] of map) {
    const nPwd = Number(r.pwd) || 0;
    const nPerm = Number(r.perm) || 0;
    const profile = {
      n_lca: Number(r.filed) || 0,
      n_pwd: nPwd,
      n_perm: nPerm,
      does_gc: r.gc === true || nPwd > 0 || nPerm > 0,
      last_year: Number(r.ly) || null,
      red_flags: { staffing_shop: { value: r.sv === true, share: typeof r.sh === 'number' ? r.sh : null } },
    };
    out.set(k, { tier: classifyTier(profile), lca: profile.n_lca });
  }
  return out;
}

/** { yc:Set<joinKey>, a16z:Set<joinKey> } from a 7-day cache, refetched when stale. */
async function loadSeedSets(log) {
  let cache = readJson(SEEDS_CACHE, null);
  const fresh = cache && cache.fetchedAt && (Date.now() - Date.parse(cache.fetchedAt)) < SEEDS_TTL_DAYS * 86_400_000;
  if (!fresh) {
    const next = { fetchedAt: new Date().toISOString(), yc: cache?.yc || [], a16z: cache?.a16z || [] };
    try {
      const { SEED_SOURCES } = await import('./seeds/vc-portfolios.mjs');
      for (const id of ['yc', 'a16z']) {
        try {
          const list = await SEED_SOURCES[id].fetch();
          const keys = new Set();
          for (const c of list) {
            if (c.name) keys.add(joinKey(c.name));
            if (c.slug) keys.add(joinKey(c.slug));
            if (c.ats_id) keys.add(joinKey(c.ats_id));
          }
          next[id] = [...keys].filter(k => k.length >= 3);
          log(`  ${id}: ${next[id].length} portfolio names`);
        } catch (e) {
          log(`  ${id}: portfolio list unavailable (${e.message}) — keeping cached copy`);
        }
      }
      mkdirSync(path.dirname(SEEDS_CACHE), { recursive: true });
      writeFileSync(SEEDS_CACHE, JSON.stringify(next));
      cache = next;
    } catch (e) {
      log(`  VC lists unavailable (${e.message})`);
    }
  }
  return { yc: new Set(cache?.yc || []), a16z: new Set(cache?.a16z || []) };
}

function enrichRecord(rec, h1b, seeds) {
  const keys = [joinKey(rec.n), joinKey(String(rec.s).split('|')[0])].filter(k => k.length >= 3);
  if (h1b) {
    const hit = keys.map(k => h1b.get(k)).find(Boolean);
    rec.h1b = hit ? hit.tier : 'unknown';
    rec.lca = hit ? hit.lca : 0;
  }
  if (seeds && rec.st === 'ok') {
    const fund = new Set((rec.fund || []).filter(f => f !== 'yc' && f !== 'a16z'));
    if (keys.some(k => seeds.yc.has(k))) fund.add('yc');
    if (keys.some(k => seeds.a16z.has(k))) fund.add('a16z');
    rec.fund = [...fund];
  }
}

// ── build ───────────────────────────────────────────────────────────

async function build(opts) {
  const log = (...a) => console.error(...a);
  const emit = (obj) => console.error('⟦idx⟧' + JSON.stringify(obj));
  const idx = loadIndex();
  const staleMs = opts.staleDays * 86_400_000;
  const now = Date.now();
  const ctx = { ...makeHttpCtx(), syntheticEntries: true };
  const workdayCtx = { ...ctx, maxPages: 1 };
  const deadBoards = loadDeadBoards(DEAD_BOARDS_PATH);
  // Cancel (the panel's Stop button sends SIGTERM) keeps everything indexed so
  // far: the next build skips those boards as fresh and carries on.
  const onStop = () => {
    try { saveIndex(idx); } catch { /* exiting anyway */ }
    process.exit(130);
  };
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);

  // Plan the whole run first so progress has a real denominator.
  const plan = [];
  let totalAvailable = 0;
  for (const ats of opts.ats) {
    const source = SOURCES[ats];
    if (!source) continue;
    const { list } = await loadCompanyList(ats, source.dataset);
    totalAvailable += list.length;
    const todo = [];
    for (const item of list) {
      const prev = idx.records[recKey(ats, item)];
      if (prev && prev.t && now - Date.parse(prev.t) < staleMs) continue;
      todo.push(item);
    }
    plan.push({ ats, source, todo: Number.isFinite(opts.limit) ? todo.slice(0, opts.limit) : todo });
  }
  const totalTodo = plan.reduce((s, p) => s + p.todo.length, 0);
  idx.build = { startedAt: new Date().toISOString(), finishedAt: null, total: totalTodo };
  emit({ kind: 'plan', total: totalTodo, available: totalAvailable, alreadyIndexed: Object.keys(idx.records).length });
  log(`Company index — ${totalTodo.toLocaleString()} boards to index (${totalAvailable.toLocaleString()} in directories, stale after ${opts.staleDays}d)`);

  let done = 0;
  let ok = 0;
  let failed = 0;
  let sinceSave = 0;
  const started = Date.now();
  for (const { ats, source, todo } of plan) {
    if (!todo.length) continue;
    emit({ kind: 'atsStart', ats, total: todo.length });
    log(`\n⚙  ${ats} — ${todo.length} boards`);
    const atsStarted = Date.now();
    await parallelEach(todo, source.concurrency ?? 20, async (item) => {
      const key = recKey(ats, item);
      const entry = source.toEntry(item);
      const name = entry?.name ? displayNameFromSlug(entry.name) : displayNameFromSlug(itemKey(item));
      if (!entry) {
        idx.records[key] = { a: ats, s: itemKey(item), n: name, st: 'unreachable', fails: 9, t: today() };
        failed++;
        return;
      }
      if (shouldSkipDeadBoard(deadBoards, ats, boardKey(entry))) {
        idx.records[key] = { a: ats, s: itemKey(item), n: name, st: 'unreachable', fails: 3, t: today() };
        failed++;
        return;
      }
      try {
        const jobs = await withTimeout(
          source.provider.fetch(entry, ats === 'workday' ? workdayCtx : ctx),
          BOARD_TIMEOUT_MS,
          `${ats}/${entry.name}`,
        );
        const total = typeof jobs.workdayTotal === 'number' ? jobs.workdayTotal : null;
        idx.records[key] = profileFromJobs({ ats, slug: itemKey(item), name, jobs, total });
        ok++;
      } catch (err) {
        const prev = idx.records[key];
        // A board that worked before keeps its traits through one bad fetch.
        if (prev && prev.st === 'ok') {
          prev.t = today();
          prev.fails = (prev.fails || 0) + 1;
          if (prev.fails >= 3) prev.st = 'unreachable';
        } else {
          idx.records[key] = { a: ats, s: itemKey(item), n: name, st: 'unreachable', fails: (prev?.fails || 0) + 1, t: today(), err: err?.status || 'error' };
        }
        failed++;
        if (opts.verbose) log(`  ✗ ${ats}/${entry.name}: ${err.message}`);
      }
    }, () => {
      done++;
      sinceSave++;
      if (sinceSave >= SAVE_EVERY) { sinceSave = 0; saveIndex(idx); }
      if (done % 25 === 0 || done === totalTodo) {
        const mins = (Date.now() - started) / 60000;
        const rate = mins > 0 ? done / mins : 0;
        emit({ kind: 'progress', ats, done, total: totalTodo, ok, failed, etaMin: rate > 0 ? Math.round((totalTodo - done) / rate) : null });
        process.stderr.write(`  ${done}/${totalTodo} indexed (${ok} ok, ${failed} unreachable)\n`);
      }
    });
    const atsMins = (Date.now() - atsStarted) / 60000;
    if (atsMins > 0.2) {
      idx.indexRates = { ...(idx.indexRates || {}), [ats]: Math.round(todo.length / atsMins) };
    }
    saveIndex(idx);
  }

  log('\nJoining H-1B filings and VC portfolio lists…');
  emit({ kind: 'enrich' });
  await enrichAll(idx, log);
  idx.build.finishedAt = new Date().toISOString();
  saveIndex(idx);
  const summary = { kind: 'done', indexed: Object.keys(idx.records).length, ok, failed, minutes: Math.round((Date.now() - started) / 60000) };
  emit(summary);
  log(`\nDone — ${ok} boards indexed, ${failed} unreachable, ${summary.indexed.toLocaleString()} records total.`);
}

async function enrichAll(idx, log) {
  const h1b = await loadH1bMap().catch(() => null);
  if (!h1b) log('  H-1B index not installed — sponsorship filter will show "unknown" (node plugins/h1b-sponsor/install-h1b-index.mjs)');
  const seeds = await loadSeedSets(log);
  for (const rec of Object.values(idx.records)) enrichRecord(rec, h1b, seeds);
  idx.enrichedAt = new Date().toISOString();
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── stats / select ──────────────────────────────────────────────────

function loadHistorySets() {
  const matchedBefore = new Set();
  try {
    const lines = readFileSync(SCAN_HISTORY, 'utf8').split(/\r?\n/);
    const head = lines[0].split('\t');
    const ci = head.indexOf('company');
    const si = head.indexOf('status');
    for (const line of lines.slice(1)) {
      const cols = line.split('\t');
      if (ci < 0 || !cols[ci]) continue;
      if (si >= 0 && cols[si] && cols[si] !== 'added') continue;
      matchedBefore.add(joinKey(cols[ci]));
    }
  } catch { /* no history */ }
  const applied = new Set();
  for (const rel of ['data/applications.md', 'applications.md']) {
    try {
      for (const line of readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/)) {
        const cols = line.split('|').map(c => c.trim());
        if (cols.length > 4 && /^\d+$/.test(cols[1])) applied.add(joinKey(cols[3]));
      }
      break;
    } catch { /* try next */ }
  }
  return { matchedBefore, applied };
}

export function scanRates(idx) {
  const measured = readJson(RATES_PATH, {});
  const out = {};
  for (const ats of Object.keys(DEFAULT_SCAN_RATES)) {
    const m = measured?.[ats];
    out[ats] = typeof m === 'number' && m > 0 ? m : DEFAULT_SCAN_RATES[ats];
  }
  return out;
}

/**
 * Evaluate a company filter over every dataset board. Returns the candidates in
 * priority order plus facet counts. Facet counts are computed over boards that
 * pass every OTHER group, so each number answers "how many would I get if I
 * also ticked this?" — the same way a shop's filter sidebar behaves.
 */
export async function evaluate({ filter, ats = DEFAULT_ATS, withFacets = true }) {
  const f = normalizeCompanyFilter(filter);
  const idx = loadIndex();
  const ctx = loadHistorySets();
  const candidates = [];
  const perAts = {};
  const coverage = { total: 0, indexed: 0, ok: 0, unreachable: 0 };
  const facets = withFacets ? emptyFacets() : null;
  const groupOff = withFacets ? {
    sizes: { ...f, sizes: [] }, industries: { ...f, industries: [] }, types: { ...f, types: [] },
    funding: { ...f, funding: [] }, workModels: { ...f, workModels: [] }, regions: { ...f, regions: [] }, h1b: { ...f, h1b: [] },
  } : null;

  for (const a of ats) {
    const source = SOURCES[a];
    if (!source) continue;
    const { list, status } = await loadCompanyList(a, source.dataset);
    perAts[a] = { available: list.length, matching: 0, dataset: status };
    for (const item of list) {
      coverage.total++;
      const rec = idx.records[recKey(a, item)] || null;
      if (rec) {
        coverage.indexed++;
        if (rec.st === 'ok') coverage.ok++; else coverage.unreachable++;
      }
      const name = rec?.n || displayNameFromSlug(itemKey(item));
      if (withFacets) tallyFacets(facets, rec, name, groupOff, ctx);
      if (!matchesCompanyFilter(rec, name, f, ctx)) continue;
      perAts[a].matching++;
      candidates.push({ ats: a, key: itemKey(item), score: priorityScore(rec, name, ctx), indexed: !!rec });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return { filter: f, active: isFilterActive(f), candidates, perAts, coverage, facets, idx };
}

function emptyFacets() {
  const o = {};
  for (const g of ['sizes', 'industries', 'types', 'funding', 'workModels', 'regions', 'h1b']) o[g] = {};
  return o;
}

function tallyFacets(facets, rec, name, groupOff, ctx) {
  if (!rec || rec.st !== 'ok') return;
  const bump = (g, ids) => { for (const id of ids) facets[g][id] = (facets[g][id] || 0) + 1; };
  if (matchesCompanyFilter(rec, name, groupOff.sizes, ctx)) bump('sizes', [sizeBand(rec.r)].filter(Boolean));
  if (matchesCompanyFilter(rec, name, groupOff.industries, ctx)) bump('industries', rec.ind || []);
  if (matchesCompanyFilter(rec, name, groupOff.types, ctx)) bump('types', companyTypes(rec));
  if (matchesCompanyFilter(rec, name, groupOff.funding, ctx)) bump('funding', rec.fund || []);
  if (matchesCompanyFilter(rec, name, groupOff.workModels, ctx)) { const w = workModel(rec); if (w) bump('workModels', [w]); }
  if (matchesCompanyFilter(rec, name, groupOff.regions, ctx)) bump('regions', rec.reg || []);
  if (matchesCompanyFilter(rec, name, groupOff.h1b, ctx) && rec.h1b && rec.h1b !== 'unknown') bump('h1b', [rec.h1b]);
}

/** Take the top `max` candidates and estimate the scan's wall-clock minutes. */
export function pickTop(candidates, max, rates) {
  const n = Number.isFinite(max) && max > 0 ? Math.min(max, candidates.length) : candidates.length;
  const picked = candidates.slice(0, n);
  const byAts = {};
  for (const c of picked) (byAts[c.ats] ||= []).push(c.key);
  // Sources run one after another, so their times add up.
  let minutes = 0;
  for (const [a, keys] of Object.entries(byAts)) minutes += keys.length / (rates[a] || 60);
  return { picked: n, byAts, estMinutes: Math.max(1, Math.round(minutes)) };
}

async function stats(opts) {
  const filter = opts.filter ? readJson(opts.filter, {}) : {};
  const ev = await evaluate({ filter, ats: opts.ats });
  const rates = scanRates(ev.idx);
  const pick = pickTop(ev.candidates, opts.max, rates);
  const all = pickTop(ev.candidates, Infinity, rates);
  const b = ev.idx.build;
  process.stdout.write(JSON.stringify({
    catalog: CATALOG,
    coverage: ev.coverage,
    perAts: ev.perAts,
    matching: ev.candidates.length,
    matchingIndexed: ev.candidates.filter(c => c.indexed).length,
    filterActive: ev.active,
    selected: pick.picked,
    estMinutes: pick.estMinutes,
    estMinutesAll: all.estMinutes,
    facets: ev.facets,
    index: {
      updatedAt: ev.idx.updatedAt,
      enrichedAt: ev.idx.enrichedAt || null,
      buildStartedAt: b?.startedAt || null,
      buildFinishedAt: b?.finishedAt || null,
      indexRates: ev.idx.indexRates || {},
    },
  }));
}

async function select(opts) {
  if (!opts.out) { console.error('Error: select needs --out <file>'); process.exit(1); }
  const filter = opts.filter ? readJson(opts.filter, {}) : {};
  const ev = await evaluate({ filter, ats: opts.ats, withFacets: false });
  const pick = pickTop(ev.candidates, opts.max, scanRates(ev.idx));
  const body = { createdAt: new Date().toISOString(), selected: pick.picked, matching: ev.candidates.length, sources: pick.byAts };
  mkdirSync(path.dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(body));
  process.stdout.write(JSON.stringify({ selected: pick.picked, matching: ev.candidates.length, estMinutes: pick.estMinutes, perAts: Object.fromEntries(Object.entries(pick.byAts).map(([a, k]) => [a, k.length])) }));
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const atsArg = val('--ats');
  const ats = atsArg ? atsArg.split(',').map(s => s.trim().toLowerCase()).filter(a => SOURCES[a]) : DEFAULT_ATS;
  const num = (flag, d) => { const n = Number(val(flag)); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    cmd,
    ats: ats.length ? ats : DEFAULT_ATS,
    staleDays: num('--stale-days', 14),
    limit: num('--limit', Infinity),
    max: num('--max', Infinity),
    filter: val('--filter'),
    out: val('--out'),
    verbose: args.includes('--verbose'),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.cmd === 'build') return build(opts);
  if (opts.cmd === 'enrich') {
    const idx = loadIndex();
    await enrichAll(idx, (...a) => console.error(...a));
    saveIndex(idx);
    console.error(`Enriched ${Object.keys(idx.records).length} records.`);
    return;
  }
  if (opts.cmd === 'stats') return stats(opts);
  if (opts.cmd === 'select') return select(opts);
  console.error('Usage: node company-index.mjs build|enrich|stats|select [--ats a,b] [--filter file] [--max N] [--out file] [--stale-days N] [--limit N]');
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
