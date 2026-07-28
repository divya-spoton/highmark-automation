import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";

/**
 * Design decisions:
 *
 * - Concurrency=1 is enforced by a Firestore TRANSACTION, not by in-memory
 *   state (e.g. a JS boolean flag). An in-memory flag only protects you
 *   within a single running process — if the worker restarts mid-job
 *   (crash, `docker restart`, memory-limit kill), that flag is gone and a
 *   second job could start believing nothing is in progress. A Firestore
 *   transaction is the source of truth regardless of what process is
 *   running or how many times it's restarted.
 *
 * - A job is claimed by atomically checking "is anything currently
 *   processing?" and if not, writing `status: "processing"` + a lock
 *   timestamp + worker identity in the SAME transaction. Two workers (or
 *   two overlapping runs of the same worker, e.g. during a bad deploy)
 *   racing to claim a job can never both succeed — Firestore transactions
 *   guarantee that.
 *
 * - Stale-lock recovery: if a job has been "processing" for longer than
 *   any real Highmark run should ever take, something died mid-job
 *   (crash, killed container, unhandled exception that skipped cleanup).
 *   Rather than that job sitting stuck forever, a periodic check resets
 *   it back to "queued" with an incremented retry count. This is what
 *   makes "the container gets killed and restarted" from our earlier
 *   conversation actually safe rather than just hopeful.
 *
 * - MAX_RETRIES exists because some failures are NOT transient (e.g. a
 *   permanently malformed input doc) — endlessly re-queuing forever would
 *   hide a real problem instead of surfacing it. After MAX_RETRIES, the
 *   job is marked "failed_permanently" and left for a human, not retried
 *   again silently.
 */

const COLLECTION = "credit_scores";
const STALE_AFTER_MS = 20 * 60 * 1000; // 20 min — generous vs. a real run (~5-10 min)
const MAX_RETRIES = 3;

export interface ClaimedJob {
    docId: string;
    data: FirebaseFirestore.DocumentData;
}

/**
 * Attempts to claim exactly one queued job. Returns null if nothing is
 * available (either the queue is empty, or something else is already
 * "processing" — remember, concurrency=1 is a hard requirement here).
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
    const db = getFirestore();

    return db.runTransaction(async (tx) => {
        // Hard rule: if ANYTHING is already "processing", claim nothing —
        // even if there are 10 "queued" docs waiting. This is what makes
        // concurrency=1 real rather than aspirational.
        const processingSnap = await tx.get(
            db.collection(COLLECTION).where("status", "==", "processing").limit(1)
        );
        if (!processingSnap.empty) {
            return null;
        }

        const queuedSnap = await tx.get(
            db
                .collection(COLLECTION)
                .where("status", "==", "queued")
                .orderBy("createdAt", "asc")
                .limit(1)
        );
        if (queuedSnap.empty) {
            return null;
        }

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

/**
 * Marks a job failed for THIS attempt. If retries remain, puts it back
 * in "queued" (so claimNextJob picks it up again later) with an
 * incremented counter. If retries are exhausted, marks it
 * "failed_permanently" — this is a terminal state a human needs to look
 * at, not something the queue will ever pick up again on its own.
 */
export async function markFailedOrRetry(docId: string, errorMessage: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection(COLLECTION).doc(docId);

    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const currentRetries = snap.data()?.retryCount ?? 0;
        const nextRetries = currentRetries + 1;

        if (nextRetries > MAX_RETRIES) {
            tx.update(ref, {
                status: "failed_permanently",
                retryCount: nextRetries,
                lastError: errorMessage,
                failedAt: FieldValue.serverTimestamp(),
            });
        } else {
            tx.update(ref, {
                status: "queued",
                retryCount: nextRetries,
                lastError: errorMessage,
            });
        }
    });
}

/**
 * Run this on an interval (e.g. every 60s from worker.ts) — finds any job
 * stuck in "processing" past STALE_AFTER_MS and routes it through the
 * same retry/fail logic as an explicit failure. This is what recovers a
 * job that was in flight when the process was killed outright (so no
 * catch block ever ran to call markFailedOrRetry itself).
 */
export async function recoverStaleJobs(): Promise<void> {
    const db = getFirestore();
    const staleThreshold = Timestamp.fromMillis(Date.now() - STALE_AFTER_MS);

    const staleSnap = await db
        .collection(COLLECTION)
        .where("status", "==", "processing")
        .where("lockedAt", "<", staleThreshold)
        .get();

    for (const doc of staleSnap.docs) {
        console.warn(`[lock] Recovering stale job ${doc.id} (locked since ${doc.data().lockedAt?.toDate()})`);
        await markFailedOrRetry(doc.id, "Recovered from stale 'processing' lock — worker likely crashed");
    }
}