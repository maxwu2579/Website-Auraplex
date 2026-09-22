# Auraplex Admin Upload — User Guide

Open `/admin/upload` and sign in with the company Keycloak account. Select a product line and product, then drop files or choose **Browse files**. Review the queue and choose **Upload**. Each file is limited to **100 MB**. Accepted formats are **PDF, DOCX, PNG, JPG/JPEG and MP4**; the file contents must match the extension and declared media type.

An upload is successful only after MinIO accepts the complete file. PDF files are stored and may later be marked **processed** when matching Qdrant evidence is found. DOCX, PNG, JPG/JPEG and MP4 files are stored now but are **pending** with **Ingestion support coming**; they are not indexed by this feature. A missing processing signal is not a failure. **Failed** means a confirmed failure, while **unsupported** means the type is not accepted. Failed uploads can be retried. **Cancel current upload** aborts the browser request and propagates cancellation to the single-part storage request.

Uploaders see only their own recent uploads. Admins can see all recent uploads and can use **Delete** to remove matching Qdrant records and the MinIO object. If deletion reports an error, do not assume both systems were cleaned up; contact an administrator before retrying or relying on FAQ results. Sign out with the top-right button to leave both the app and the Keycloak SSO session.

Uploading the same sanitized filename for the same product currently replaces the object at that key. Production deployment and ingestion behavior still require end-to-end verification.
