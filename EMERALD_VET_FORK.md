# Emerald Vet Documenso Fork

This is a customized fork of [Documenso](https://github.com/documenso/documenso) for self-hosted deployment at Emerald Vet.

## Modifications

### 1. CSS Injection Unlocked (commit `8b128d5`)

**File:** `apps/remix/app/components/embed/embed-document-signing-page-v1.tsx`

Removed the `allowWhitelabelling` check that gated CSS injection behind a paid subscription. On self-hosted instances, CSS customization via the `css` and `cssVars` props now works unconditionally.

```diff
- if (allowWhitelabelling) {
-   injectCss({
-     css: data.css,
-     cssVars: data.cssVars,
-   });
- }
+ // Always allow CSS injection (self-hosted)
+ injectCss({
+   css: data.css,
+   cssVars: data.cssVars,
+ });
```

### 2. Forced AllowWhitelabelling for Embed Routes (commit `7a50f3c`)

**File:** `apps/remix/app/routes/embed+/_v0+/sign.$token.tsx`

Hardcoded `allowWhitelabelling={true}` in both V1 and V2 embed signing route components, bypassing the subscription-based `organisationClaim.flags.embedSigningWhiteLabel` check.

### 3. Pre-populated Signature Support (commit `1a54823`)

**Files:**
- `apps/remix/app/types/embed-document-sign-schema.ts`
- `apps/remix/app/components/embed/embed-document-signing-page-v1.tsx`

Added a `signature` field to the embed data schema, allowing a pre-populated signature to be passed in the embed URL hash. The signature can be either:
- A base64 data URL (e.g., `data:image/png;base64,...`) for an image signature
- Plain text for a typed signature

**Usage in embed hash:**
```javascript
const embedData = {
  css: '.embed--DocumentContainer { ... }',
  name: 'Dr. Jane Smith',
  signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'
};
const hash = btoa(encodeURIComponent(JSON.stringify(embedData)));
const iframeSrc = `https://your-documenso-instance/embed/sign/${token}#${hash}`;
```

### 4. MinIO Port Change

**File:** `docker/development/compose.yml`

Changed MinIO API port from `9002` to `9003` to avoid conflict with BullCheck dev server.

## Deployment

### Local Development

```bash
# Start dependencies (PostgreSQL, MinIO, mail server)
npm run dx:up

# Compile translations
npm run translate:compile

# Start dev server
npm run with:env -- npm run dev -w @documenso/remix
```

### Production (Dokploy)

Build and deploy using the Dockerfile in `docker/Dockerfile`. Required environment variables:

```env
NEXTAUTH_SECRET=<generate-with-openssl-rand-hex-32>
NEXT_PUBLIC_WEBAPP_URL=https://documenso.yourdomain.com
NEXT_PRIVATE_DATABASE_URL=postgresql://user:pass@host:5432/documenso
NEXT_PRIVATE_DIRECT_DATABASE_URL=postgresql://user:pass@host:5432/documenso
NEXT_PRIVATE_ENCRYPTION_KEY=<generate-with-openssl-rand-hex-32>
NEXT_PRIVATE_SMTP_HOST=smtp.example.com
NEXT_PRIVATE_SMTP_USER=your-smtp-user
NEXT_PRIVATE_SMTP_PASSWORD=your-smtp-password
NEXT_PRIVATE_SMTP_FROM_NAME="Your Organization"
NEXT_PRIVATE_SMTP_FROM_ADDRESS=noreply@yourdomain.com
```

## Upstream

Based on Documenso v2.6.1. To merge upstream changes:

```bash
git remote add upstream https://github.com/documenso/documenso.git
git fetch upstream
git merge upstream/main
```

## License

AGPL v3 (same as upstream Documenso)
