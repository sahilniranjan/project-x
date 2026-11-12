/**
 * lib/company-profile.mjs — pure company classification + filtering for the
 * company index (company-index.mjs). LOCAL to this checkout (not upstream).
 *
 * The public ATS directories scan-ats-full.mjs walks are bare board IDs: no
 * size, industry or type. Everything here is DERIVED from what a board itself
 * publishes (its postings) plus two local/free side sources (the H-1B DOL index
 * and VC portfolio lists). It is a best-effort signal, never ground truth:
 *
 *   size      ← open-role count on the board (a hiring-volume proxy, NOT headcount)
 *   industry  ← keyword evidence across titles + description snippets + name
 *   type      ← funding/listing language in descriptions, VC lists, staffing flags
 *   regions   ← posting locations
 *   workModel ← share of remote postings
 *
 * No I/O in this file — company-index.mjs does the fetching and storage, so the
 * rules here stay unit-testable.
 */

// ── Catalogs (single source of truth; the web panel renders these labels) ──

export const SIZE_BANDS = [
  { id: 'none', label: 'No open roles', min: 0, max: 0 },
  { id: 'xs', label: '1–5 open roles', min: 1, max: 5 },
  { id: 's', label: '6–25 open roles', min: 6, max: 25 },
  { id: 'm', label: '26–100 open roles', min: 26, max: 100 },
  { id: 'l', label: '101–500 open roles', min: 101, max: 500 },
  { id: 'xl', label: '500+ open roles', min: 501, max: Infinity },
];

// Terms are matched as lowercase substrings against a padded text blob, so a
// leading/trailing space in a term acts as a word boundary (" ai " ≠ "said").
export const INDUSTRIES = [
  { id: 'ai', label: 'AI & machine learning', terms: ['ai company', 'ai-native', 'ai-first', 'ai lab', 'ai research', 'ai platform', 'ai agents', 'generative ai', 'foundation model', 'large language model', 'frontier model', 'machine learning platform', 'artificial intelligence company', 'ai startup', 'computer vision', 'autonomous agents', 'ml research'] },
  { id: 'saas', label: 'Software & SaaS', terms: ['saas', 'software platform', 'b2b software', 'enterprise software', 'software company', 'platform that helps', 'workflow automation', 'all-in-one platform', 'cloud-based software'] },
  { id: 'devtools', label: 'Developer tools & cloud infra', terms: ['developer tools', 'developer platform', 'for developers', 'developer experience company', 'open-source project', 'open source company', 'observability platform', 'database company', 'api platform', 'cloud infrastructure company', 'infrastructure software', 'devops platform', 'serverless platform'] },
  { id: 'data', label: 'Data & analytics', terms: ['data platform', 'analytics platform', 'business intelligence platform', 'data company', 'data infrastructure company', 'analytics company', 'data cloud'] },
  { id: 'security', label: 'Cybersecurity', terms: ['cybersecurity', 'cyber security', 'security platform', 'threat detection', 'zero trust', 'identity security', 'endpoint security', 'vulnerability', 'security operations', 'penetration test'] },
  { id: 'fintech', label: 'Fintech & payments', terms: ['fintech', 'payments', 'banking', 'lending', 'credit card', 'neobank', 'brokerage', 'financial technology', 'money movement', 'card issuing', 'checkout'] },
  { id: 'finance', label: 'Banking, trading & investing', terms: ['hedge fund', 'investment bank', 'asset management', 'quantitative trading', 'trading firm', 'private equity', 'wealth management', 'portfolio manager', 'capital markets', 'financial advisor', 'investment firm'] },
  { id: 'insurance', label: 'Insurance', terms: ['insurance', 'insurtech', 'underwriting', 'underwriter', 'claims adjuster', 'actuar', 'policyholder'] },
  { id: 'crypto', label: 'Crypto & web3', terms: ['crypto ', 'cryptocurrency', 'blockchain', 'web3', ' defi ', ' defi,', 'bitcoin', 'ethereum', 'stablecoin', 'smart contract', 'on-chain', 'digital assets'] },
  { id: 'health', label: 'Healthcare & digital health', terms: ['healthcare', 'health care', 'patient', 'clinical', 'hospital', 'telehealth', 'medical', 'registered nurse', ' rn ', 'physician', 'care team', 'behavioral health', 'pharmacy'] },
  { id: 'biotech', label: 'Biotech & pharma', terms: ['biotech', 'pharmaceutical', 'drug discovery', 'therapeutics', 'clinical trial', 'genomics', 'life sciences', 'laboratory', 'biology', 'assay', 'biologics'] },
  { id: 'ecommerce', label: 'E-commerce & retail', terms: ['e-commerce', 'ecommerce', 'retail', 'shoppers', 'consumer brand', 'marketplace', 'store associate', 'merchandis', 'omnichannel', 'dtc '] },
  { id: 'consumer', label: 'Consumer apps & social', terms: ['consumer app', 'social network', 'creators', 'dating', 'mobile app', 'millions of users', 'community platform'] },
  { id: 'media', label: 'Media, entertainment & gaming', terms: ['gaming', 'video game', 'game studio', 'game designer', 'entertainment', 'streaming', 'media company', 'publishing', 'music', 'film', 'journalism', 'newsroom'] },
  { id: 'adtech', label: 'Marketing & adtech', terms: ['advertising', 'adtech', 'ad tech', 'marketing platform', 'martech', 'advertisers', 'programmatic', 'marketing agency'] },
  { id: 'edtech', label: 'Education & edtech', terms: ['education company', 'edtech', 'learning platform', 'online learning', 'k-12', 'learners', 'teachers', 'classroom', 'curriculum', 'tutoring', 'faculty', 'higher education'] },
  { id: 'hrtech', label: 'HR & future of work', terms: ['hr platform', 'payroll', 'recruiting platform', 'workforce management', 'human capital', 'benefits administration', 'talent platform'] },
  { id: 'legal', label: 'Legal & compliance', terms: ['law firm', 'legal tech', 'attorney', 'paralegal', 'litigation', 'compliance platform', 'regtech'] },
  { id: 'realestate', label: 'Real estate & proptech', terms: ['real estate', 'proptech', 'property management', 'mortgage', 'homeowners', 'leasing', 'construction tech'] },
  { id: 'logistics', label: 'Logistics & supply chain', terms: ['logistics', 'supply chain', 'freight', 'shipping company', 'warehouse associate', 'warehouse operations', 'distribution center', 'fleet', 'last-mile', 'fulfillment center', 'trucking', 'carriers'] },
  { id: 'mobility', label: 'Automotive & mobility', terms: ['automotive', 'autonomous vehicle', 'electric vehicle', 'mobility', 'self-driving', 'vehicle', 'autonomy', 'ride-hailing'] },
  { id: 'aerospace', label: 'Aerospace & defense', terms: ['aerospace', 'defense', 'satellite', 'spacecraft', 'aircraft', 'security clearance', 'national security', 'drone', 'avionics', 'department of defense', 'clearance required'] },
  { id: 'hardware', label: 'Hardware, robotics & chips', terms: ['hardware company', 'semiconductor', 'robotics', 'robots', 'silicon', 'firmware', 'embedded systems', 'asic', 'fpga', 'pcb', 'consumer electronics', 'devices'] },
  { id: 'energy', label: 'Energy & climate', terms: ['climate', 'renewable', 'solar', 'battery', 'energy', 'carbon', 'utility', 'power grid', 'oil and gas', 'decarboni', 'sustainability'] },
  { id: 'manufacturing', label: 'Manufacturing & industrial', terms: ['manufacturing', 'industrial', 'factory', 'plant operations', 'machinist', 'production line', 'cnc', 'assembly technician', 'quality inspector'] },
  { id: 'telecom', label: 'Telecom & networking', terms: ['telecommunications', 'telecom', 'wireless', ' 5g', 'networking', 'broadband', 'fiber network'] },
  { id: 'consulting', label: 'Consulting & IT services', terms: ['consulting firm', 'consulting company', 'consultancy', 'management consulting', 'professional services firm', 'it services', 'systems integrator', 'our consultants', 'client engagements', 'advisory firm'] },
  { id: 'staffing', label: 'Staffing & recruiting agencies', terms: ['staffing agency', 'staffing firm', 'staffing company', 'our client is', 'our client, a', 'contract-to-hire', 'contract to hire', ' c2c', 'recruitment agency', 'direct placement'] },
  { id: 'government', label: 'Government & public sector', terms: ['government', 'public sector', 'federal agency', 'state agency', 'municipal', 'civic', 'county of', 'city of'] },
  { id: 'nonprofit', label: 'Nonprofit & mission-driven', terms: ['nonprofit', 'non-profit', '501(c)', 'charity', 'philanthrop', 'mission-driven organization'] },
  { id: 'hospitality', label: 'Food, hospitality & travel', terms: ['restaurant', 'hospitality', 'hotel', 'travel company', 'food company', 'guest experience', 'culinary', 'airline', 'travelers'] },
  { id: 'veterinary', label: 'Veterinary & pet care', terms: ['veterinary', 'animal hospital', 'pet care', 'pet owners', 'veterinarian', ' dvm'] },
];

export const COMPANY_TYPES = [
  { id: 'startup', label: 'Startup (seed–Series B)' },
  { id: 'scaleup', label: 'Scale-up (Series C+ / late stage)' },
  { id: 'public', label: 'Public company' },
  { id: 'enterprise', label: 'Large enterprise' },
  { id: 'agency', label: 'Staffing / recruiting agency' },
  { id: 'consultancy', label: 'Consultancy / services firm' },
  { id: 'government', label: 'Government / public sector' },
  { id: 'nonprofit', label: 'Nonprofit / education / research' },
];

export const FUNDING = [
  { id: 'yc', label: 'Y Combinator' },
  { id: 'a16z', label: 'a16z portfolio' },
  { id: 'vc', label: 'VC-backed (mentions investors)' },
  { id: 'seed', label: 'Seed / pre-seed' },
  { id: 'series-a', label: 'Series A' },
  { id: 'series-b', label: 'Series B' },
  { id: 'series-c', label: 'Series C+' },
  { id: 'ipo', label: 'Public (IPO / listed)' },
];

export const WORK_MODELS = [
  { id: 'remote', label: 'Remote-first (≥60% remote roles)' },
  { id: 'mixed', label: 'Mixed remote + office' },
  { id: 'onsite', label: 'Mostly on-site (<15% remote)' },
];

export const REGIONS = [
  { id: 'us', label: 'United States' },
  { id: 'canada', label: 'Canada' },
  { id: 'uk', label: 'United Kingdom & Ireland' },
  { id: 'europe', label: 'Europe (EU/EEA/CH)' },
  { id: 'india', label: 'India' },
  { id: 'latam', label: 'Latin America' },
  { id: 'apac', label: 'Asia-Pacific' },
  { id: 'mea', label: 'Middle East & Africa' },
  { id: 'remote', label: 'Remote (any)' },
];

export const H1B_TIERS = [
  { id: 'strong', label: 'Strong sponsor (recent LCAs + green cards)' },
  { id: 'moderate', label: 'Moderate sponsor' },
  { id: 'weak', label: 'Weak / old filings' },
  { id: 'none', label: 'No filings on record' },
  { id: 'staffing-shop', label: 'Staffing-shop pattern' },
];

export const CATALOG = {
  sizes: SIZE_BANDS.map(({ id, label }) => ({ id, label })),
  industries: INDUSTRIES.map(({ id, label }) => ({ id, label })),
  types: COMPANY_TYPES,
  funding: FUNDING,
  workModels: WORK_MODELS,
  regions: REGIONS,
  h1b: H1B_TIERS,
};

// ── Helpers ─────────────────────────────────────────────────────────

export function sizeBand(openRoles) {
  const n = Number(openRoles);
  if (!Number.isFinite(n) || n < 0) return null;
  return SIZE_BANDS.find(b => n >= b.min && n <= b.max)?.id ?? null;
}

/** Human company name from a dataset slug ("scale-ai" → "Scale Ai"). */
export function displayNameFromSlug(slug) {
  const base = String(slug || '').split('|')[0];
  return base
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Lowercase, alnum-only — the join key against H-1B / VC names. */
export function squash(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Legal suffixes stripped for the squash join only ("Acme Inc" ~ board "acme").
const LEGAL_SUFFIX_RE = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|lp|llp|pbc|holdings?|technologies|technology|labs?|group|usa|us|na|n\.a)\b\.?/gi;
export function joinKey(name) {
  return squash(String(name || '').replace(LEGAL_SUFFIX_RE, ' '));
}

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const US_STATE_RE = new RegExp(`(?:,|\\s-)\\s*(?:${US_STATES})\\b(?!\\s*,\\s*(?:canada|ca\\b))`);
const US_WORD_RE = /\b(united states|usa|u\.s\.a?\.?|us-remote|remote[ ,-]+us|us[ ,-]+remote|\bus\b|america)\b|new york|san francisco|seattle|boston|austin|chicago|los angeles|denver|atlanta|washington,? d\.?c|bay area|silicon valley|california|texas|massachusetts|virginia|florida|colorado|illinois|georgia|pennsylvania|new jersey|north carolina|ohio|michigan|minnesota|arizona|oregon|utah|maryland|tennessee|missouri|wisconsin|indiana|connecticut/;
const REGION_RULES = [
  ['canada', /\bcanada\b|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo|edmonton|,\s*(on|bc|qc|ab|mb|ns)\b/],
  ['uk', /united kingdom|\buk\b|england|london|manchester|edinburgh|scotland|ireland|dublin|belfast|cambridge, uk|bristol/],
  ['europe', /germany|berlin|munich|hamburg|france|paris|spain|madrid|barcelona|italy|milan|netherlands|amsterdam|belgium|brussels|poland|warsaw|krakow|portugal|lisbon|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|zürich|geneva|austria|vienna|czech|prague|romania|bucharest|hungary|budapest|greece|athens|europe|\beu\b|emea|estonia|tallinn|lithuania|vilnius|latvia|ukraine|kyiv|serbia|belgrade|croatia|bulgaria|sofia|luxembourg/],
  ['india', /\bindia\b|bengaluru|bangalore|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|new delhi|delhi|kolkata|ahmedabad/],
  ['latam', /mexico|méxico|brazil|brasil|são paulo|sao paulo|argentina|buenos aires|colombia|bogot|medell|chile|santiago|peru|lima|uruguay|montevideo|costa rica|latam|latin america|guadalajara|ecuador/],
  ['apac', /china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|singapore|japan|tokyo|korea|seoul|philippines|manila|vietnam|indonesia|jakarta|thailand|bangkok|malaysia|kuala lumpur|australia|sydney|melbourne|brisbane|new zealand|auckland|apac|asia/],
  ['mea', /israel|tel aviv|united arab emirates|\buae\b|dubai|abu dhabi|saudi|riyadh|qatar|doha|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|cape town|johannesburg|middle east|africa|turkey|istanbul/],
];
const REMOTE_RE = /\bremote\b|work from home|\bwfh\b|anywhere|distributed/;

/** Region ids one posting location touches. */
export function locationRegions(location, title = '') {
  const raw = String(location || '');
  const loc = raw.toLowerCase();
  const out = new Set();
  if (REMOTE_RE.test(loc) || /\bremote\b/i.test(String(title || ''))) out.add('remote');
  let foreign = false;
  for (const [id, re] of REGION_RULES) {
    if (re.test(loc)) { out.add(id); foreign = true; }
  }
  // US last: ", CA" is California unless Canada already claimed the posting.
  if (US_WORD_RE.test(loc) || (US_STATE_RE.test(raw) && !out.has('canada'))) out.add('us');
  else if (!foreign && /\b(ca|ny|tx|ma|wa)\b$/i.test(raw.trim())) out.add('us');
  return out;
}

const ENG_RE = /engineer|developer|programmer|software|scientist|\bdata\b|machine learning|\bml\b|\bai\b|devops|\bsre\b|architect|security analyst|qa automation|firmware|technical/i;
const ENTRY_RE = /new grad|graduate|entry[- ]level|\bjunior\b|\bjr\.?\b|early[- ]career|university|apprentice|associate (software|data|engineer|developer|scientist)|\b(engineer|developer|analyst|scientist) (i|1)\b|\blevel (i|1)\b|\bl1\b/i;
const INTERN_RE = /\bintern(ship)?\b|\bco-?op\b/i;

const STAGE_RES = [
  ['seed', /\b(pre-?seed|seed[- ](stage|round|funded|funding))\b/],
  ['series-a', /\bseries a\b/],
  ['series-b', /\bseries b\b/],
  ['series-c', /\bseries [c-h]\b|late[- ]stage|unicorn|pre-ipo/],
  ['ipo', /\b(nasdaq|nyse|tsx|lse|euronext)\s*[:(]|publicly[- ]traded|public company|fortune 500|s&p 500|listed on the/],
];
const VC_RE = /\b(venture[- ]backed|vc[- ]backed|backed by (top|leading|world-class|investors|[a-z0-9 ,&]+(capital|ventures|partners))|raised \$?\d|funding from|investors include|y combinator|sequoia|andreessen|a16z|accel|benchmark|index ventures|lightspeed|greylock|kleiner|founders fund|general catalyst|tiger global|insight partners|khosla)/;
const ABOUT_RE = /about (us|the company|the team|[A-Z][\w&.'-]+(?: [A-Z][\w&.'-]+){0,3})\b|who we are|our mission|company overview|we are an? |we're an? /i;
const STARTUP_RE = /\bstartup\b|start-up|early[- ]stage|founding (engineer|team|member)|small team/;

/**
 * Build one company record from a board's postings. `jobs` is the provider's
 * array ({title, location, description?, postedAt?}); `total` is a provider's
 * reported full count when it only returned a page (workday).
 */
export function profileFromJobs({ ats, slug, name, jobs = [], total = null }) {
  const list = Array.isArray(jobs) ? jobs.filter(j => j && j.title) : [];
  const openRoles = Number.isFinite(total) && total >= list.length ? total : list.length;

  // Text blob: name + all titles + head/tail snippets of up to 15 descriptions.
  // The "about us" paragraph almost always sits at the start or the end.
  const parts = [` ${name || ''} `];
  for (const j of list) parts.push(` ${j.title} `);
  // The company's self-description is the strongest industry signal and the
  // requirements list the weakest ("SQL database", "university degree"), so the
  // "About us" paragraph, wherever it sits, is counted twice.
  let described = 0;
  for (const j of list) {
    if (described >= 15) break;
    const d = typeof j.description === 'string' ? j.description : '';
    if (d.length < 40) continue;
    described++;
    parts.push(` ${d.slice(0, 600)} `, ` ${d.slice(-400)} `);
    const m = ABOUT_RE.exec(d);
    if (m) { const about = d.slice(m.index, m.index + 700); parts.push(` ${about} `, ` ${about} `); }
  }
  const blob = parts.join(' ').toLowerCase().replace(/\s+/g, ' ');

  // Industry: distinct-term hits, weighted by repetition (capped) so one stray
  // mention doesn't tag a company, then keep the top 3 above a floor.
  const scores = [];
  for (const ind of INDUSTRIES) {
    let s = 0;
    for (const t of ind.terms) {
      const hits = countOccurrences(blob, t);
      if (hits) s += 1 + Math.min(hits - 1, 4) * 0.5;
    }
    if (s > 0) scores.push([ind.id, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores[0]?.[1] ?? 0;
  const industries = scores.filter(([, s], i) => s >= 2.5 && (i === 0 || s >= top * 0.55)).slice(0, 3).map(([id]) => id);

  // Locations → regions + remote share + US share.
  const regionCounts = {};
  let remote = 0;
  let us = 0;
  for (const j of list) {
    const r = locationRegions(j.location, j.title);
    for (const id of r) regionCounts[id] = (regionCounts[id] || 0) + 1;
    if (r.has('remote')) remote++;
    if (r.has('us')) us++;
  }
  const n = list.length || 1;
  const regions = Object.entries(regionCounts)
    .filter(([, c]) => c >= 3 || c / n >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const remoteShare = list.length ? round2(remote / n) : null;
  const usShare = list.length ? round2(us / n) : null;

  // Role mix.
  let eng = 0;
  let entry = 0;
  let interns = 0;
  for (const j of list) {
    if (ENG_RE.test(j.title)) eng++;
    if (INTERN_RE.test(j.title)) interns++;
    else if (ENTRY_RE.test(j.title)) entry++;
  }

  // Funding / listing language.
  const funding = [];
  for (const [id, re] of STAGE_RES) if (re.test(blob)) funding.push(id);
  if (VC_RE.test(blob)) funding.push('vc');

  return {
    a: ats,
    s: slug,
    n: name || displayNameFromSlug(slug),
    st: 'ok',
    t: new Date().toISOString().slice(0, 10),
    r: openRoles,
    ind: industries,
    reg: regions,
    rem: remoteShare,
    us: usShare,
    eng: list.length ? round2(eng / n) : null,
    entry,
    intern: interns,
    fund: funding,
    startup: STARTUP_RE.test(blob),
  };
}

/** Company types derived from a record (after H-1B / VC enrichment). */
export function companyTypes(rec) {
  if (!rec || rec.st !== 'ok') return [];
  const fund = new Set(rec.fund || []);
  const ind = new Set(rec.ind || []);
  const out = new Set();
  const vcBacked = fund.has('vc') || fund.has('yc') || fund.has('a16z');
  if (fund.has('ipo')) out.add('public');
  if (fund.has('series-c')) out.add('scaleup');
  if (!fund.has('ipo') && !fund.has('series-c') && (fund.has('seed') || fund.has('series-a') || fund.has('series-b') || rec.startup || (vcBacked && (rec.r ?? 0) <= 60))) out.add('startup');
  if (vcBacked && (rec.r ?? 0) > 60 && !fund.has('ipo')) out.add('scaleup');
  // Big VC-backed boards without an early-stage round named are scale-ups, not startups.
  if (out.has('scaleup') && !fund.has('seed') && !fund.has('series-a') && !fund.has('series-b')) out.delete('startup');
  if ((rec.r ?? 0) > 500 || (rec.lca ?? 0) >= 500) out.add('enterprise');
  if (ind.has('staffing') || rec.h1b === 'staffing-shop') out.add('agency');
  if (ind.has('consulting')) out.add('consultancy');
  if (ind.has('government')) out.add('government');
  if (ind.has('nonprofit') || (ind.has('edtech') && /universit|college|institute|school/i.test(rec.n || ''))) out.add('nonprofit');
  return [...out];
}

export function workModel(rec) {
  if (!rec || rec.rem == null) return null;
  if (rec.rem >= 0.6) return 'remote';
  if (rec.rem >= 0.15) return 'mixed';
  return 'onsite';
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let c = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && c < 20) { c++; i = hay.indexOf(needle, i + needle.length); }
  return c;
}

function round2(x) { return Math.round(x * 100) / 100; }

// ── Filtering + prioritization ──────────────────────────────────────

export const DEFAULT_COMPANY_FILTER = {
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

const asList = v => (Array.isArray(v) ? v.map(x => String(x).trim().toLowerCase()).filter(Boolean) : []);
const clamp01 = v => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n > 1 ? n / 100 : n)) : 0; };

export function normalizeCompanyFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    sizes: asList(f.sizes),
    industries: asList(f.industries),
    excludeIndustries: asList(f.excludeIndustries),
    types: asList(f.types),
    excludeTypes: asList(f.excludeTypes),
    funding: asList(f.funding),
    workModels: asList(f.workModels),
    regions: asList(f.regions),
    minUsShare: clamp01(f.minUsShare),
    h1b: asList(f.h1b),
    entryLevel: f.entryLevel === true,
    minEngShare: clamp01(f.minEngShare),
    nameInclude: asList(f.nameInclude),
    nameExclude: asList(f.nameExclude),
    skipEmpty: f.skipEmpty !== false,
    skipApplied: f.skipApplied === true,
    includeUnknown: f.includeUnknown !== false,
  };
}

export function isFilterActive(f) {
  return !!(f.sizes.length || f.industries.length || f.excludeIndustries.length || f.types.length || f.excludeTypes.length
    || f.funding.length || f.workModels.length || f.regions.length || f.minUsShare > 0 || f.h1b.length
    || f.entryLevel || f.minEngShare > 0 || f.nameInclude.length || f.nameExclude.length || f.skipApplied);
}

/**
 * Does a dataset company pass the filter? `rec` is its index record or null
 * when it has never been indexed. ctx: { applied:Set<joinKey> }.
 *
 * Within a group the options OR; groups AND. A group is skipped for a company
 * whose value is unknown when includeUnknown is on, and fails it otherwise.
 */
export function matchesCompanyFilter(rec, name, f, ctx = {}) {
  const lname = String(name || rec?.n || '').toLowerCase();
  if (f.nameExclude.some(t => lname.includes(t))) return false;
  if (f.nameInclude.length && !f.nameInclude.some(t => lname.includes(t))) return false;
  if (f.skipApplied && ctx.applied?.has(joinKey(name || rec?.n))) return false;

  // Never-indexed or unreachable: no traits to test.
  if (!rec || rec.st !== 'ok') {
    if (rec && rec.st === 'unreachable' && (rec.fails ?? 1) >= 2) return false;
    return f.includeUnknown || !isTraitFilterActive(f);
  }

  if (f.skipEmpty && rec.r === 0) return false;

  const unknown = f.includeUnknown;
  const group = (selected, values, known = true) => {
    if (!selected.length) return true;
    if (!known || !values.length) return unknown;
    return selected.some(s => values.includes(s));
  };

  if (!group(f.sizes, [sizeBand(rec.r)].filter(Boolean))) return false;
  if (!group(f.industries, rec.ind || [])) return false;
  if (f.excludeIndustries.length && (rec.ind || []).some(i => f.excludeIndustries.includes(i))) return false;
  const types = companyTypes(rec);
  if (!group(f.types, types)) return false;
  if (f.excludeTypes.length && types.some(t => f.excludeTypes.includes(t))) return false;
  if (!group(f.funding, rec.fund || [])) return false;
  const wm = workModel(rec);
  if (!group(f.workModels, wm ? [wm] : [], wm != null)) return false;
  if (!group(f.regions, rec.reg || [], rec.r > 0)) return false;
  if (f.minUsShare > 0) {
    if (rec.us == null) { if (!unknown) return false; } else if (rec.us < f.minUsShare) return false;
  }
  if (f.h1b.length) {
    const tier = rec.h1b && rec.h1b !== 'unknown' ? rec.h1b : null;
    if (!tier) { if (!unknown) return false; } else if (!f.h1b.includes(tier)) return false;
  }
  if (f.entryLevel && !(rec.entry > 0 || rec.intern > 0)) return false;
  if (f.minEngShare > 0) {
    if (rec.eng == null) { if (!unknown) return false; } else if (rec.eng < f.minEngShare) return false;
  }
  return true;
}

function isTraitFilterActive(f) {
  return !!(f.sizes.length || f.industries.length || f.types.length || f.funding.length || f.workModels.length
    || f.regions.length || f.minUsShare > 0 || f.h1b.length || f.entryLevel || f.minEngShare > 0);
}

/**
 * Scan priority — higher scans first. ctx: { matchedBefore:Set<joinKey> }.
 * Known-good boards beat never-indexed ones; boards that produced matches for
 * you before beat everything; more open roles and more engineering roles = more
 * chances of a hit.
 */
export function priorityScore(rec, name, ctx = {}) {
  let s = 0;
  const key = joinKey(name || rec?.n);
  if (ctx.matchedBefore?.has(key)) s += 1000;
  if (!rec) return s + 50; // unknown: middle of the pack
  if (rec.st !== 'ok') return s - 500;
  const roles = rec.r ?? 0;
  if (roles === 0) return s - 200;
  s += 100 + Math.min(120, Math.log2(roles + 1) * 15);
  if (rec.eng != null) s += rec.eng * 80;
  if (rec.h1b === 'strong') s += 25;
  else if (rec.h1b === 'moderate') s += 12;
  return Math.round(s);
}
