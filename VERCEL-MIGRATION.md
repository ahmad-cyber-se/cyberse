# CyberSE Vercel migration handoff

## Verified source

- Repository: `ahmad-cyber-se/cyberse`
- Migration branch: `vercel-migration`
- Production branch: `main` (do not merge until preview is verified)
- Pull request: #2 `Complete CyberSE migration to Vercel`

## Vercel target

- Team slug: `ahmad7stantec-3787`
- Team ID: `team_emD5Alk8bAALnjVupClBBKRy`
- Project: `cyberse`
- Project ID: `prj_ntvZPmuu9HMu1eszxbeQ58DbKS2t`
- Framework: Next.js

Existing Vercel deployments predate the migration branch and are failed builds. The latest inspected production deployment `dpl_zt3KacghXU5nYD2juBn8mbmfu2Wf` failed at `npm run build`; it is not evidence against the migration branch because the migration branch passes its own full production build in GitHub Actions.

## Required Vercel environment

Configure these values for Preview and Production before smoke testing:

- `DATABASE_URL` — existing CyberSE Neon PostgreSQL connection string. Reuse the existing database; do not recreate or wipe it.
- `DATABASE_SSL=require`
- `JWT_SECRET` — strong production secret, preserved consistently across production deployments.
- `BLOB_READ_WRITE_TOKEN` — token for the private Vercel Blob store used by documents and career résumés.
- `NEXT_PUBLIC_APP_URL=https://cybersehq.com`

Do not commit any real secret values to Git.

## Deployment sequence

1. Connect the existing Vercel `cyberse` project to GitHub repository `ahmad-cyber-se/cyberse`.
2. Keep `main` as the production branch.
3. Deploy `vercel-migration` as a Preview.
4. Smoke test public pages, authentication, admin portal, engagement portal, documents, recruitment/CV upload, inquiry workflow, and database-backed actions.
5. Confirm no unexpected runtime errors in Vercel logs.
6. Merge PR #2 only after preview verification.
7. Attach `cybersehq.com` and `www.cybersehq.com` to the Vercel project.
8. Use the exact DNS records Vercel requests, then update the Hostinger-managed DNS. Do not transfer the domain registration.
9. Verify HTTPS, apex/www redirect behavior, login, CV upload, admin access, and database writes on the production domain.

## Platform parity

The migrated web application has no remaining Floot runtime imports or Floot runtime URLs. Engagement messaging is database/API-backed and refreshes after sending. Floot-native mobile packaging and Floot-specific realtime/push delivery are outside the Vercel web runtime; in-app notification records and push-subscription data paths remain available, but external push delivery would require a separate provider if needed.
