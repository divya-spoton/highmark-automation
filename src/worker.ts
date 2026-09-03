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
    const { docId, data } = job;
    console.log(`[worker] Starting job ${docId}`);

    try {
        // docId IS the phone number of application
        // UID is userId

        const uid = data.userId;

        const formData = buildFormData(data);

        const page = await ensureLoggedIn();
        await fillAndSubmitInquiryForm(page, formData);

        const pdfBuffer = await pollAndDownloadReport(page);

        const storagePath = await uploadHighmarkPdf(docId, pdfBuffer);
        const parsed = await parseHighmarkPdf(pdfBuffer);

        await writeHighmarkResult(docId, uid, storagePath, parsed, !!data.standalone);

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