import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HighmarkExtractedData } from "./parsing/highmarkParser";

interface WriteHighmarkResultInput {
    /** credit_scores/{this} — the phone (10-digit) or PAN this check was queued under. */
    creditScoreDocId: string;
    /** loan_applications/{this} — only read/used when standalone === false. */
    loanApplicationId: string;
    storagePath: string;
    parsed: HighmarkExtractedData;
    /** true = manual check with no real loan application behind it. */
    standalone: boolean;
}

/**
 * Standalone (no real application): credit_scores ONLY. Never touches
 * loan_applications.
 *
 * Real application: writes to credit_scores unconditionally (source of
 * truth going forward), AND mirrors onto loan_applications for backward
 * compatibility with older readers — but ONLY if loanApplicationId
 * actually resolves to an existing doc. Never blind-merge into
 * loan_applications; that's exactly the bug this whole change started from.
 */
export async function writeHighmarkResult({
    creditScoreDocId,
    loanApplicationId,
    storagePath,
    parsed,
    standalone,
}: WriteHighmarkResultInput): Promise<void> {
    const reportPayload = {
        score: parsed.score,
        user_details: parsed.user_details,
        attributes: parsed.attributes,
        storagePath,
        fetched_at: FieldValue.serverTimestamp(),
    };

    const db = getFirestore();
    const creditScoreRef = db.collection("credit_scores").doc(creditScoreDocId);

    if (standalone) {
        await creditScoreRef.set({ highmark_data: reportPayload }, { merge: true });
        return;
    }

    const appRef = db.collection("loan_applications").doc(loanApplicationId);
    const appSnap = await appRef.get();

    const writes: Promise<unknown>[] = [
        creditScoreRef.set({ highmark_data: reportPayload }, { merge: true }),
    ];

    if (appSnap.exists) {
        writes.push(
            appRef.set(
                { highmark_data: { [creditScoreDocId]: reportPayload } },
                { merge: true }
            )
        );
    } else {
        console.warn(
            `[writeHighmarkResult] loan_applications/${loanApplicationId} does not exist — skipping legacy mirror. credit_scores/${creditScoreDocId} was still updated.`
        );
    }

    await Promise.all(writes);
}