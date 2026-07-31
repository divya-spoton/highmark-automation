import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HighmarkExtractedData } from "./parsing/highmarkParser";

/**
 * Writes the Highmark result to loan_applications/{uid}.highmark_data
 * this is raw source data, written as a sibling field, never overwriting anything.
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