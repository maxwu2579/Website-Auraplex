# Auraplex Admin Upload — User Guide

## Upload a file

1. Open `/admin/upload` and sign in with your company account.
2. Select the product line.
3. Select the product.
4. Drag files into the upload area, or choose **Browse files**.
5. Check the file list, then choose **Upload**.

Accepted upload types are PDF, DOCX, PNG, JPG/JPEG, WebP, MP4, WebM and MOV. Each file must be 500 MB or smaller. A file whose content does not match its extension will be rejected.

PDF is currently ready for ingestion checking. Other accepted formats can be stored, but may not be indexed yet.

## Understand the status

- **Queued** — stored safely; ingestion for this format is not enabled yet.
- **Pending** — stored and waiting for evidence from the ingestion service.
- **Processed** — the matching source key was found in Qdrant.
- **Failed** — a confirmed failure was reported.

If an upload fails, read the message, correct the issue and choose **Retry**. The page never reports a file as uploaded until storage accepts it.

Uploaders see only their own recent uploads. Admins see all recent uploads. Choose the sign-out icon in the top-right corner when finished.

Important: uploading the same filename again for the same product currently replaces the stored object at that key. Do not use the same filename for a different revision unless replacement is intended.
