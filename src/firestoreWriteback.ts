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
 * Real applications (standalone === false): writes to
 *   loan_applications/{loanApplicationId}.highmark_data[creditScoreDocId]
 * as a sibling field, merge — never overwrites anything else on that doc.
 *
 * Standalone/manual checks (standalone === true, no real application exists):
 * writes directly onto
 *   credit_scores/{creditScoreDocId}.highmark_data
 * NEVER creates a loan_applications doc for these.
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

    if (standalone) {
        await getFirestore().collection("credit_scores").doc(creditScoreDocId).set(
            { highmark_data: reportPayload },
            { merge: true }
        );
        return;
    }

    await getFirestore().collection("loan_applications").doc(loanApplicationId).set(
        { highmark_data: { [creditScoreDocId]: reportPayload } },
        { merge: true }
    );
}