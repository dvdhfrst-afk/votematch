# VoteMatch

VoteMatch matches voters to the candidates on their ballot at every level of
government, from national offices down to local ones. A voter answers short
issue questions, and VoteMatch compares those answers with candidates' sourced
positions to show how closely each candidate on the ballot aligns.

The product was renamed from Havesay, and older parts of the code still use
that name; `src/lib/brand.ts` holds the current one.

This repository is the web app: Next.js (App Router) with React, Supabase for
data and auth, Inngest for background jobs, and Vitest for tests.

## Requirements

- Node.js 20 or newer
- npm

## Setup

```bash
npm install
```

```bash
cp .env.example .env.local
```

The example file holds placeholders only. The unit tests and the mock ballot
guide need none of them. Pages that read real data need a Supabase project
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`); the database schema is in `supabase/migrations/`.

## Run the UI against the mock provider

The ballot guide under `/guide` can run on a built-in fictional ballot with no
database. In `.env.local` set:

```bash
NEXT_PUBLIC_GUIDE_PROVIDER=mock
```

Then start the dev server (the mock is only honored in development):

```bash
npm run dev
```

Open http://localhost:4000/guide. All names and data on the mock ballot are
fictional.

## Checks

```bash
npx tsc --noEmit
```

```bash
npx vitest run
```

The Vitest suite mocks Supabase, `fetch` and Next.js, so it needs no network,
database or API keys. Adapter tests under `src/lib/adapters/**/__tests__/` use
the Node test runner instead; run one with `npx tsx --test <file>`.

## Outbound requests

Data adapters identify themselves with a single bot User-Agent
(`src/lib/bot-user-agent.ts`) and space requests per host. Sources that refuse automated clients are treated as
unavailable.

## License

MIT. See `LICENSE`.
