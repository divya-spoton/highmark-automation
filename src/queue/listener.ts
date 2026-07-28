// src/queue/listener.ts
import { getFirestore } from "firebase-admin/firestore";
import { claimNextJob, recoverStaleJobs, ClaimedJob } from "./lock";

const COLLECTION = "credit_scores";
const STALE_CHECK_INTERVAL_MS = 60_000; // 1 min — cheap safety net, not the primary trigger

/**
 * Starts the queue watcher. Two mechanisms, deliberately different in kind:
 *
 * - onSnapshot: reacts near-instantly when a new "queued" doc appears.
 *   This is the primary way jobs get noticed. The Admin SDK manages the
 *   underlying connection/reconnect itself — we don't hand-roll that.
 *
 * - setInterval: NOT for detecting new jobs (the snapshot listener
 *   already does that) — it exists purely to call recoverStaleJobs(),
 *   which is inherently time-based ("has this been 'processing' too
 *   long?") and can't be expressed as "react when a document changes."
 *   It doubles as a safety net: if the snapshot listener ever misses
 *   something, a queued job sitting untouched still eventually gets
 *   picked up because attemptClaim() below runs on every stale-check
 *   tick too, not just on snapshot events.
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

    async function attemptClaim() {
        if (isProcessing) return;
        isProcessing = true;
        try {
            const job = await claimNextJob(workerId);
            if (job) {
                await onJobAvailable(job);
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
            (snapshot) => {
                if (!snapshot.empty) {
                    attemptClaim();
                }
            },
            (err) => {
                // Listener itself errored (rare, but possible — e.g. permissions
                // issue). Log loudly; the interval below still catches queued
                // jobs even if this listener is dead.
                console.error("[listener] onSnapshot error:", err);
            }
        );

    const staleCheckInterval = setInterval(async () => {
        await recoverStaleJobs();
        await attemptClaim(); // safety net, see note above
    }, STALE_CHECK_INTERVAL_MS);

    // Returns a cleanup function for graceful shutdown (SIGTERM handling in index.ts)
    return () => {
        unsubscribeSnapshot();
        clearInterval(staleCheckInterval);
    };
}