import { getFirestore } from "firebase-admin/firestore";
import { claimNextJob, ClaimedJob } from "./lock";

const COLLECTION = "credit_scores";

/**
 * Starts the queue watcher.
 *
 * onJobAvailable is a callback into worker.ts — this file only detects
 * and claims; it doesn't know how to actually run a Highmark job.
 */
export function startQueueWatcher(
    workerId: string,
    onJobAvailable: (job: ClaimedJob) => Promise<void>
): () => void {
    const db = getFirestore();
    let isProcessing = false; // in-process guard so we don't call claimNextJob
    // concurrently with itself from overlapping triggers
    // (the Firestore transaction already guarantees
    // correctness even without this, but it avoids
    // wasted reads from firing two claims at once)

    async function drainQueue() {
        if (isProcessing) return;
        isProcessing = true;
        try {
            let job = await claimNextJob(workerId);
            while (job) {
                await onJobAvailable(job);
                job = await claimNextJob(workerId); // check again immediately — don't wait for a snapshot
            }
        } catch (err) {
            console.error("[listener] Error during claim/job execution:", err);
        } finally {
            isProcessing = false;
        }
    }

    const unsubscribeSnapshot = db
        .collection(COLLECTION)
        .where("status", "==", "queued")
        .onSnapshot(
            (snapshot) => { if (!snapshot.empty) drainQueue(); },
            (err) => console.error("[listener] onSnapshot error:", err)
        );

    return () => unsubscribeSnapshot();
}