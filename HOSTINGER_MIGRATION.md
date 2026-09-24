# CyberSE → Hostinger Migration

This branch is the self-hosted CyberSE migration target. It preserves the existing `main` branch until the replacement deployment is validated.

## What is already migrated

- Next.js 15 / React 19 application shell.
- Recovered CyberSE client application and global styling from the last self-hosted export.
- Public, authentication, admin and portal API routes.
- PostgreSQL database client using `DATABASE_URL`.
- Complete live PostgreSQL schema recovery: 49 tables, 537 columns, 24 enum types, 44 sequences, 522 constraints and 123 indexes.
- `pgcrypto` extension requirement.
- Private uploads moved away from Vercel Blob to PostgreSQL-backed storage (`self_hosted_file_blobs`).
- Authenticated download route for recruitment resumes and engagement documents.
- Build-time materialization of the recovered source and `database/schema.sql`.
- Node.js 22+ runtime declaration.

## Why source materialization exists

The previous GitHub export was incomplete: the catch-all route referenced `components/CyberSEApp.tsx`, while the component, portal API route and global stylesheet were absent. The original self-hosted archive was recovered from the live CyberSE project and stored as compressed source payloads under `migration_payload/`.

`npm run build`, `npm run dev`, and `npm run typecheck` run `scripts/materialize-migration.mjs`, which reconstructs:

- `components/CyberSEApp.tsx`
- `app/api/portal/[...path]/route.ts`
- `app/globals.css`
- `database/schema.sql`

No production secret is stored in the repository.

## Required production environment variables

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=require
JWT_SECRET=<strong random secret, at least 32 bytes>
NEXT_PUBLIC_APP_URL=https://cybersehq.com
```

Do not commit the real values.

## Database target

CyberSE uses PostgreSQL-specific SQL and data types, so the safest Hostinger architecture is:

- Hostinger: Next.js application runtime
- External PostgreSQL: Supabase, Neon, or another PostgreSQL service
- CyberSE private file blobs: stored in the PostgreSQL database

Hostinger's Node.js dashboard currently has a Database Connect Wizard for Supabase. A normal PostgreSQL connection string also works through `DATABASE_URL`.

### Schema creation

After the repository is installed or `npm run build` has run, execute `database/schema.sql` against the empty target PostgreSQL database before importing data.

Example with `psql`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

## Live records

The live Floot database contains private account/business data and must not be committed to this public repository. Export the current Floot database as a PostgreSQL dump, then restore it into the target PostgreSQL database.

Recommended order:

1. Create empty PostgreSQL database.
2. Restore the original database dump OR run `database/schema.sql` and then import data.
3. Verify row counts and application login.
4. Set the Hostinger environment variables.
5. Deploy this branch.
6. Verify `/api/health`, public pages, login, admin portal, career application upload and portal document upload/download.
7. Point `cybersehq.com` and `www.cybersehq.com` to the validated Hostinger deployment only after acceptance.

## Hostinger deployment

Preferred deployment method: connect Hostinger directly to the GitHub repository and select the `hostinger-migration` branch for the first validation deployment.

Recommended runtime/build values:

- Framework: Next.js
- Node.js: 22.x
- Install: `npm install`
- Build: `npm run build`
- Start: `npm start`
- Build output: `.next` when Hostinger asks for an output directory

The `prebuild` hook automatically reconstructs the recovered CyberSE source before Next.js compiles it.

## Production cutover rule

Do not merge this branch to `main`, change DNS, or shut down the Floot deployment until all validation checks pass and the live database records have been restored to the new PostgreSQL database.
