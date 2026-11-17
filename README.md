# DL3 Investment Intelligence

A web app that ranks US states for DL3's LIHTC (low-income housing tax credit) development, 9% and 4% pathways,
from public agency documents collected by a data pipeline. The final presentation covers Michigan, Ohio and Indiana;
the pipeline can collect any state.

## What's on the site

- **Overview, Rankings, Territories:** the ranking for all 50 states (map or list) and a page per state with its
  checks, scores by criterion, the pipeline's evidence (approved rules with quotes and page numbers, award history,
  cost per unit, top-100 metro screen) and links to the agency documents. A score with ≈ is an estimate while some
  evidence is still missing; a plain score means the state passed every check.
- **Detailed model:** the full ranking model with its views, what-if settings and exports.
- **Sources & Evidence:** every document the pipeline keeps, with retrieval dates and staleness.
- **Review Queue:** what still stands between each researched state and a firm score, and who supplies it.
- **Run pipeline:** DL3 staff pick states, enter their Gemini and Census API keys, and start the pipeline. It runs in
  GitHub Actions (`.github/workflows/pipeline.yml`); the keys are sealed in the browser so only the pipeline can read
  them. Results appear on the site when the run finishes.
- **DL3 inputs:** DL3's confidential fee terms, hurdles and per-state judgments. They stay in the employee's browser
  and are never sent anywhere or committed.

## Where things live

- `src/` — the website (React + Vite). `src/model/` connects the pages to the ranking engine (`src/ranking/`), DL3's
  inputs and the pipeline.
- `dl3-lihtc-model/` — the data pipeline (Python). See its README and `docs/refresh_instructions.md`.
- `public/.herenow/proxy.json` — the site's server-side connections to GitHub and to the pipeline's results. The
  secrets they use are here.now variables, never in this repository.

## Run it on your computer

```bash
npm install
npm run dev
```

Running the pipeline from the site only works on the team's own here.now sites. This repository is public: never
commit DL3's confidential numbers, API keys or personal information.
