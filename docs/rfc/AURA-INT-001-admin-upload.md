# AURA INT 001 Knowledge Base Admin Upload

## Status

Proposed

- Owner: Max
- Reviewer: Friendy Tan
- Priority: P2
- Target repository: `friendy21/Website-Auraplex`
- Implementation must not begin until this RFC is approved.

## Summary

Add an authenticated administration page to the existing Website Auraplex Next.js application so authorised non-technical users can upload knowledge-base source files without command-line access or MinIO credentials.

The proposed first release provides an upload interface, mandatory product metadata, server-side streaming to MinIO, role-based access through Keycloak, and a recent-uploads status view backed by MinIO and Qdrant. It does not change the downstream ingest, chunking, embedding, or Qdrant indexing services.

The highest-risk part of the implementation is the end-to-end 500 MB streaming path through Cloudflare Tunnel, Apache APISIX, Next.js, and MinIO. This path must be verified before the UI is considered complete.

## Repository Findings

The following facts were verified against `main` at commit `b259c90572f7afb42358e63bc8e19159d535d2b5`:

- The application uses Next.js 16.2.7, React 19, TypeScript, the App Router, and Tailwind CSS v4.
- Public pages live under `app/[locale]` and support `en`, `ms`, and `zh`.
- The root `proxy.ts` currently applies only `next-intl` routing. It does not perform authentication or authorisation.
- Existing API routes are limited to Open Graph image generation and the Sanity revalidation webhook.
- The repository does not currently contain Auth.js, Keycloak, MinIO/S3, Qdrant, MIME-sniffing, drag-and-drop, or automated-test dependencies.
- The production image is a Next.js standalone Node.js image built from the root `Dockerfile`.
- The website runs as one Nomad allocation with host networking, 1 CPU, and 1 GB memory.
- The actual Nomad specification is `deploy/website.nomad.hcl`. The task brief refers to `nomad-jobs/website.nomad.hcl`, which does not exist in this repository.
- The website is fronted by Apache APISIX and Cloudflare Tunnel.
- The committed product catalogue exposes a stable product `id`, `slug`, and category. The admin UI can use this catalogue instead of accepting an arbitrary product slug.
- The repository currently uses `package-lock.json` and npm in the Docker build, despite the README quickstart mentioning pnpm.
- No `docs` directory, RFC template, pull-request template, or automated test suite currently exists.

## Problem

The current knowledge-base ingestion workflow requires command-line tooling and MinIO credentials. The intended uploader is non-technical and should not need access to either. As a result, raw knowledge-base buckets can remain empty even though the downstream ingest pipeline is available.

The website needs a restricted browser workflow in which an authorised user signs in, selects one or more files, supplies product metadata, starts the upload, and can later see whether each file is queued, pending, processed, failed, or in an unknown state.

## Goals

- Provide an authenticated administration page at `/admin/upload` in the existing website application.
- Use Keycloak SSO and existing Keycloak groups instead of a custom user database.
- Support drag-and-drop and file selection for the task-approved file types.
- Require `product_line` and `product_id` before upload.
- Derive the canonical product slug on the server from the committed product catalogue.
- Stream each file through a Next.js Route Handler into MinIO without buffering the complete file in Node.js memory.
- Enforce the 500 MB per-file limit using both declared length and bytes observed during streaming.
- Store sufficient object metadata to support audit and uploader-specific views.
- Display recent upload and ingestion status using MinIO and Qdrant.
- Enforce Uploader and Admin permissions.
- Add unit and integration coverage for the upload contract, access control, object keys, validation, and status derivation.
- Document deployment, rollback, MinIO policy, and the non-technical user workflow.

## Non Goals

- Changing the downstream ingest, chunking, embedding, or Qdrant indexing pipeline.
- Deploying Whisper or implementing audio or video transcription.
- Adding new ingest capabilities for file types the current ingest service does not support.
- Scraping `auraplex.info`.
- Changing the public `/chat`, `/recommend`, or Machine Finder guardrails.
- Building a custom user table or password login.
- Creating a new Nomad job for the admin UI.
- Exposing MinIO or Qdrant credentials to the browser.

## Proposed User Flow

1. The user opens `https://admin.auraplex.info/admin/upload`.
2. An anonymous user is redirected to Keycloak.
3. After successful SSO, the application checks the Keycloak group claim.
4. An authorised user selects a product line and product from the committed Auraplex catalogue.
5. The user drops one or more files into the upload area.
6. The browser displays filename, detected client-side type, size, and whether the file is expected to be indexable.
7. The browser uploads each file as an independent request so progress and retry are isolated per file.
8. The server validates the session, role, CSRF token, product mapping, filename, size, and detected MIME type.
9. The server streams the file to the appropriate MinIO bucket with the approved key and metadata.
10. The UI shows the upload result and refreshes the recent-uploads panel.
11. Supported ingest files progress from `pending` to `processed` or `failed` when a reliable downstream signal exists.
12. Stored but currently unsupported ingest types remain `queued` and must never be presented as indexed.

## Routing and Page Placement

The admin UI should live outside the locale-prefixed public site:

```text
app/admin/layout.tsx
app/admin/upload/page.tsx
app/api/admin/uploads/route.ts
app/api/admin/uploads/status/route.ts
app/api/auth/[...nextauth]/route.ts
```

Reasons:

- The admin workflow is operational rather than public marketing content.
- The requested host is `admin.auraplex.info`, so public-site locale redirects would add unnecessary complexity.
- The admin UI should not render the public header, footer, animations, FAQ chat, or catalogue marketing shell.
- API paths remain stable and independent of locale.

`proxy.ts` will need to compose two responsibilities:

- Protect `/admin/:path*` and `/api/admin/:path*` with an authenticated session.
- Preserve the current `next-intl` behaviour for public routes.

Auth callback endpoints under `/api/auth/:path*` must remain reachable without an existing session.

## Authentication and Authorisation

Use Auth.js v5 with the Keycloak provider. Do not create a custom user table.

The Keycloak token must provide a group or role claim that can be mapped to the following application roles:

| Application role | Keycloak group | Permissions |
| --- | --- | --- |
| Uploader | `auraplex-uploader` | Upload files and view uploads created by the same user |
| Admin | `auraplex-admin` | Upload files, view all uploads, and delete files if deletion is confirmed in scope |

Authorisation must be repeated inside every admin Route Handler. Proxy-level protection is a first boundary, not the only security check.

Session requirements:

- Secure, HttpOnly, SameSite=Lax cookies in production.
- `__Host-` cookie prefix where supported by the final Auth.js cookie configuration.
- No cookie Domain attribute when using the `__Host-` prefix.
- Idle timeout of 30 minutes and absolute session lifetime of 12 hours.
- Explicit logout.
- CSRF validation for state-changing admin requests.
- Anonymous requests receive a redirect for pages and a `401` JSON response for APIs.
- Authenticated users without an allowed group receive `403`.

The exact Keycloak realm, issuer URL, client ID, callback URL, and group-claim path must be confirmed before implementation. Secrets are runtime-only values and must not be committed or baked into the Docker image.

## Upload API Contract

### Request

Each file is uploaded independently using a raw request body rather than a multipart form parser that may buffer the complete file.

Proposed endpoint:

```text
PUT /api/admin/uploads
```

Required request headers:

```text
Content-Type: <declared MIME type>
Content-Length: <bytes when available>
X-Upload-Filename: <UTF-8 filename encoded by the client>
X-Product-Line: <approved product line>
X-Product-ID: <catalogue product id>
X-CSRF-Token: <session-bound token>
```

The server must not trust these values by themselves. It must:

- Resolve `product_id` against the server-side committed catalogue.
- Confirm that the selected product belongs to the supplied product line.
- Derive the canonical product slug from the catalogue.
- Sanitize the original filename and reject path separators and control characters.
- Reject a declared size above 500 MB before reading the body.
- Count bytes while streaming and abort when the observed size exceeds 500 MB.
- Read only the minimum prefix required for MIME sniffing, then continue the same stream without buffering the remaining body.
- Reject a mismatch between an unapproved declared type, detected type, and extension.
- Abort the MinIO operation when the client disconnects or validation fails.

### Response

Success response:

```json
{
  "ok": true,
  "uploadId": "generated-id",
  "sourceKey": "auraplex-raw-pdf/labelling/example-product/generated-id-document.pdf",
  "status": "pending"
}
```

Errors use a stable JSON shape:

```json
{
  "ok": false,
  "code": "FILE_TOO_LARGE",
  "error": "File exceeds the 500 MB limit"
}
```

The response must never include MinIO credentials, Qdrant credentials, stack traces, or raw upstream error bodies.

## File Types and Ingestion Capability

The browser upload feature and the downstream ingest service have different capability boundaries.

| File type | Storage target proposed by task brief | Ingestion state for first release |
| --- | --- | --- |
| PDF | `auraplex-raw-pdf` | Indexable, subject to verification of the existing ingest contract |
| DOCX | Task brief currently maps it to `auraplex-raw-pdf` | Stored only until Friendy confirms a valid ingest contract |
| PNG, JPEG, WebP | `auraplex-raw-image` | Stored and shown as queued unless current ingest support is confirmed |
| MP4, WebM, QuickTime | `auraplex-raw-video` | Stored and shown as queued; transcription is out of scope |

The UI must not label a stored file as processed merely because the upload succeeded. Unsupported ingest types display `queued, ingestion support pending`.

DOCX routing is an open issue: placing a `.docx` object in a bucket and path described as PDF may violate the existing ingest parser. Implementation must wait for confirmation of the correct bucket and status behaviour.

## MinIO Object Key and Metadata

The task brief requires the following shape:

```text
<bucket>/<product_line>/<product-slug>/<filename>
```

The server, not the browser, constructs every key component.

Proposed collision-safe filename:

```text
<upload-id>-<sanitized-original-filename>
```

Proposed object metadata:

| Metadata key | Purpose |
| --- | --- |
| `product_line` | Validated product grouping |
| `product_id` | Stable catalogue identifier supplied by the UI and revalidated by the server |
| `product_slug` | Canonical slug resolved by the server |
| `uploaded_by` | Stable Keycloak subject identifier |
| `uploaded_by_email` | Optional human-readable audit value if present in the token |
| `uploaded_at` | Server-generated UTC timestamp |
| `original_filename` | Original user-facing filename after safe encoding |
| `detected_mime` | Server-detected MIME type |
| `ingestion_capability` | `supported` or `deferred` |
| `upload_id` | Generated identifier used for UI correlation and logs |

The Uploader view requires `uploaded_by`. MinIO object listings do not return all custom metadata, so the status endpoint will list a bounded recent set and issue `HeadObject` requests before applying uploader filtering. The initial result set should be paginated and capped to prevent an unbounded bucket scan.

## Status Model

| Status | Required evidence |
| --- | --- |
| `queued` | Upload succeeded, but the detected file type is not currently supported by ingest |
| `pending` | Upload succeeded and is ingest-compatible, but no completion or explicit failure signal exists |
| `processed` | Qdrant contains a record whose `source_key` exactly matches the MinIO source key, or another confirmed completion marker exists |
| `failed` | A confirmed ingest failure marker, error record, or task state exists for the exact source key |
| `unknown` | MinIO or Qdrant is unavailable, the data is inconsistent, or the system cannot safely infer a state |

Absence from Qdrant is not sufficient evidence of failure. A file can remain pending while the ingest worker is delayed or stopped. If the current ingest pipeline does not publish a failure signal, the first release must use `unknown` or a time-qualified `pending` label rather than inventing a failure result.

## Deletion

The task brief grants Admin users permission to delete files, but deletion is not separately listed as an explicit UI deliverable. It also proposes a MinIO uploader policy without `DeleteObject`, which would make deletion impossible when the website uses that credential.

Deletion therefore remains blocked pending a reviewer decision. If it is included:

- Only Admin users may call the delete endpoint.
- The action requires CSRF validation and a confirmation step.
- The MinIO credential design must explicitly allow the required delete operation.
- Deletion must be audited.
- The expected behaviour for already-indexed Qdrant records must be defined. This RFC does not assume that deleting the raw object removes indexed chunks.

## Security Controls

- Store MinIO, Qdrant, Keycloak, and Auth.js secrets in the approved Nomad/Vault runtime path.
- Never expose server credentials through `NEXT_PUBLIC_*` variables.
- Use a least-privilege MinIO policy limited to the approved buckets and actions.
- Validate authentication and role inside every Route Handler.
- Apply CSRF validation to upload and delete operations.
- Validate product identifiers against the server-side catalogue.
- Sanitize every object-key component and reject traversal attempts.
- MIME-sniff the first required bytes instead of trusting browser headers or extensions.
- Enforce the size limit before and during streaming.
- Apply per-user limits of 20 uploads per minute, 200 per hour, and 5 GB per hour, subject to reviewer confirmation.
- Emit structured JSON audit events containing user ID, action, source key, size, validated client IP, result, and UTC timestamp.
- Trust forwarding headers only from the known Cloudflare/APISIX path; do not accept arbitrary client-supplied IP headers.
- Add a gitleaks workflow before new secrets or policy files are introduced.
- Return generic external errors and log actionable internal details without secrets.

The current Nomad job runs one allocation, so an in-memory rate limiter has consistent behaviour within that allocation. Counters reset on restart and will become inconsistent if the group count increases. Moving to multiple replicas requires a shared limiter store.

## Infrastructure and Configuration

The feature remains inside the existing `website` Nomad job. No new job is proposed.

Proposed server-only environment variables:

```text
AUTH_SECRET
AUTH_KEYCLOAK_ID
AUTH_KEYCLOAK_SECRET
AUTH_KEYCLOAK_ISSUER
AUTH_TRUST_HOST
MINIO_ENDPOINT
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
MINIO_REGION
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION
```

These values are injected at runtime. They must not be added as Docker build arguments.

The deployment change will update `deploy/website.nomad.hcl`, not the nonexistent path stated in the original brief. Operations work outside this repository may also be required for:

- `admin.auraplex.info` DNS and Cloudflare Tunnel routing.
- Apache APISIX host routing and request timeout/body-size settings.
- Keycloak realm client, callback URLs, and group claims.
- Vault/Nomad variables.
- MinIO user and bucket policy.

Before implementation is accepted, a 500 MB request must be proven to pass through every layer. An application-level 500 MB limit is not sufficient if Cloudflare, APISIX, or another proxy rejects the request earlier.

## Dependencies

The implementation is expected to add the following task-approved libraries:

```text
next-auth v5
@aws-sdk/client-s3 v3
@qdrant/js-client-rest
file-type v19
react-dropzone v14
```

The repository has no automated test framework. The code PR should introduce the smallest maintainable setup that supports TypeScript unit and Route Handler integration tests. Vitest is proposed because it supports TypeScript, mocks, and fast server-side tests with limited configuration. UI browser testing may be added only if required by the reviewer.

Package installation must use npm because the repository commits `package-lock.json` and the Dockerfile runs `npm ci`.

## Testing Plan

### Unit tests

- Role and Keycloak group mapping.
- Product ID to catalogue slug and product-line validation.
- Filename and object-key sanitisation, including traversal and Unicode cases.
- MIME routing and mismatch rejection.
- Declared-size and streaming byte-limit enforcement.
- Rate-limit counters and volume limits.
- Status derivation for queued, pending, processed, failed, and unknown.
- Error-to-public-response mapping with secret redaction.

### Integration tests

- Anonymous, unauthorised, Uploader, and Admin API behaviour.
- Raw request body streams to an S3-compatible test endpoint without whole-file buffering.
- MinIO object key, object metadata, and content are correct.
- Client disconnect or oversize stream aborts the upstream upload.
- Status endpoint combines MinIO and Qdrant results by exact `source_key`.
- Uploader sees only objects whose `uploaded_by` matches the session subject.
- Admin sees all recent objects.
- Qdrant or MinIO failure returns `unknown` or an explicit service error rather than a false processed/failed result.

### Staging verification

- Upload representative small PDF, image, and video files.
- Upload a supported PDF near 500 MB and confirm bounded Node.js memory usage.
- Reject a file over 500 MB.
- Confirm correct behaviour when `Content-Length` is missing or false.
- Confirm APISIX and Cloudflare timeouts and body limits.
- Confirm audit events are present and contain no credentials.
- Confirm Keycloak login, logout, idle expiry, absolute expiry, and role changes.

## Observability

Every state-changing action produces one structured JSON event on stdout. Proposed fields:

```text
event
request_id
upload_id
user_sub
role
action
source_key
size_bytes
detected_mime
client_ip
result
error_code
duration_ms
timestamp
```

Metrics are not introduced in this task unless an existing platform mechanism is identified. Logs must still make upload throughput, validation rejection, upstream failure, and status-query failure distinguishable.

## Rollout Plan

1. Approve this RFC and resolve blocking open questions.
2. Add dependencies, test framework, and server-side configuration schema.
3. Implement authentication and the minimal PDF upload vertical slice.
4. Verify streaming and object layout against a non-production MinIO environment.
5. Add the full UI, remaining approved storage types, status panel, security controls, and tests.
6. Create the scoped MinIO policy at `docs/minio/policies/auraplex-uploader.json`.
7. Update `deploy/website.nomad.hcl` with runtime variables/templates after the approved Vault pattern is provided.
8. Configure the Keycloak client and external routing with operations.
9. Deploy to a staging or controlled environment and complete the staging verification checklist.
10. Produce `docs/admin-upload.md` for the non-technical user.
11. Submit the code PR for review.

## Rollback Plan

- Revert the website image to the previous known-good tag.
- Remove or disable the `admin.auraplex.info` route in APISIX/Cloudflare.
- Disable the Keycloak client if required.
- Revoke the MinIO uploader credentials.
- Leave previously uploaded objects unchanged unless an explicit cleanup list is reviewed and approved.
- Do not delete indexed Qdrant content as part of application rollback without a separate, verified data-removal procedure.

## Open Questions

The following questions block parts of implementation and require Friendy's decision or environment evidence:

1. Is `product_line` exactly the existing catalogue category (`labelling`, `packaging`, or `automation`), or is there another source of truth?
2. Should `product_id` be the catalogue `id`, with the server deriving `slug`, as proposed?
3. Which file types are currently handled by the deployed ingest service?
4. Should DOCX be stored in `auraplex-raw-pdf`, and what exact key extension does the ingest parser accept?
5. Should images and videos enter raw buckets now even when their downstream ingest capability is deferred?
6. What exact signal identifies an ingest failure for a `source_key`?
7. What processed bucket names and object layouts exist, and are they authoritative when they disagree with Qdrant?
8. What Qdrant collection or collections must be queried, and is `source_key` indexed as an exact-match payload field?
9. Is Admin deletion required in this task? If yes, how should already-indexed Qdrant content be handled?
10. Should the website use one MinIO credential for upload and Admin deletion, or separate least-privilege credentials?
11. What Keycloak issuer, realm, client, callback URLs, group-claim path, and logout behaviour are approved?
12. Is `https://admin.auraplex.info/admin/upload` the intended final URL, or should the host root redirect directly to `/admin/upload`?
13. Who owns the Cloudflare Tunnel, APISIX, Keycloak, Vault, MinIO, and Qdrant configuration changes outside this repository?
14. Do the Cloudflare and APISIX configurations support a 500 MB streaming request and the required timeout?
15. Should the Design Doc and implementation remain separate PRs? This RFC assumes yes because implementation requires prior approval.

## Definition of Done

- This RFC is approved before feature implementation begins.
- Anonymous and unauthorised access is rejected correctly.
- Uploader and Admin permissions match the approved role matrix.
- The browser uploads approved file types with required product metadata.
- The server derives the catalogue slug and creates only approved MinIO keys.
- A supported file up to 500 MB streams through the full production-like ingress path without whole-file buffering or Node.js out-of-memory failure.
- A file over 500 MB is rejected even if the declared size is missing or false.
- MIME type and filename validation are enforced server-side.
- Stored but unsupported ingest types are labelled queued and never represented as indexed.
- Status results are based on defined MinIO/Qdrant evidence and do not invent failures.
- Secrets remain server-side and are injected using the approved Vault/Nomad mechanism.
- Security, audit, rate-limit, unit-test, and integration-test requirements pass.
- `docs/minio/policies/auraplex-uploader.json` is reviewed.
- `deploy/website.nomad.hcl` and deployment instructions are verified.
- `docs/admin-upload.md` is usable by the intended non-technical user.
- The code PR is reviewed and approved by Friendy.
