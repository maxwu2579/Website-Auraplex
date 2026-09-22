# AURA-INT-001 Runtime and Deployment Notes

## Verified locally versus production

Local automated tests cover upload validation, complete stream replay after MIME inspection, server-side group checks, stable error responses, status mapping, deletion order and partial failure, and Node/S3 adapter behavior. The production build must pass before review. **Real Keycloak, MinIO, Qdrant, Cloudflare/APISIX, Nomad and ingest behavior have not been verified.** Do not infer production readiness from mocks.

The 2026-09-22 `npm audit --omit=dev --audit-level=high` check reports 44 dependency advisories (including Next and transitive `tar` critical advisories). This review round does not change the lockfile or attempt potentially breaking framework upgrades. Triage and remediate the dependency report before a production security sign-off.

## Routes and security boundaries

- `/admin/upload` is server-gated before the product catalogue or upload workspace renders.
- `proxy.ts` matches `/admin/:path*` and `/api/admin/:path*` as a first line. The earlier matcher excluded admin paths, so the reported guard could be bypassed.
- `GET /api/admin/csrf`, `PUT /api/admin/uploads`, `GET /api/admin/uploads` and `DELETE /api/admin/uploads` each independently authenticate the session and authorize Keycloak ID-token `groups`. Admin-only delete separately requires the Admin group. Realm/client roles do not grant access.
- Group names are exact, case-insensitive matches to `KEYCLOAK_UPLOADER_ROLE` and `KEYCLOAK_ADMIN_ROLE`, defaulting to `Uploader` and `Admin`. Configure Keycloak to place groups in the ID token; confirm the exact production group strings.
- Logout uses OIDC discovery's `end_session_endpoint` with a server-held `id_token_hint`, clears the Auth.js session, then redirects through Keycloak back to the configured `AUTH_URL` origin. Verify post-logout URI registration in the real client.
- Auth.js session/CSRF cookies use `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production. The production session and CSRF cookies use `__Host-`; transient OIDC cookies use `__Secure-`. Local HTTP development uses unprefixed names and `Secure=false`. The ID token is stored only in the encrypted, HttpOnly Auth.js JWT, not exposed to client JavaScript. The separate admin double-submit CSRF cookie is `HttpOnly`, `SameSite=Strict`, production `Secure`, and scoped to `/api/admin`.

## Runtime configuration

Inject `AUTH_SECRET`, `AUTH_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_REGION`, `QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COLLECTION` at server runtime via the approved Nomad/Vault mechanism. `QDRANT_API_KEY` is optional only when the actual Qdrant service permits no-key access. Never commit real credentials. `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` is a build-time value; leave unset for the **100 MB** default. Rebuild to change it. A possible **300 MB** target needs Node/proxy/time-out and resource verification first; Cloudflare/APISIX support has not been confirmed.

Next.js 16 with this repository's Cache Components configuration rejects an explicit route-segment `runtime = 'nodejs'` export. Route Handlers use Next's Node default; each admin handler calls `assertAdminNodeRuntime()` and fails closed if launched under Edge. The Nomad standalone deployment runs `node server.js`. Confirm the actual allocated runtime and upload path in staging before production.

## Storage, status and deletion

Accepted formats are PDF, DOCX, PNG, JPG/JPEG and MP4. PDF and DOCX use `auraplex-raw-pdf`, PNG and JPG/JPEG use `auraplex-raw-image`, and MP4 uses `auraplex-raw-video`; confirm whether a separate document bucket is desired. Non-PDF files are stored but not ingested here and stay **pending** with **Ingestion support coming**. PDF stays **pending** until matching `source_key` evidence is observed in Qdrant. Missing evidence is not failed; explicit failure is failed. Unsupported is reserved for genuinely unsupported types.

The upload path is `request stream -> byte limit -> MIME inspection -> replay of inspected bytes -> Node Readable -> single-part S3 PutObject`. It does not collect the whole file in app memory. Request cancellation is passed into the stream and the AWS SDK `abortSignal`; this implementation does not create an application-managed multipart upload. S3 uses `forcePathStyle: true`. Object keys use decoded, sanitized and validated filenames, never raw request header names. All MinIO metadata keys are lowercase with dashes and shared between writers/readers.

Admin delete validates bucket/key, deletes Qdrant points by exact `source_key` with `wait: true`, then deletes the MinIO object. This order favors preventing stale FAQ results. A failure in either system is a controlled API error, never a success; after Qdrant succeeds but MinIO fails, the response is `PARTIAL_DELETE` and the object can remain. An outage/timeout after an external operation can also make the final state uncertain. Investigate before retrying. No additional ingest-job cleanup is assumed. The MinIO service account requires scoped `DeleteObject` permission for these buckets.

Object keys remain deterministic: `<product-line>/<product-slug>/<safe-filename>`. Reusing the same name replaces an object; replacement/versioning is a separate business decision. The per-process rate limiter is not global across multiple allocations. Confirm proxy request-size/timeouts, trusted forwarded headers, real bucket policy, Keycloak redirect/logout, Qdrant payload schema and exact production secret path before deployment.
