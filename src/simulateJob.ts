// src/simulateJob.ts
//
// Standalone one-off script — creates a single "queued" doc in credit_scores
// so you can test the full worker pipeline (index.ts) end-to-end locally.
//
// This does NOT import anything from index.ts/worker.ts — it's intentionally
// separate, since its only job is to seed one Firestore doc and exit. Run
// this in one terminal, then `npx tsx src/index.ts` in another (or run this
// first, then start index.ts — the queue watcher picks up existing "queued"
// docs on startup via the onSnapshot listener regardless of ordering).
//
// Usage:
//   npx tsx src/simulateJob.ts
//
// Edit the `testData` object below with REAL applicant data before running —
// since DRY_RUN=false means this submits for real and costs a Highmark
// inquiry credit, a fake PAN will likely just fail validation on their end
// rather than testing anything useful.

import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { config } from "./config";

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
});

// ⚠️ REPLACE with real, valid data before running — this is a real submission.
const testData = {
    status: "queued",
    createdAt: FieldValue.serverTimestamp(),
    firstName: "REPLACE_ME",
    lastName: "REPLACE_ME",
    dob: "01/01/1990", // DD/MM/YYYY — matches inquiryForm.ts's expected format
    fatherName: "REPLACE_ME",
    identifierType: "pan", // or "ckyc"
    identifierValue: "REPLACE_ME", // real PAN or CKYC number
    addressLocality: "REPLACE_ME",
    addressLine1: "REPLACE_ME",
    addressPinCode: "REPLACE_ME",
};

const testId = "";

async function main() {
    if (Object.values(testData).some((v) => v === "REPLACE_ME")) {
        console.error("[simulateJob] Refusing to run — replace all REPLACE_ME placeholders with real data first.");
        process.exit(1);
    }

    const db = getFirestore();
    const docRef = await db.collection("credit_scores").doc(testId).set(testData);
    console.log(`[simulateJob] Created queued job: credit_scores/${testId} : ${docRef}`);
    console.log("[simulateJob] Now start (or watch) src/index.ts to see it get claimed and processed.");
    process.exit(0);
}

main().catch((err) => {
    console.error("[simulateJob] Failed:", err);
    process.exit(1);
});