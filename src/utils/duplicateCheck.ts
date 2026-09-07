// src/utils/duplicateCheck.ts
import { getFirestore } from "firebase-admin/firestore";

export interface ExistingIdentifierCheck {
    docId: string;
    status: string;
}

/**
 * Finds any credit_scores doc(s) already run for this identifier — regardless
 * of what the doc's own ID is (phone, PAN, CKYC, or whatever). A doc created
 * via the dashboard's triggerHighmarkCheck is keyed by phone, so matching on
 * doc ID would completely miss it; this matches on the identifierValue FIELD
 * instead, which every write path (dashboard, WhatsApp bot, bulk script) sets.
 *
 * Matching is case-insensitive: identifierValue isn't consistently
 * uppercased across every write path (the dashboard's HighmarkCheckModal
 * doesn't force it), so an exact-value Firestore query would silently miss
 * a same-identifier duplicate stored in different case.
 *
 * Deliberately does NOT query on identifierKey — that field only exists on
 * docs written by the bulk-seed script. Relying on it here would silently
 * miss duplicates created through the dashboard or WhatsApp bot, which is
 * exactly the gap this check needs to close.
 *
 * Narrows with a where() on identifierType first (cheap, always set on every
 * path), then does the case-insensitive compare in memory.
 *
 * excludeDocId lets a job exclude its own doc from the results, since its
 * own identifierValue trivially matches itself.
 */
export async function findExistingIdentifierChecks(
    identifierType: string,
    identifierValue: string,
    excludeDocId?: string
): Promise<ExistingIdentifierCheck[]> {
    const db = getFirestore();
    const targetKey = identifierValue.trim().toUpperCase();

    const snap = await db.collection("credit_scores").where("identifierType", "==", identifierType).get();

    return snap.docs
        .filter((d) => d.id !== excludeDocId)
        .filter((d) => (d.data().identifierValue || "").trim().toUpperCase() === targetKey)
        .map((d) => ({ docId: d.id, status: d.data().status }));
}