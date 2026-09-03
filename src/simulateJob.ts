// src/simulateJob.ts
//
// Bulk seeder — replaces the old single-doc "simulateJob" with a batch
// import mirroring the dashboard's HighmarkCheckModal / triggerHighmarkCheck
// flow (src/context/DataContext.tsx), so these entries behave identically
// to a manual "Run Highmark Check" from the CreditCheck page:
//   - standalone: true   → surfaces on the dashboard's CreditCheck page,
//                          same as any officer-triggered no-application check
//   - pan                → explicit join key for migrating a completed
//                          check into a real loan_applications doc later
//     (identifierValue already holds the PAN, but a dedicated `pan` field
//     means a future migration script doesn't have to know identifierType
//     could theoretically be 'ckyc' — it just reads `pan`)
//
// DOC ID RESOLUTION (per customer):
//   1. Mobile, normalized to last 10 digits — IF present, valid, and not
//      already claimed by an earlier customer in this same batch.
//   2. Otherwise, the PAN (uppercased) — used for customers with no
//      mobile, an empty mobile, or a mobile that collides with someone
//      else already queued in this run (this list has three such pairs
//      where two people share one phone).
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

import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { config } from "./config";
import { bulkCustomers, RawBulkCustomer } from "./data/bulkCustomers";

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
});

const COLLECTION = "credit_scores";

function tenDigitMobile(raw?: string): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
}

type IdSource = "mobile" | "pan";

// DOC ID RESOLUTION (per customer):
//   1. PAN (uppercased) — the primary key, since it's the one guaranteed-
//      unique identifier per person in this dataset.
//   2. Mobile, normalized to last 10 digits — ONLY used as a fallback if
//      two customers in this batch somehow share the exact same PAN
//      (which would mean a genuine duplicate/typo, not a legitimate case —
//      this should basically never fire for real data).
//
// CONSEQUENCE OF THIS CHOICE: every doc ID in this batch will now be a PAN
// string, not a 10-digit number. src/utils/highmark.ts's
// isShadowCreditCheckDocId() assumes shadow (no-application) docs are
// ALWAYS 10-digit phone keys (/^\d{10}$/) — that assumption is now wrong
// for 100% of this batch, not just the edge cases. If anything on the
// dashboard uses that helper to *identify* shadow docs (vs. just format
// them), it will silently fail to recognize every doc this script creates.
// Confirm nothing depends on that regex for correctness before treating
// these as visible to the dashboard the same way a phone-keyed manual
// check would be.

function resolveDocId(
    customer: RawBulkCustomer,
    usedIds: Set<string>
): { docId: string; idSource: IdSource } {
    const panKey = customer.identifierValue.trim().toUpperCase();
    if (!usedIds.has(panKey)) {
        return { docId: panKey, idSource: "pan" };
    }

    // PAN already claimed in this batch — should only happen on a genuine
    // duplicate/typo, not by design. Falling back to mobile rather than
    // erroring outright, but this case deserves a manual look either way.
    const mobileKey = tenDigitMobile(customer.mobile);
    if (mobileKey && !usedIds.has(mobileKey)) {
        console.warn(
            `[bulkSeed] Duplicate PAN "${panKey}" for ${customer.firstName} ${customer.lastName} — ` +
            `falling back to mobile-keyed ID. Verify this isn't a data entry error.`
        );
        return { docId: mobileKey, idSource: "mobile" };
    }

    throw new Error(
        `[bulkSeed] Duplicate PAN "${panKey}" for ${customer.firstName} ${customer.lastName}, and mobile fallback ` +
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

        const pan = customer.identifierValue.trim().toUpperCase();

        await jobRef.set({
            status: "queued",
            createdAt: FieldValue.serverTimestamp(),
            userId: docId, // standalone check → userId is its own doc key, matching triggerHighmarkCheck's convention
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
            pan, // explicit join key for a future migration script into loan_applications
            standalone: true, // same field/meaning as the dashboard's CreditCheck page — no linked application yet
            triggeredBy: "bulk-import-script",
            triggeredManually: true,
            bulkImportDocIdSource: idSource, // "mobile" | "pan" — see file header caveat
        });

        created.push({ docId, idSource, name });
    }

    console.log(`\n[bulkSeed] Created ${created.length} job(s):`);
    for (const c of created) {
        console.log(`  ${c.idSource === "mobile" ? "⚠️ mobile-fallback" : "🆔 PAN-keyed"}  ${c.docId}  —  ${c.name}`);
    }

    if (skipped.length > 0) {
        console.log(`\n[bulkSeed] Skipped ${skipped.length} (already exist):`);
        for (const s of skipped) console.log(`  ${s.docId} — ${s.name} — ${s.reason}`);
    }

    if (errored.length > 0) {
        console.log(`\n[bulkSeed] ${errored.length} genuine error(s) — needs manual review:`);
        for (const e of errored) console.log(`  ${e.name} — ${e.reason}`);
    }

    const panFallbackCount = created.filter(c => c.idSource === "pan").length;
    console.log(
        `\n[bulkSeed] Done. ${created.length} queued, ${skipped.length} skipped, ${errored.length} errored. ` +
        `${panFallbackCount} landed on the PAN fallback ID.`
    );
    process.exit(0);
}

main().catch((err) => {
    console.error("[bulkSeed] Failed:", err);
    process.exit(1);
});