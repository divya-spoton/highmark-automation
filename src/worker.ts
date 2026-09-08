// src/worker.ts
import { ClaimedJob, markComplete, markFailed } from "./queue/lock";
import { ensureLoggedIn } from "./automation/login";
import { fillAndSubmitInquiryForm, HighmarkFormData } from "./automation/inquiryForm";
import { getCurrentTopReportId, pollAndDownloadReport } from "./automation/statusPage";
import { uploadHighmarkPdf } from "./storage";
import { HighmarkExtractedData, parseHighmarkPdf } from "./parsing/highmarkParser";
import { writeHighmarkResult } from "./firestoreWriteback"; 
import { findExistingIdentifierChecks } from "./utils/duplicateCheck";


function normalizeNameTokens(name: string): string[] {
    return name.toUpperCase().replace(/\b(MR|MRS|MS|SHRI|SMT)\b/g, "").split(/\s+/).filter(Boolean).sort();
}

function assertParsedMatchesSubmission(parsed: HighmarkExtractedData, formData: HighmarkFormData): void {
    const submitted = normalizeNameTokens(`${formData.firstName} ${formData.lastName}`);
    const parsedName = normalizeNameTokens(parsed.user_details?.name ?? "");
    const overlap = submitted.filter((t) => parsedName.includes(t));

    if (overlap.length < Math.min(2, submitted.length)) {
        throw new Error(
            `[worker] CRITICAL: parsed PDF name "${parsed.user_details?.name}" does not match submitted applicant "${formData.firstName} ${formData.lastName}" — refusing to write this data anywhere. Job will be marked failed for manual review; do NOT retry blindly, check which customer's data this actually belongs to first.`
        );
    }
}

const ALLOWED_IDENTIFIER_TYPES = new Set(["pan", "ckyc", "voter", "ration", "other"]);

/**
 * Maps a credit_scores queue doc's raw data into the shape
 * fillAndSubmitInquiryForm expects. Kept as its own function — per the
 * principle already applied to inquiryForm.ts — so that if the
 * credit_scores doc's shape changes later, this is the ONE place that
 * needs updating, not scattered across the form-fill logic itself.
 */
function buildFormData(jobData: FirebaseFirestore.DocumentData): HighmarkFormData {
    if (!ALLOWED_IDENTIFIER_TYPES.has(jobData.identifierType)) {
        throw new Error(`[worker] Unknown identifierType "${jobData.identifierType}" on job doc — refusing to run`);
    }

    return {
        firstName: jobData.firstName,
        lastName: jobData.lastName,
        dob: jobData.dob,
        fatherName: jobData.fatherName,
        identifierType: jobData.identifierType,
        identifierValue: jobData.identifierValue,
        addressLocality: jobData.addressLocality,
        addressLine1: jobData.addressLine1,
        addressPinCode: jobData.addressPinCode,
    };
}

export async function runJob(job: ClaimedJob): Promise<void> {
    // job.docId is the credit_scores document ID — the phone (10-digit) or
    // PAN this check was queued under. It is NOT necessarily a loan
    // application ID (see standalone below).
    const { docId: creditScoreDocId, data } = job;
    console.log(`[worker] Starting job ${creditScoreDocId}`);

    try {
        // Refuse a repeat Highmark inquiry for an identifier already checked
        // under ANY doc ID (phone-keyed, PAN-keyed, whatever) — this is the
        // one place every queue producer (dashboard, WhatsApp bot, bulk
        // scripts) passes through, so it's the only reliable place to catch
        // this regardless of origin.
        if (data.identifierType && data.identifierValue) {
            const dupes = await findExistingIdentifierChecks(data.identifierType, data.identifierValue, creditScoreDocId);
            if (dupes.length > 0) {
                const summary = dupes.map((d) => `${d.docId} (${d.status})`).join(", ");
                throw new Error(
                    `Duplicate ${data.identifierType.toUpperCase()} ${data.identifierValue} — already checked under: ${summary}. Refusing to run a repeat Highmark inquiry.`
                );
            }
        }

        // data.loanApplicationId: for a REAL application check, this is the
        // loan_applications doc to write highmark_data onto. For a
        // STANDALONE/manual check (no real application), the dashboard sets
        // this to the same value as creditScoreDocId, since there's nothing
        // real to point at.
        // Fallback to the old `userId` field name for any job doc still
        // sitting in "queued" status from before this rename shipped.
        const loanApplicationId: string = data.loanApplicationId ?? data.userId;
        const standalone = !!data.standalone;

        const formData = buildFormData(data);

        const page = await ensureLoggedIn();

        const baselineReportId = await getCurrentTopReportId(page);

        await fillAndSubmitInquiryForm(page, formData);

        const pdfBuffer = await pollAndDownloadReport(
            page,
            { firstName: formData.firstName, lastName: formData.lastName, dob: formData.dob },
            baselineReportId
        );

        const storagePath = await uploadHighmarkPdf(creditScoreDocId, pdfBuffer);
        const parsed = await parseHighmarkPdf(pdfBuffer);

        // LAST LINE OF DEFENSE: even if the portal-side identity check above has
        // a bug we haven't hit yet, never let mismatched data reach Firestore.
        assertParsedMatchesSubmission(parsed, formData);

        await writeHighmarkResult({
            creditScoreDocId,
            loanApplicationId,
            storagePath,
            parsed,
            standalone,
        });

        await markComplete(creditScoreDocId);
        console.log(`[worker] Job ${creditScoreDocId} complete`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Job ${creditScoreDocId} failed:`, message);
        await markFailed(creditScoreDocId, message);
    }
}