// src/queue/lock.ts
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";

/**
 * Simplified design (revised after discussion): no automatic retry.
 * A failure — whether explicit (caught in worker.ts) or discovered via
 * staleness (crash mid-job) — marks the doc "failed" immediately, once,
 * with a logged reason. A human decides whether to manually requeue it
 * (by setting status back to "queued" themselves) or leave it failed.
 *
 * This trades "self-healing for transient failures" for "every failure
 * is visible exactly once, with no silent retry gap" — the right call
 * at low volume where a human glancing at a failed doc costs nothing.
 */

const COLLECTION = "credit_scores";
const STALE_AFTER_MS = 20 * 60 * 1000; // 20 min — generous vs. a real run (~5-10 min)

export interface ClaimedJob {
    docId: string;
    data: FirebaseFirestore.DocumentData;
}

export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
    const db = getFirestore();

    return db.runTransaction(async (tx) => {
        const processingSnap = await tx.get(
            db.collection(COLLECTION).where("status", "==", "processing").limit(1)
        );
        if (!processingSnap.empty) return null;

        const queuedSnap = await tx.get(
            db.collection(COLLECTION).where("status", "==", "queued").orderBy("createdAt", "asc").limit(1)
        );
        if (queuedSnap.empty) return null;

        const doc = queuedSnap.docs[0];
        tx.update(doc.ref, {
            status: "processing",
            lockedAt: FieldValue.serverTimestamp(),
            lockedBy: workerId,
        });

        return { docId: doc.id, data: doc.data() };
    });
}

export async function markComplete(docId: string): Promise<void> {
    await getFirestore().collection(COLLECTION).doc(docId).update({
        status: "complete",
        completedAt: FieldValue.serverTimestamp(),
    });
}

/** Called once on any failure — explicit (worker.ts catch block) or
 *  discovered (recoverStaleJobs below). No retry, no requeue. */
export async function markFailed(docId: string, errorMessage: string): Promise<void> {
    await getFirestore().collection(COLLECTION).doc(docId).update({
        status: "failed",
        lastError: errorMessage,
        failedAt: FieldValue.serverTimestamp(),
    });
}

/**
 * Runs ONCE at worker startup, not on a recurring interval. Reasoning:
 * only one worker process is ever running (a hard requirement of this
 * whole system), so the only moment a "processing" doc can be orphaned
 * is right when a NEW process starts up after the previous one died —
 * there's no other window in which "processing" can go stale, so there's
 * no need to keep checking a clock throughout normal operation.
 */
export async function recoverOrphanedJobsOnStartup(): Promise<void> {
    const db = getFirestore();
    const orphaned = await db.collection(COLLECTION).where("status", "==", "processing").get();

    for (const doc of orphaned.docs) {
        console.warn(`[lock] Found orphaned 'processing' job ${doc.id} on startup — previous worker crashed`);
        await markFailed(doc.id, "Worker process was restarted while this job was processing (previous run likely crashed)");
    }
}