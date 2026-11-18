<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="project-x" width="231" height="56"></picture></p>

<p align="center"><strong>My personal AI job-search system: find the right roles, judge the fit, apply with intent.</strong></p>

---

## Why I built this

Job boards bury good roles under thousands of stale, mismatched or unsponsored listings, and applying blindly is slow and demoralizing. I wanted a system that runs on my own machine and does three things well:

1. **Finds** every relevant opening across the company job boards I care about, every night, without me lifting a finger.
2. **Judges** each role honestly against my real CV, including work-authorization (H-1B) signals, so I spend my evenings only on roles worth it.
3. **Prepares** a tailored CV and answers, while **I** stay the one who reviews and presses Submit.

project-x is that system. It runs locally inside an AI coding CLI (I use Claude Code), keeps all my data on my laptop, and never applies to anything on its own.

## What it does

| Area | What happens |
|---|---|
| **Nightly discovery** | Scheduled sweeps of Greenhouse, Lever, Ashby and Workday boards (~15k+ companies). Every URL ever seen is recorded, so the morning inbox only holds roles that are genuinely new. |
| **Company index** | Each board is profiled once: size, industry, regions, remote share, engineering share, funding, and H-1B sponsorship tier. Boards are ranked by a priority score so the most promising companies are scanned and shown first. |
| **Explore panel** | A local web panel to browse the index and live jobs, filter by company attributes, and watch a scan trace board by board as it runs. |
| **Fit evaluation** | Paste a job URL or description: it checks the posting is still live, scores it against my CV, flags hard blockers such as explicit no-sponsorship, and writes a structured report. |
| **Tailored materials** | ATS-friendly CV PDFs and cover letters built from my own experience, with a fact check that blocks numbers or claims not found in my CV. |
| **Tracking & follow-ups** | Every application lives in a local tracker, with status changes, follow-up reminders and pattern analysis across outcomes. |

### Principles

- **Human in the loop.** It drafts and fills forms, but never submits an application or sends a message.
- **Local first.** CV, profile, tracker, reports and scan data stay on my machine and are excluded from git.
- **Signal over volume.** Apply better to fewer roles.
- **Reformulate, never fabricate.** Tailored CVs only reword what is actually true.

## Running it

**Requirements:** Node.js 20+, an AI coding CLI (Claude Code recommended), and Playwright for PDFs and liveness checks.

```bash
npm install
npx playwright install chromium
claude            # open the CLI in this folder; first launch walks through setup
```

### Everyday commands (inside the CLI)

| Command | What it does |
|---|---|
| paste a URL or JD | Liveness check, evaluation, report, tailored CV, tracker row |
| `/project-x scan` | Scan configured portals for new postings into `data/pipeline.md` |
| `/project-x pipeline` | Work through the inbox of waiting URLs |
| `/project-x apply` | Fill an application form with me, field by field. It stops before Submit |
| `/project-x tracker` | Where every application stands |
| `/project-x followup` | Which applications are due a follow-up, with drafts |

### Local panel and scheduled jobs (macOS)

```bash
./ProjectX.command            # start the web panel (http://localhost:3000) and open it
./ProjectX.command dev        # dev server with hot reload
./ProjectX.command rebuild    # rebuild after changes under web/src

./nightly-scan.sh fast        # Greenhouse + Lever + Ashby sweep
./nightly-scan.sh workday     # Workday sweep (rate-limited, slower)

node company-index.mjs build|enrich|stats|select   # build and query the company index
```

The panel and nightly scans run as `launchd` agents (`io.project-x.panel`, `io.project-x.nightly`, `io.project-x.workday`). Logs go to `~/Library/Logs/project-x`.

## Project layout

```
project-x/
├── AGENTS.md / CLAUDE.md      # agent instructions
├── modes/                     # evaluation, scan, pdf, apply, followup ... modes
├── providers/                 # ATS board integrations (Greenhouse, Lever, Ashby, Workday, ...)
├── company-index.mjs          # company index builder
├── lib/company-profile.mjs    # per-company profiling (size, funding, H-1B, ...)
├── scan-ats-full.mjs          # full-network ATS sweep
├── nightly-scan.sh            # scheduled sweep entry point
├── ProjectX.command           # panel launcher
├── web/                       # local Next.js panel
├── templates/                 # CV template, portal config template, statuses
├── dashboard/                 # terminal (Go) dashboard
├── data/ reports/ output/     # my personal data (gitignored)
└── cv.md, config/profile.yml  # my CV and profile (gitignored)
```

## Privacy

Personal files (`cv.md`, `config/profile.yml`, `data/`, `reports/`, `output/`, scan history, H-1B data) are listed in `.gitignore` and are never committed. The CV only travels from this machine to the AI provider used by the CLI.

## Credits & license

project-x is my personal, heavily customized build of the open-source **[career-ops](https://github.com/career-ops-hq/career-ops)** project by Santiago Fernández de Valderrama. The original code is used under the MIT License, whose copyright notice and terms are kept in [`LICENSE`](LICENSE) as that license requires.

My own additions (the company index and profiling, the Explore panel, scan tracing, nightly scheduling, launchers and the project-x branding) are © 2026 Sahil Niranjan. All rights reserved.
