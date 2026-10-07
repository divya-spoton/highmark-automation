import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HighmarkExtractedData } from "./parsing/highmarkParser";

interface WriteHighmarkResultInput {
    /** credit_scores/{this} — the phone (10-digit), PAN, CKYC etc. this check was queued under. */
    creditScoreDocId: string;
    /** loan_applications/{this} the check belongs to. Only stored (as a join key) when standalone is false. */
    loanApplicationId: string;
    storagePath: string;
    parsed: HighmarkExtractedData;
    /** true = manual check with no real loan application behind it. */
    standalone: boolean;
}

/**
 * Every Highmark result is written ONLY to credit_scores/{creditScoreDocId}.
 * loan_applications is never written to.
 *
 * If the check belongs to a real loan application, that application's ID is
 * stored on the credit_scores doc as `loanApplicationId`, so the two can be
 * joined later. For standalone checks there is no application, so no
 * reference is written here.
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

    // rawExtractedText is written in the same write as highmark_data so the
    // onHighmarkReportParsed Cloud Function sees both together. This only runs
    // after assertParsedMatchesSubmission passes, so a mismatched report is
    // never summarised.
    const update: Record<string, unknown> = {
        highmark_data: reportPayload,
        rawExtractedText: parsed.raw_text,
    };
    if (!standalone) {
        update.loanApplicationId = loanApplicationId;
    }

    await getFirestore().collection("credit_scores").doc(creditScoreDocId).set(update, { merge: true });
}
