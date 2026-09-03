// src/worker.ts
import { ClaimedJob, markComplete, markFailed } from "./queue/lock";
import { ensureLoggedIn } from "./automation/login";
import { fillAndSubmitInquiryForm, HighmarkFormData } from "./automation/inquiryForm";
import { pollAndDownloadReport } from "./automation/statusPage";
import { uploadHighmarkPdf } from "./storage";
import { parseHighmarkPdf } from "./parsing/highmarkParser";
import { writeHighmarkResult } from "./firestoreWriteback";

/**
 * Maps a credit_scores queue doc's raw data into the shape
 * fillAndSubmitInquiryForm expects. Kept as its own function — per the
 * principle already applied to inquiryForm.ts — so that if the
 * credit_scores doc's shape changes later, this is the ONE place that
 * needs updating, not scattered across the form-fill logic itself.
 */
function buildFormData(jobData: FirebaseFirestore.DocumentData): HighmarkFormData {
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
        await fillAndSubmitInquiryForm(page, formData);

        const pdfBuffer = await pollAndDownloadReport(page);

        const storagePath = await uploadHighmarkPdf(creditScoreDocId, pdfBuffer);
        const parsed = await parseHighmarkPdf(pdfBuffer);

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