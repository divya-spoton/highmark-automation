// src/runOnce.ts
//
// Runs ONE real Highmark check locally, bypassing the shared Firestore
// queue entirely — for testing the pipeline end-to-end (login, download,
// parsing, storage/Firestore writeback) against one real applicant without
// touching queue/lock.ts or queue/listener.ts at all.
//
// Why not just write a normal "queued" doc (like simulateJob.ts does) and
// let index.ts's watcher pick it up?
//   - If the deployed worker (on the droplet) is running, it watches the
//     SAME Firestore project for status=="queued" docs — it could claim
//     your test job before your local process ever sees it.
//   - claimNextJob() also refuses to claim ANYTHING, system-wide, while any
//     doc has status=="processing" (this system assumes exactly one job
//     runs at a time) — so even a self-claimed "processing" doc would
//     block real production jobs on the droplet for the duration of your
//     test.
// This doc's status is "manual-test" — matched by NEITHER of the queries
// above — so this can never race with, or block, the deployed worker.
//
// This IS a real Highmark inquiry: it spends a real credit and logs in
// against the live portal, and it DOES write real results to
// credit_scores/{docId} and Storage, same as a production job. Not a
// dry run — for that, use manualTest.ts with DRY_RUN=true instead.
//
// One more side effect worth knowing: duplicateCheck.ts matches on
// identifierType + identifierValue regardless of status, so whatever
// identifier you use here becomes permanently "already checked" — if you
// use a real customer's real PAN, a later real check for that same person
// via the normal dashboard/bulk flow will be refused as a duplicate. Use a
// disposable test identifier unless this test run IS the real check you
// need for this person.
//
// Usage:
//   npx tsx src/runOnce.ts
import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { config } from "./config";
import { runJob } from "./worker";
import { browserManager } from "./browser/browserManager";
import { installTimestampedLogging } from "./utils/logger";

installTimestampedLogging();

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
    storageBucket: "validator-ca4c7.firebasestorage.app",
});

// ---- EDIT THIS before running -------------------------------------------
// docId doubles as the credit_scores/{docId} document this writes to. Pick
// something that doesn't already exist there (a fresh PAN/CKYC, or a
// deliberately fake one like manualTest.ts uses) — this script does NOT
// check for or overwrite an existing doc.
const docId = "7848079877";
const jobData = {
    standalone: false,
    loanApplicationId: docId,
    firstName: "RAMJEET",
    lastName: "HEMBRAM",
    dob: "14/08/1982", // DD/MM/YYYY
    fatherName: "RUCHULU HEMBRAM",
    identifierType: "pan" as const,
    identifierValue: docId,
    addressLocality: "Mayurbhanj",
    addressLine1: "Tadkijharan, Khunta, Badapathara",
    addressPinCode: "757074",
};
// --------------------------------------------------------------------------

async function main() {
    const db = getFirestore();
    await db.collection("credit_scores").doc(docId).set({
        ...jobData,
        status: "manual-test",
        createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`[runOnce] Wrote credit_scores/${docId} (status: manual-test) — calling runJob() directly, no queue involved`);
    await runJob({ docId, data: jobData });

    console.log("[runOnce] Job finished — leaving the browser open for 20s so you can look at the final page before it closes.");
    await new Promise((r) => setTimeout(r, 20_000));

    await browserManager.shutdown();
    process.exit(0);
}

main().catch((err) => {
    console.error("[runOnce] Failed:", err);
    process.exit(1);
});
