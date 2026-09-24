# CyberSE Vercel migration handoff

## Current state

- Repository: `ahmad-cyber-se/cyberse`
- Production branch: `main`
- Migration PR: #2 `Complete CyberSE migration to Vercel` — merged
- Migration merge commit: `381953f0bf9c008e4038f668cde7b2304b7a9e64`
- The migrated application passed its migration-surface audit, TypeScript check, and full Next.js production build before merge.
- The live Hostinger-managed domain has not been pointed to Vercel yet.

## Vercel target

- Team slug: `ahmad7stantec-3787`
- Team ID: `team_emD5Alk8bAALnjVupClBBKRy`
- Project: `cyberse`
- Project ID: `prj_ntvZPmuu9HMu1eszxbeQ58DbKS2t`
- Framework: Next.js

The existing Vercel deployments predate the completed migration and are failed builds. The latest inspected production deployment `dpl_zt3KacghXU5nYD2juBn8mbmfu2Wf` failed at `npm run build`. Vercel did not create a new deployment after the GitHub merge, confirming the existing Vercel project is not currently connected to this GitHub repository.

## Deployment bridge

`.github/workflows/deploy-vercel-production.yml` targets the existing Vercel team/project IDs and can build/deploy `main` after a GitHub repository secret named `VERCEL_TOKEN` is available. The workflow safely skips deployment when that secret is absent.

A test run confirmed that `VERCEL_TOKEN` is currently not configured in the repository.

## Required Vercel environment

Configure these values in Vercel for Production (and Preview when preview deployments are used):

- `DATABASE_URL` — existing CyberSE Neon PostgreSQL connection string. Reuse the existing database; do not recreate or wipe it.
- `DATABASE_SSL=require`
- `JWT_SECRET` — strong production secret, preserved consistently across deployments.
- `BLOB_READ_WRITE_TOKEN` — token for the private Vercel Blob store used by documents and career résumés.
- `NEXT_PUBLIC_APP_URL=https://cybersehq.com`

Never commit real secret values to Git.

## Remaining cutover sequence

1. Authorize deployment to the existing Vercel `cyberse` project by either connecting GitHub repository `ahmad-cyber-se/cyberse` in Vercel or configuring repository secret `VERCEL_TOKEN` for the deployment workflow.
2. Deploy `main` to Vercel while `cybersehq.com` is still on Hostinger.
3. Smoke test public pages, authentication, admin portal, engagement portal, documents, recruitment/CV upload, inquiry workflow, and database-backed actions on the Vercel URL.
4. Confirm there are no unexpected runtime errors in Vercel logs.
5. Attach `cybersehq.com` and `www.cybersehq.com` to the Vercel project.
6. Use the exact DNS records Vercel requests, then update the Hostinger-managed DNS. Do not transfer the domain registration.
7. Verify HTTPS, apex/www behavior, login, CV upload, admin access, and database writes on the production domain.

## Platform parity

The migrated web application has no remaining Floot runtime imports or Floot runtime URLs. Engagement messaging is database/API-backed and refreshes after sending. Floot-native mobile packaging and Floot-specific realtime/push delivery are outside the Vercel web runtime; in-app notification records and push-subscription data paths remain available, while external push delivery would require a separate provider if needed.
