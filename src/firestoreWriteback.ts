import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HighmarkExtractedData } from "./parsing/highmarkParser";

/**
 * Real applications: writes to loan_applications/{uid}.highmark_data[phone] (sibling field, merge).
 * Standalone/manual checks (no real application): writes directly onto the
 * credit_scores/{phone} job doc itself. NEVER creates a loan_applications doc.
 */
export async function writeHighmarkResult(
    phone: string,
    loanApplicationUid: string,
    storagePath: string,
    parsed: HighmarkExtractedData,
    standalone: boolean
): Promise<void> {
    const reportPayload = {
        score: parsed.score,
        user_details: parsed.user_details,
        attributes: parsed.attributes,
        storagePath,
        fetched_at: FieldValue.serverTimestamp(),
    };

    if (standalone) {
        await getFirestore().collection("credit_scores").doc(phone).set(
            { highmark_data: reportPayload },
            { merge: true }
        );
        return;
    }

    await getFirestore().collection("loan_applications").doc(loanApplicationUid).set(
        { highmark_data: { [phone]: reportPayload } },
        { merge: true }
    );
}