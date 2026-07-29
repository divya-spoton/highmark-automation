// src/manualTest.ts
import "dotenv/config";
import { ensureLoggedIn } from "./automation/login";
import { fillAndSubmitInquiryForm, HighmarkFormData } from "./automation/inquiryForm";
import { browserManager } from "./browser/browserManager";

// Fill in with YOUR OWN real (or safely fake, non-production) test data.
const testData: HighmarkFormData = {
    firstName: "Test",
    lastName: "User",
    dob: "01/01/1990",
    fatherName: "Test Father",
    identifierType: "pan",
    identifierValue: "ABCDE1234F",
    addressLocality: "Test Locality",
    addressLine1: "Test Address Line 1",
    addressPinCode: "400001",
};

async function main() {
    const page = await ensureLoggedIn();
    console.log("Logged in successfully — check the browser window.");

    await fillAndSubmitInquiryForm(page, testData);
    console.log("Form filled (DRY_RUN — not submitted). Inspect the browser window now.");

    // Keep the browser open for 30s so you can look at it before it closes.
    await page.waitForTimeout(30_000);
    await browserManager.shutdown();
}

main().catch((err) => {
    console.error("Manual test failed:", err);
    process.exit(1);
});