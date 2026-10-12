import { Dialog, Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { clickAndWaitForNavigation } from "./navigation";

/**
 * Fills and submits Highmark's "Single Request" inquiry form.
 *
 * Design decisions vs. HMFunctions.py's fill_inquiry_form:
 *
 * - Takes a plain `HighmarkFormData` object rather than pulling fields
 *   out of a raw Firestore doc directly. Whatever shape the credit_scores
 *   doc actually has, that mapping happens ONCE at the call site
 *   (worker.ts), not scattered across this function. If the input doc's
 *   shape changes later, only one mapping spot needs to change.
 *
 * - Every field access is validated (non-empty) BEFORE we touch the page.
 *   The reference code would happily send `.send_keys(undefined)` or an
 *   empty string into a live financial form with no complaint. Failing
 *   loudly here, before spending a Highmark inquiry credit on bad data,
 *   is exactly the "no silent data loss" standard already established
 *   for this project — an inquiry submitted with a blank PAN because a
 *   field was missing upstream is a real cost, not a cosmetic bug.
 *
 * - `identifierField` — the reference code's IDENTIFIER_FIELD_MAP (env-
 *   configured dict) is replaced with a plain in-code map, since this is
 *   a small, stable, non-secret lookup table — no reason for it to live
 *   in an env var vs. `statusMaps.js`-style centralization in code.
 *
 * - Submit button click is commented out in the reference code
 *   (`# driver.find_element(...).click()`), presumably because it was
 *   mid-testing. Left explicit and NOT commented out here — flag this
 *   with Laplace before first real run: confirm the submit button ID
 *   and that this is meant to actually submit, not just stage the form.
 */

export interface HighmarkFormData {
    firstName: string;
    lastName: string;
    dob: string; // DD/MM/YYYY
    fatherName: string;
    identifierType: "pan" | "ckyc" | "voter" | "ration" | "other";
    identifierValue: string;
    addressLocality: string;
    addressLine1: string;
    addressPinCode: string;
}

const IDENTIFIER_FIELD_MAP: Record<string, string> = {
    pan: "pan",
    ckyc: "ckyc",
    voter: "idType2Value",
    other: "idType5Value",
    ration: "idType3Value"
};

function requireField(data: HighmarkFormData, field: keyof HighmarkFormData): string {
    const value = data[field];
    if (!value) {
        throw new Error(`[inquiryForm] Missing required field "${field}" — refusing to submit incomplete form`);
    }
    return value;
}

export async function fillAndSubmitInquiryForm(page: Page, data: HighmarkFormData): Promise<void> {
    // Validate everything up front — fail before touching the page at all,
    // not halfway through filling it.
    const firstName = requireField(data, "firstName");
    const lastName = requireField(data, "lastName");
    const dob = requireField(data, "dob");
    const fatherName = requireField(data, "fatherName");
    const identifierType = requireField(data, "identifierType");
    const identifierValue = requireField(data, "identifierValue");
    const addressLocality = requireField(data, "addressLocality");
    const addressLine1 = requireField(data, "addressLine1");
    const addressPinCode = requireField(data, "addressPinCode");

    const identifierField = IDENTIFIER_FIELD_MAP[identifierType];
    if (!identifierField) {
        throw new Error(`[inquiryForm] Unknown identifierType "${identifierType}" — no field mapping`);
    }

    await navigateToSingleRequest(page);

    const [day, month, year] = dob.split("/");
    if (!day || !month || !year) {
        throw new Error(`[inquiryForm] Malformed dob "${dob}" — expected DD/MM/YYYY`);
    }

    const fields: FormField[] = [
        { selector: "#creditType", value: config.highmark.creditType, kind: "select" },
        { selector: "#creditAmount", value: String(config.highmark.creditAmount), kind: "text" },
        { selector: "#firstName", value: firstName, kind: "text" },
        { selector: "#lastName", value: lastName, kind: "text" },
        { selector: "#dobDay", value: String(Number(day)), kind: "select" },
        { selector: "#dobMonth", value: month, kind: "select" },
        { selector: "#dobYear", value: year, kind: "select" },
        { selector: "#fatherName", value: fatherName, kind: "text" },
        { selector: `#${identifierField}`, value: identifierValue, kind: "text" },
        { selector: "#villageLocality1", value: addressLocality, kind: "text" },
        { selector: "#addr1Line1", value: addressLine1, kind: "text" },
        { selector: "#addr1Pin", value: addressPinCode, kind: "text" },
    ];

    await fillFields(page, fields);

    // Read the form back right before submitting. Highmark's own page
    // script has cleared Loan Type / Loan Amount after we filled them
    // ("Loan Type is required." on submit) — refill once, then refuse
    // rather than send an incomplete form.
    let wrong = await findWrongFields(page, fields);
    if (wrong.length > 0) {
        console.warn(`[inquiryForm] Fields lost their values after filling (${wrong.map((f) => f.selector).join(", ")}) — refilling`);
        await fillFields(page, wrong);
        wrong = await findWrongFields(page, wrong);
        if (wrong.length > 0) {
            throw new Error(`[inquiryForm] Fields still empty/wrong after refill: ${wrong.map((f) => f.selector).join(", ")} — NOT submitting`);
        }
    }

    if (config.dryRun) {
        console.log("[inquiryForm] DRY_RUN active — form filled but NOT submitted");
        return;
    }

    // Playwright silently dismisses alert()/confirm() when nothing listens —
    // a validation alert (or a "submit?" confirm, which dismissing CANCELS)
    // would vanish without a trace. Log them; keep the dismiss behaviour.
    const onDialog = (dialog: Dialog) => {
        console.warn(`[inquiryForm] Portal ${dialog.type()} during submit: "${dialog.message()}" — dismissing`);
        dialog.dismiss().catch(() => {});
    };
    page.on("dialog", onDialog);

    console.log(`[inquiryForm] Submitting inquiry for "${firstName} ${lastName}" (from ${page.url()})`);
    try {
        // Wait for the submit's own navigation to finish before anything else
        // touches the page — navigating away mid-submit is how we ended up
        // unsure whether an inquiry went through. Never retry the click here:
        // a second click is a second paid inquiry.
        // If it doesn't navigate at all, the status page is the judge.
        await clickAndWaitForNavigation(page, page.locator("#btnSubNewInquiry1"), { timeoutMs: 60_000, optional: true });
    } finally {
        page.off("dialog", onDialog);
    }

    await logSubmitOutcome(page);
    await assertNotRejected(page);
}

interface FormField {
    selector: string;
    value: string;
    kind: "text" | "select";
}

async function fillFields(page: Page, fields: FormField[]): Promise<void> {
    for (const f of fields) {
        if (f.kind === "select") await page.selectOption(f.selector, f.value);
        else await page.fill(f.selector, f.value);
    }
}

async function findWrongFields(page: Page, fields: FormField[]): Promise<FormField[]> {
    const wrong: FormField[] = [];
    for (const f of fields) {
        const actual = (await page.locator(f.selector).inputValue()).trim();
        // Selects must match exactly; text inputs only need to be non-empty,
        // since the portal may reformat them (e.g. "500000" → "500000.00").
        const ok = f.kind === "select" ? actual === f.value.trim() : actual !== "";
        if (!ok) wrong.push(f);
    }
    return wrong;
}

/**
 * Highmark re-renders the form with "<Field> is required." lines when it
 * rejects a submission. No report will ever appear for that, so fail now
 * instead of polling the status page for 10 minutes.
 */
async function assertNotRejected(page: Page): Promise<void> {
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const rejections = bodyText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /\bis required\.?$/i.test(l));
    if (rejections.length > 0) {
        throw new Error(`[inquiryForm] Highmark rejected the inquiry form: ${rejections.join(" ")}`);
    }
}

/**
 * The portal gives us no reliable success signal yet, so record what the
 * page looked like right after submit: URL, any error-looking text, and a
 * screenshot. When the status page never shows the new row, this is what
 * tells us whether Highmark rejected the form.
 */
async function logSubmitOutcome(page: Page): Promise<void> {
    try {
        console.log(`[inquiryForm] After submit: url=${page.url()} title="${await page.title()}"`);

        const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
        const suspicious = bodyText
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && /error|invalid|mandatory|required|duplicate|not allowed|failed|exceed|insufficient/i.test(l))
            .slice(0, 10);
        if (suspicious.length > 0) {
            console.warn(`[inquiryForm] Possible error text on page after submit:\n  ${suspicious.join("\n  ")}`);
        }

        const shotPath = path.join("debug-screenshots", `after-submit-${Date.now()}.png`);
        await fs.mkdir("debug-screenshots", { recursive: true });
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`[inquiryForm] Screenshot saved: ${shotPath}`);
    } catch (err) {
        console.warn("[inquiryForm] Could not capture post-submit diagnostics:", err instanceof Error ? err.message : err);
    }
}

/**
 * Navigates via the nav menu
 * navigate_hm — clicks the "CIR PRO V2" link inside the consumer bureau
 * nav section rather than assuming a direct URL exists.
 */
async function navigateToSingleRequest(page: Page): Promise<void> {
    const consumerBureau = page.locator(".consumerbureau");
    await consumerBureau.waitFor({ state: "visible", timeout: 10_000 });

    // Step 1: hover Consumer Bureau to reveal "Single Request" / "Track Request"
    await consumerBureau.hover();

    // Step 2: hover "Single Request" (exact match, to avoid matching "Single Request Status")
    const singleRequest = consumerBureau.locator("a", { hasText: /^Single Request$/ });
    await singleRequest.hover();

    // Step 3: CIR PRO V2 should now be visible → click it
    const cirProV2 = consumerBureau.locator("a", { hasText: "CIR PRO V2" });
    await clickAndWaitForNavigation(page, cirProV2);

    // Wait for the full "load" event, not just DOMContentLoaded: the form's
    // own init scripts run around then and can reset fields we've already
    // filled (how Loan Type / Loan Amount ended up blank on submit).
    await page.waitForLoadState("load");
    await page.locator("#creditType").waitFor({ state: "visible", timeout: 10_000 });
}