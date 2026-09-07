// src/simulateJob.ts
//
// Bulk seeder — replaces the old single-doc "simulateJob" with a batch
// import mirroring the dashboard's HighmarkCheckModal / triggerHighmarkCheck
// flow (src/context/DataContext.tsx), so these entries behave identically
// to a manual "Run Highmark Check" from the CreditCheck page:
//   - standalone: true    → surfaces on the dashboard's CreditCheck page,
//                           same as any officer-triggered no-application check
//   - identifierKey       → explicit join key for migrating a completed
//                           check into a real loan_applications doc later.
//     Always the uppercased identifierValue, regardless of identifierType —
//     a future migration script reads THIS field to join, not `pan`, so it
//     doesn't need to special-case which identifier type a given doc used.
//   - pan                 → kept ONLY for backward compat with anything that
//                           already reads `.pan` off these docs. Populated
//                           ONLY when identifierType === "pan"; null
//                           otherwise. Do not extend this field to other
//                           types — that's what identifierKey is for.
//
// DOC ID RESOLUTION (per customer):
//   1. The identifier value (uppercased) — whatever identifierType says it
//      is (PAN, CKYC, Ration, Voter, Other/Aadhaar). This is the primary
//      key, since it's the one guaranteed-unique identifier per person in
//      this dataset regardless of type.
//   2. Mobile, normalized to last 10 digits — ONLY used as a fallback if
//      two customers in this batch somehow share the exact same identifier
//      value (which would mean a genuine duplicate/typo, not a legitimate
//      case — this should basically never fire for real data).
//
// CONSEQUENCE OF THIS CHOICE: doc IDs in this batch can now be a PAN,
// CKYC number, Ration Card ID, Voter ID, or Aadhaar/Other ID string — not
// just a 10-digit phone key. src/utils/highmark.ts's
// isShadowCreditCheckDocId() (dashboard repo) assumes shadow (no-
// application) docs are ALWAYS a 10-digit phone key or PAN-shaped string
// (/^\d{10}$/ or /^[A-Z]{5}\d{4}[A-Z]$/) — that assumption is now wrong for
// every CKYC/Ration/Voter/Other-keyed doc this script creates, not just
// PAN-keyed ones. If anything on the dashboard uses that helper to
// *identify* shadow docs (vs. just format them), it will silently fail to
// recognize these. Confirm nothing depends on that regex for correctness
// before treating these as visible to the dashboard the same way a
// phone-keyed manual check would be.
//
// This script ONLY queues Firestore docs — it does not touch the browser
// or Highmark. Whether these get submitted for REAL depends entirely on
// whether src/index.ts is already running and what DRY_RUN is set to at
// that moment:
//   - If index.ts is running with DRY_RUN=false when this script runs,
//     processing starts immediately and automatically (queue/listener.ts
//     drains one job at a time, in createdAt order) — every queued doc
//     here WILL cost a real Highmark inquiry credit.
//   - Start this script first, confirm the printed summary looks right,
//     THEN start (or leave off) index.ts when you're ready to actually run
//     them.
//
// Usage:
//   npx tsx src/simulateJob.ts
import { installTimestampedLogging } from "./utils/logger";
installTimestampedLogging();
import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { config } from "./config";
import { bulkCustomers, RawBulkCustomer } from "./data/bulkCustomers";
import { findExistingIdentifierChecks } from "./utils/duplicateCheck";

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
});

const COLLECTION = "credit_scores";

// Local to this script — this repo (highmark-automation) doesn't share
// code with ho-dashboard, so it can't import IDENTIFIER_TYPE_LABELS from
// there. Keep this in sync by hand if the dashboard's label wording changes;
// it's only used for console output here, nothing functional depends on it.
const IDENTIFIER_TYPE_LABELS: Record<RawBulkCustomer["identifierType"], string> = {
    pan: "PAN",
    ckyc: "CKYC",
    ration: "Ration Card ID",
    voter: "Voter ID",
    other: "Other ID (e.g. Aadhaar)",
};

const ALLOWED_IDENTIFIER_TYPES = new Set<RawBulkCustomer["identifierType"]>([
    "pan", "ckyc", "voter", "ration", "other",
]);

function tenDigitMobile(raw?: string): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
}

type IdSource = RawBulkCustomer["identifierType"] | "mobile";

function resolveDocId(
    customer: RawBulkCustomer,
    usedIds: Set<string>
): { docId: string; idSource: IdSource } {
    const idKey = customer.identifierValue.trim().toUpperCase();
    if (!usedIds.has(idKey)) {
        return { docId: idKey, idSource: customer.identifierType };
    }

    // Identifier already claimed in this batch — should only happen on a
    // genuine duplicate/typo, not by design. Falling back to mobile rather
    // than erroring outright, but this case deserves a manual look either way.
    const mobileKey = tenDigitMobile(customer.mobile);
    if (mobileKey && !usedIds.has(mobileKey)) {
        console.warn(
            `[bulkSeed] Duplicate ${IDENTIFIER_TYPE_LABELS[customer.identifierType]} "${idKey}" for ${customer.firstName} ${customer.lastName} — ` +
            `falling back to mobile-keyed ID.`
        );
        return { docId: mobileKey, idSource: "mobile" };
    }

    throw new Error(
        `[bulkSeed] Duplicate ${IDENTIFIER_TYPE_LABELS[customer.identifierType]} "${idKey}" for ${customer.firstName} ${customer.lastName}, and mobile fallback ` +
        `also unavailable/already claimed — this is a genuine duplicate and needs manual review before seeding.`
    );
}

async function main() {
    const db = getFirestore();
    const usedIds = new Set<string>();

    const created: { docId: string; idSource: IdSource; name: string }[] = [];
    const skipped: { docId: string; name: string; reason: string }[] = [];
    const errored: { name: string; reason: string }[] = [];

    for (const customer of bulkCustomers) {
        if (!ALLOWED_IDENTIFIER_TYPES.has(customer.identifierType)) {
            console.error(`[bulkSeed] Skipping ${customer.firstName} ${customer.lastName} — unknown identifierType "${customer.identifierType}"`);
            continue;
        }
        const name = `${customer.firstName} ${customer.lastName}`;
        let docId: string;
        let idSource: IdSource;

        try {
            ({ docId, idSource } = resolveDocId(customer, usedIds));
        } catch (err) {
            errored.push({ name, reason: err instanceof Error ? err.message : String(err) });
            continue;
        }
        usedIds.add(docId);

        const dupes = await findExistingIdentifierChecks(customer.identifierType, customer.identifierValue, docId);
        if (dupes.length > 0) {
            skipped.push({
                docId,
                name,
                reason: `${IDENTIFIER_TYPE_LABELS[customer.identifierType]} already checked under: ${dupes.map(d => `${d.docId} (${d.status})`).join(", ")}`,
            });
            continue;
        }

        const jobRef = db.collection(COLLECTION).doc(docId);
        const existing = await jobRef.get();
        if (existing.exists) {
            skipped.push({
                docId,
                name,
                reason: `already exists with status "${existing.data()?.status}" — not overwriting`,
            });
            continue;
        }

        const identifierKey = customer.identifierValue.trim().toUpperCase();

        await jobRef.set({
            status: "queued",
            createdAt: FieldValue.serverTimestamp(),
            loanApplicationId: docId, // standalone check → userId is its own doc key, matching triggerHighmarkCheck's convention
            firstName: customer.firstName.trim(),
            lastName: customer.lastName.trim(),
            dob: customer.dob.trim(),
            fatherName: customer.fatherName.trim(),
            identifierType: customer.identifierType,
            identifierValue: customer.identifierValue.trim(),
            addressLocality: customer.addressLocality.trim(),
            addressLine1: customer.addressLine1.trim(),
            addressPinCode: customer.addressPinCode.trim(),
            mobile: customer.mobile || null,
            identifierKey, // stable join key for a future migration script, regardless of identifierType
            pan: customer.identifierType === "pan" ? identifierKey : null, // legacy field — PAN only, see header note
            standalone: true, // same field/meaning as the dashboard's CreditCheck page — no linked application yet
            triggeredBy: "bulk-import-script",
            triggeredManually: true,
            bulkImportDocIdSource: idSource, // "mobile" | identifierType — see file header caveat
        });

        created.push({ docId, idSource, name });
    }

    console.log(`\n[bulkSeed] Created ${created.length} job(s):`);
    for (const c of created) {
        const tag = c.idSource === "mobile" ? "⚠️ mobile-fallback" : `🆔 ${IDENTIFIER_TYPE_LABELS[c.idSource]}-keyed`;
        console.log(`  ${tag}  ${c.docId}  —  ${c.name}`);
    }

    if (skipped.length > 0) {
        console.log(`\n[bulkSeed] Skipped ${skipped.length} (already exist):`);
        for (const s of skipped) console.log(`  ${s.docId} — ${s.name} — ${s.reason}`);
    }

    if (errored.length > 0) {
        console.log(`\n[bulkSeed] ${errored.length} genuine error(s) — needs manual review:`);
        for (const e of errored) console.log(`  ${e.name} — ${e.reason}`);
    }

    const mobileFallbackCount = created.filter(c => c.idSource === "mobile").length;
    console.log(
        `\n[bulkSeed] Done. ${created.length} queued, ${skipped.length} skipped, ${errored.length} errored. ` +
        `${mobileFallbackCount} landed on the mobile fallback ID.`
    );
    process.exit(0);
}

main().catch((err) => {
    console.error("[bulkSeed] Failed:", err);
    process.exit(1);
});