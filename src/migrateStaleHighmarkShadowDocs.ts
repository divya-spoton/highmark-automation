// src/migrateStaleHighmarkShadowDocs.ts
//
// One-off cleanup script for the pre-fix bug where standalone/manual
// Highmark checks (no real loan application) created a sparse doc in
// loan_applications keyed by phone/PAN instead of storing the result on
// the credit_scores job doc itself.
//
// A "stale shadow doc" is identified by shape, not by a flag, since none
// of these docs were ever tagged at write time:
//
//   loan_applications/{docId}
//     └── highmark_data: { [docId]: { score, user_details, attributes, storagePath, fetched_at } }
//
// i.e. the doc has EXACTLY ONE top-level field (`highmark_data`), and that
// field has EXACTLY ONE key, and that key equals the doc's own ID. A real
// application doc always carries dozens of other fields alongside
// highmark_data, so this fingerprint cannot false-positive on a real record.
//
// For each match, this script:
//   1. Reads credit_scores/{docId} and checks it doesn't already have a
//      highmark_data field (no silent overwrite).
//   2. In a single atomic batch: writes highmark_data onto credit_scores/{docId}
//      (merge) AND deletes loan_applications/{docId}.
//
// Defaults to DRY RUN — no writes, no deletes, just a report. Pass
// --execute to actually perform the migration.
//
// Usage:
//   npx tsx src/migrateStaleHighmarkShadowDocs.ts              # dry run, reports only
//   npx tsx src/migrateStaleHighmarkShadowDocs.ts --execute     # performs the migration
//   npx tsx src/migrateStaleHighmarkShadowDocs.ts --execute --limit 5   # test on a handful first

import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentSnapshot } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { config } from "./config";

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
});

const db = getFirestore();

const EXECUTE = process.argv.includes("--execute");
const limitArgIndex = process.argv.indexOf("--limit");
const LIMIT = limitArgIndex !== -1 ? parseInt(process.argv[limitArgIndex + 1], 10) : undefined;

interface Candidate {
    docId: string;
    highmarkPayload: Record<string, any>;
}

/**
 * Returns the highmark_data payload if `snap` matches the stale-shadow-doc
 * fingerprint exactly, otherwise null. Deliberately strict — anything that
 * doesn't match perfectly is left alone rather than guessed at.
 */
function asStaleShadowDoc(snap: DocumentSnapshot): Record<string, any> | null {
    const data = snap.data();
    if (!data) return null;

    const topLevelKeys = Object.keys(data);
    if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "highmark_data") return null;

    const highmarkData = data.highmark_data;
    if (!highmarkData || typeof highmarkData !== "object") return null;

    const innerKeys = Object.keys(highmarkData);
    if (innerKeys.length !== 1 || innerKeys[0] !== snap.id) return null;

    return highmarkData[snap.id];
}

async function findCandidates(): Promise<Candidate[]> {
    console.log("[migrate] Scanning loan_applications for stale Highmark shadow docs...");

    const snap = await db.collection("loan_applications").get();
    const candidates: Candidate[] = [];

    for (const doc of snap.docs) {
        const payload = asStaleShadowDoc(doc);
        if (payload) {
            candidates.push({ docId: doc.id, highmarkPayload: payload });
        }
    }

    console.log(`[migrate] Scanned ${snap.size} loan_applications docs — found ${candidates.length} stale shadow doc(s).`);
    return candidates;
}

async function migrateOne(candidate: Candidate): Promise<"migrated" | "skipped-conflict" | "dry-run"> {
    const { docId, highmarkPayload } = candidate;
    const creditScoreRef = db.collection("credit_scores").doc(docId);
    const loanAppRef = db.collection("loan_applications").doc(docId);

    const creditScoreSnap = await creditScoreRef.get();

    if (!creditScoreSnap.exists) {
        console.warn(`[migrate] SKIP ${docId} — no matching credit_scores job doc exists. Not fabricating one; review manually.`);
        return "skipped-conflict";
    }

    const existingHighmarkData = creditScoreSnap.data()?.highmark_data;
    if (existingHighmarkData) {
        console.warn(`[migrate] SKIP ${docId} — credit_scores/${docId} already has a highmark_data field. Refusing to overwrite; review manually.`);
        return "skipped-conflict";
    }

    if (!EXECUTE) {
        console.log(`[migrate] DRY RUN — would move highmark_data onto credit_scores/${docId} and delete loan_applications/${docId}`);
        return "dry-run";
    }

    const batch = db.batch();
    batch.set(creditScoreRef, { highmark_data: highmarkPayload, migrated: true }, { merge: true });
    batch.delete(loanAppRef);
    await batch.commit();

    console.log(`[migrate] MIGRATED ${docId} — credit_scores/${docId}.highmark_data set, loan_applications/${docId} deleted.`);
    return "migrated";
}

async function main() {
    console.log(`[migrate] Mode: ${EXECUTE ? "EXECUTE (writes will happen)" : "DRY RUN (no writes)"}`);
    if (LIMIT) console.log(`[migrate] Limiting to first ${LIMIT} candidate(s).`);

    let candidates = await findCandidates();
    if (LIMIT) candidates = candidates.slice(0, LIMIT);

    if (candidates.length === 0) {
        console.log("[migrate] Nothing to do.");
        process.exit(0);
    }

    console.log("[migrate] Candidates:", candidates.map(c => c.docId).join(", "));

    const results = { migrated: 0, "skipped-conflict": 0, "dry-run": 0 };
    for (const candidate of candidates) {
        const outcome = await migrateOne(candidate);
        results[outcome]++;
    }

    console.log("[migrate] Done.");
    console.log(`[migrate] Summary: migrated=${results.migrated}, skipped-conflict=${results["skipped-conflict"]}, dry-run=${results["dry-run"]}`);

    if (!EXECUTE && results["dry-run"] > 0) {
        console.log("[migrate] This was a dry run. Re-run with --execute to actually perform the migration.");
    }
    if (results["skipped-conflict"] > 0) {
        console.log(`[migrate] ${results["skipped-conflict"]} doc(s) were skipped due to conflicts — check the warnings above and resolve manually before re-running.`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("[migrate] Failed:", err);
    process.exit(1);
});