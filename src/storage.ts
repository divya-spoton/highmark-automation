// src/storage.ts
import { getStorage } from "firebase-admin/storage";

/**
 * Uploads the raw Highmark PDF to Firebase Storage.
 *
 * Design decisions:
 *
 * - Raw PDF goes to Storage, never into a Firestore document directly.
 *   This isn't a style choice — Firestore has a hard 1MB-per-document
 *   limit (a principle you've already established for the AA/FI data
 *   pipeline), and a bureau PDF can easily exceed that. Firestore only
 *   ever holds a reference (the storage path), never the bytes.
 *
 * - Path is namespaced by docId, not by e.g. a timestamp or PAN. Using
 *   the credit_scores doc ID directly means there's no separate lookup
 *   needed to find "which PDF belongs to which Firestore doc" later —
 *   the relationship is the file path itself.
 *
 * - Returns the storage path (not a public URL). Anyone reading this
 *   PDF later — the dashboard, a support tool — should go through
 *   Firebase Admin SDK / signed URLs at read time, not a baked-in public
 *   link. Credit bureau PDFs are sensitive; nothing here should make
 *   them accidentally public.
 *
 * - Throws on failure rather than logging and continuing — an upload
 *   failure here means we have NO durable copy of this customer's
 *   report anywhere. That has to stop the job and surface loudly, not
 *   quietly proceed to parsing a buffer that never got persisted.
 */

export async function uploadHighmarkPdf(docId: string, pdfBuffer: Buffer): Promise<string> {
    const storagePath = `highmark_reports/${docId}/${Date.now()}.pdf`;

    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);

    await file.save(pdfBuffer, {
        contentType: "application/pdf",
        metadata: {
            metadata: {
                docId,
                uploadedAt: new Date().toISOString(),
            },
        },
    });

    console.log(`[storage] Uploaded Highmark PDF for ${docId} → ${storagePath}`);
    return storagePath;
}