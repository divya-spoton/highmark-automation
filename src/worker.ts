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
 *
 * ASSUMPTION FLAGGED: this assumes the queued doc has a `loanApplicationUid`
 * field pointing at the corresponding loan_applications doc, plus the
 * form fields directly on it. I haven't seen how credit_scores docs get
 * created in the new flow (the reference Python keyed by identifierValue,
 * not uid) — confirm this mapping is actually correct before relying on it.
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
    const { docId, data } = job;
    console.log(`[worker] Starting job ${docId}`);

    try {
        const loanApplicationUid: string | undefined = data.loanApplicationUid;
        if (!loanApplicationUid) {
            throw new Error("[worker] Job doc missing loanApplicationUid — cannot write results anywhere");
        }

        const formData = buildFormData(data);

        const page = await ensureLoggedIn();
        await fillAndSubmitInquiryForm(page, formData);

        const pdfBuffer = await pollAndDownloadReport(page);

        const storagePath = await uploadHighmarkPdf(docId, pdfBuffer);
        const parsed = await parseHighmarkPdf(pdfBuffer);

        await writeHighmarkResult(loanApplicationUid, storagePath, parsed);

        await markComplete(docId);
        console.log(`[worker] Job ${docId} complete`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Job ${docId} failed:`, message);
        await markFailed(docId, message);
        // Not re-thrown — one bad job must not take the whole worker process
        // down; it needs to stay alive for the next job in the queue.
    }
}