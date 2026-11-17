# Emerald Vet Documenso Fork

Customized fork of [Documenso](https://github.com/documenso/documenso) for Emerald Vet / Bullcheck self-hosted deployment.

**Status:** Local v2.22.0 upgrade candidate (pinned fork `main` `4c0fb140be471141b0a61525ed6752f5af053c25` + upstream `v2.22.0` `d32d049165db230820465b4f566061ba8fa27012`). **Not deployed to production.**

## Retained Patch Inventory

1. **V1/V2 Name + Initials Bulk-Fill & Manual Signature Consent**
   - Preserves V1/V2 Name + Initials bulk-fill controls and mounts.
   - Requires explicit manual signature interaction/consent to submit a signature; prefill never auto-submits.
2. **Signature Hash Image Prefill (Bounded PNG/JPEG Only)**
   - `packages/lib/types/embed-document-sign-schema.ts` and V1/V2 embed signing components accept an optional `signature` image prefill in the URL hash as a signing-input convenience separate from signing consent.
   - **Strict parser:** Only bounded PNG or JPEG data URLs (`data:image/png;base64,...` or `data:image/jpeg;base64,...`) are permitted. Plaintext hash signatures are rejected.
   ```javascript
   const embedData = {
     css: '.embed--DocumentContainer { ... }',
     name: 'Dr. Jane Smith',
     signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'
   };
   const hash = btoa(encodeURIComponent(JSON.stringify(embedData)));
   const iframeSrc = `https://your-documenso-instance/embed/sign/${token}#${hash}`;
   ```
3. **Embed CSS Injection & Whitelabeling Bypass (Baseline)**
   - Unconditionally enables CSS injection (`css` / `cssVars`) and `allowWhitelabelling={true}` on V1/V2 embed signing routes (`apps/remix/app/components/embed/embed-document-signing-page-v1.tsx`, `apps/remix/app/routes/embed+/_v0+/sign.$token.tsx`) for self-hosted use.
   - Replacing these bypasses with native organisation claims is deferred (see below).
4. **Strict Legacy Image Sealing & Placeholder Indexing**
   - Enforces strict PNG/JPEG validation and image-budget sealing for V1/legacy PDF signing (`3a32df790`).
   - Preserves single-pass placeholder indexing across signing fields.
5. **Webhook Retry Backoff**
   - Retains local webhook retry backoff and associated regression tests (`075d8888a`).
6. **Fail-Closed Migrations, Startup & Router**
   - Startup, database migration checks, and routing fail closed rather than serving with incomplete state.
7. **Cloud Run Sender, Command/Args Reset & Test Safeguards**
   - Preserves plain-address sender secret handling (`de59e72d7`), Cloud Run container command/args reset, and workflow/startup test safeguards.
8. **Hosted CI Sharding**
   - Pins Playwright/E2E jobs to hosted Ubuntu 24.04 runners, starts only required E2E services, and reconciles upstream E2E sharding (`7f92fa824`, `37fc7e1ef`, `82e43dd5c`).
9. **MinIO Port Override (Removed in v2.22.0)**
   - Upstream v2.22.0 removed MinIO from `docker/development/compose.yml`; the fork's `9002` → `9003` port override is no longer needed and was removed.

## Runtime & Migration Target (v2.22.0)

- **Runtime:** Node.js minimum raised `22` → `24`; React `18` → `19`. Validate with Node 24 and clean lockfile-installed dependencies.
- **Pending Prisma Migrations (6):**
  1. API token `lastUsedAt` timestamp
  2. Auth handoff / session flag
  3. Envelope content tables & claim limits
  4. Persisted embed signatures
  5. Lowercase `User.email` (retains mixed-case duplicate rows to avoid unique-key collisions)
  6. Lowercase `Recipient.email` (mutates existing recipient rows)

## Deferred Candidates (Separate Scope)

- **Organisation-Claim Cleanup:** Replace embed CSS/whitelabeling bypasses with native organisation claims only after readback proves the signing organisation carries the required claim flag and any needed config change is approved.
- **Mobile WIP Reconciliation:** Compare dirty mobile-signing/phone-layout work against upstream v2.22.0 after baseline validation, and port only missing completion/phone-layout fixes.

## Local Development & Operational Reference

### Local Development

```bash
# Start dependencies (PostgreSQL, mail server, Redis, Gotenberg)
npm run dx:up

# Compile translations
npm run translate:compile

# Start dev server
npm run with:env -- npm run dev -w @documenso/remix
```

### Production Infrastructure (Google Cloud Run)

- **Cloud Run:** `australia-southeast1`, service name `documenso`
- **Cloud SQL:** PostgreSQL 15 instance `documenso-db` (`db-g1-small`)
- **Storage:** GCS bucket `bullreporter-yako-documenso` via S3-compatible interop (HMAC keys)
- **Secrets:** Stored in Google Secret Manager (prefix `DOCUMENSO_`)
- **Email:** Resend API (`NEXT_PRIVATE_SMTP_TRANSPORT=resend`)
  - `DOCUMENSO_EMAIL_FROM_ADDRESS`: plain mailbox address only (e.g. `mailbox@example.com`); `NEXT_PRIVATE_SMTP_FROM_NAME` supplies the display name separately. Do not reuse Bullcheck's shared `EMAIL_FROM` secret (`Name <mailbox@example.com>`).
  - `RESEND_API_KEY`: send-only Resend credential.
- **Signing:** Self-signed `.p12` certificate for PDF document signing
- **Registry:** Artifact Registry `documenso` in `australia-southeast1`
- **CI/CD Workflow:** `.github/workflows/deploy-cloud-run.yml` (builds `docker/Dockerfile`, pushes to Artifact Registry, deploys to Cloud Run with Cloud SQL sidecar and Secret Manager integration using `GCP_SA_KEY` for `documenso-github-deploy@bullreporter-yako.iam.gserviceaccount.com`).

## Upstream Upgrade & Release Caution

- **Use pinned stable releases, not `upstream/main`:** Fetch upstream tags/commits and merge a pinned stable release (e.g., `v2.22.0` / `d32d049165db230820465b4f566061ba8fa27012`) onto an isolated upgrade branch for review. Do not run `git merge upstream/main` directly into `main`.
- **Auto-deploy on `main`:** `main` is unprotected and `.github/workflows/deploy-cloud-run.yml` auto-deploys on push to `main`.
- **No unapproved production dispatch:** Do not trigger production `workflow_dispatch` from feature branches or without explicit release approval.

## Release Gate Checklist

- [ ] Local tests, typecheck, lint, and Docker/app build passing on Node 24
- [ ] Independent `SPEC → QUALITY` review completed on exact candidate SHA
- [ ] Database backup/restore verified and all 6 Prisma migrations rehearsed on an isolated restored database
- [ ] Remote CI green (including E2E sharding and security/dependency scan)
- [ ] Physical phone QA (320/375/390px, keyboard, pinch zoom) and V1/V2 signing smoke fixtures verified
- [ ] Documentation/publication reconciled and explicit production promotion approval granted

## License

AGPL v3 (same as upstream Documenso)
