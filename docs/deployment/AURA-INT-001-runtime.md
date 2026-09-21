# AURA-INT-001 Runtime and Deployment Notes

## Verification boundary

### Mock/local verified

- Raw request bodies stream through size counting and a 4,100-byte `file-type` v19 inspection window.
- The inspected bytes are replayed; the complete file is not collected in application memory.
- Request validation, object-key construction, uploader ownership, role filtering, CSRF validation, rate limits, audit field allowlisting and status mapping have automated coverage.
- The S3 adapter uses `PutObject`, paginated `ListObjectsV2` and `HeadObject` commands.
- Qdrant lookup uses the relative object key as `source_key` evidence.
- Missing runtime configuration fails explicitly; the UI does not fake success or processed status.

### Production not verified

- Real Keycloak login, token claims, groups, realm roles and client roles.
- Real MinIO buckets, service account, network route, TLS and policy attachment.
- Real Qdrant collection name, payload schema and ingest timing.
- Cloudflare/APISIX forwarding and trusted proxy-header sanitation.
- Nomad/Vault variable path, allocation identity and secret rotation.
- End-to-end ingestion for PDF and future DOCX/image/video pipelines.

## Routes and components

- `/admin/upload` — upload and recent-status UI.
- `GET /api/admin/csrf` — authenticated CSRF token and API-scoped HttpOnly cookie.
- `PUT /api/admin/uploads` — one raw file body plus metadata headers.
- `GET /api/admin/uploads` — up to 50 newest visible objects across the three buckets.
- `/api/auth/[...nextauth]` — Auth.js Keycloak handlers.

The upload path is `request body -> byte counter -> MIME inspection/replay -> Node readable -> S3 PutObject`. It never converts the complete request into an in-memory file or collects all chunks.

## Required runtime variables

Inject the following server-only values at allocation runtime. Do not bake them into the image, commit them, or place real values in this document.

```text
AUTH_SECRET
KEYCLOAK_ISSUER
KEYCLOAK_CLIENT_ID
KEYCLOAK_CLIENT_SECRET
KEYCLOAK_UPLOADER_ROLE
KEYCLOAK_ADMIN_ROLE
MINIO_ENDPOINT
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
MINIO_REGION
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION
```

`QDRANT_API_KEY` is optional only when the confirmed production Qdrant deployment does not require one. `MINIO_REGION` defaults to `us-east-1` in code if omitted, but operations should confirm the production value. Role names default to `Uploader` and `Admin`; production claim names still require confirmation.

The repository job file already states that secrets use the existing `templates + nomadVar` convention. The exact production Nomad Variable or Vault path is unknown, so this change deliberately does not add a fabricated path. Operations must add the variables above to the confirmed secret path and render them into the task environment before deployment.

## MinIO policy

Use `minio-admin-upload-policy.json` as the least-privilege draft. It permits listing the three upload buckets and reading/writing objects for status metadata and uploads. It intentionally grants no delete or global administration action. Confirm bucket names and MinIO policy compatibility before attachment.

## Security behaviour

- Unauthenticated requests return 401; authenticated users without an upload role return 403.
- Group and realm roles are supported. Client roles are read only from `resource_access[KEYCLOAK_CLIENT_ID]`, not from unrelated clients.
- `uploaded-by` stores the percent-encoded authenticated user ID in object metadata; no token or session is stored.
- Uploaders see exact ownership matches only. Legacy objects without `uploaded-by` are hidden from Uploaders and visible to Admins.
- The CSRF token is returned in the authenticated response body while its matching cookie is HttpOnly, `SameSite=Strict`, production `Secure`, one-hour lifetime and scoped to `/api/admin`.
- Audit events contain only user, action, key, size, IP and timestamp. Proxy IPs are syntactically validated, but the edge proxy must remove untrusted incoming forwarding headers.
- Rate limiting is currently per-process memory. A multi-allocation production deployment requires a shared limiter if a global boundary is required.

## Media and object behaviour

The declared MIME type, filename extension and detected content type must agree. DOCX is ZIP-based: if `file-type` cannot positively identify it inside the 4,100-byte inspection window, the upload is rejected rather than accepted on declaration alone. This is intentionally conservative.

The task locks `file-type` to v19.6.0. The current npm advisory report flags that major line for malformed ASF input; ASF is not supported by this feature and its fixed header is rejected before invoking the parser. Moving to a patched later major version should be reviewed separately from this locked task.

Object keys are deterministic: `<product-line>/<product-slug>/<safe-filename>`. Uploading the same sanitized filename to the same product writes the same key and therefore replaces the object under normal S3/MinIO semantics. This remains pending business confirmation; no version suffix was invented.

Delete is intentionally absent. Removing only the MinIO object could leave stale Qdrant data, so delete must wait for confirmed authorization, retention and Qdrant cleanup semantics.

## Deployment checklist

1. Confirm Keycloak claim format, client ID and exact Uploader/Admin role names.
2. Create/confirm the three MinIO buckets and attach the reviewed least-privilege policy to a dedicated service account.
3. Confirm Qdrant collection and `source_key` payload contract.
4. Add runtime values to the confirmed Nomad/Vault path and render them into the `next` task environment.
5. Build the image with required `NEXT_PUBLIC_*` values, deploy to a non-production environment, and test login, CSRF, one PDF upload, ownership filtering and Qdrant status.
6. Confirm Cloudflare/APISIX request-size limits, timeouts and trusted forwarding-header behaviour for a 500 MB request.
7. Review logs for the allowlisted audit event without credentials or tokens.

## Friendy decisions still required

1. Are production permissions delivered as Keycloak groups, realm roles, roles under the website client, or a combination?
2. What exact role/group names should map to Uploader and Admin?
3. Should a same-product/same-filename upload replace the current object, be rejected, or create a versioned key?
4. What must Admin delete remove from MinIO, Qdrant and any ingest job records, and what retention/audit rule applies?
5. What are the confirmed Nomad/Vault variable path, Qdrant collection and proxy header trust rules?
