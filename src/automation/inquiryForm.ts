import { Page } from "playwright";
import { config } from "../config";

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
    dob: string; // DD/MM/YYYY, matching Parsers.py's getCkycData output
    fatherName: string;
    identifierType: "pan" | "ckyc";
    identifierValue: string;
    addressLocality: string;
    addressLine1: string;
    addressPinCode: string;
}

const IDENTIFIER_FIELD_MAP: Record<string, string> = {
    pan: "panNo",       // confirm exact field ID against the live form
    ckyc: "ckycNo",     // confirm exact field ID against the live form
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

    await page.selectOption("#creditType", config.highmark.creditType);
    await page.fill("#creditAmount", String(config.highmark.creditAmount));

    await page.fill("#firstName", firstName);
    await page.fill("#lastName", lastName);

    const [day, month, year] = dob.split("/");
    if (!day || !month || !year) {
        throw new Error(`[inquiryForm] Malformed dob "${dob}" — expected DD/MM/YYYY`);
    }
    await page.selectOption("#dobDay", String(Number(day)));
    await page.selectOption("#dobMonth", month);
    await page.selectOption("#dobYear", year);

    await page.fill("#fatherName", fatherName);
    await page.fill(`#${identifierField}`, identifierValue);
    await page.fill("#villageLocality1", addressLocality);
    await page.fill("#addr1Line1", addressLine1);
    await page.fill("#addr1Pin", addressPinCode);

    if (config.dryRun) {
        console.log("[inquiryForm] DRY_RUN active — form filled but NOT submitted");
        return;
    }

    await page.click("#btnSubNewInquiry1");

    // Confirm submission actually succeeded — don't assume a click that
    // didn't throw means the form was accepted. Adjust the selector below
    // once you've seen what a real success state looks like (confirmation
    // banner, redirect, etc.) — this is a placeholder pending that.
    await page.waitForTimeout(2_000);
}

/**
 * Navigates via the nav menu
 * navigate_hm — clicks the "CIR PRO V2" link inside the consumer bureau
 * nav section rather than assuming a direct URL exists.
 */
async function navigateToSingleRequest(page: Page): Promise<void> {
    const consumerBureau = page.locator(".consumerbureau");
    await consumerBureau.waitFor({ state: "visible", timeout: 10_000 });

    const link = consumerBureau.locator("a", { hasText: "CIR PRO V2" });
    await link.click();
}