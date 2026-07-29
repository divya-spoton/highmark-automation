import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HighmarkExtractedData } from "./parsing/highmarkParser";

/**
 * Writes the Highmark result to loan_applications/{uid}.highmark_data
 * this is raw source data, written as a sibling field, never overwriting anything.
 * The downstream onUpdate trigger (computeCreditSummary → meta.creditSummary)
 * is a separate, already-existing piece 
 * this function's only job is to
 * deposit correct raw data with a fetched_at timestamp so that trigger fires.
 * It does NOT compute or write meta.creditSummary itself.
 */
export async function writeHighmarkResult(
    loanApplicationUid: string,
    storagePath: string,
    parsed: HighmarkExtractedData
): Promise<void> {
    await getFirestore().collection("loan_applications").doc(loanApplicationUid).set(
        {
            highmark_data: {
                score: parsed.score,
                user_details: parsed.user_details,
                attributes: parsed.attributes,
                storagePath,
                fetched_at: FieldValue.serverTimestamp(),
            },
        },
        { merge: true }
    );
}