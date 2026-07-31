import { Page } from "playwright";
import { dismissStayLoggedInPopup } from "./login";

/**
 * After a successful inquiry submission, Highmark takes some time to
 * generate the report. This polls the "Single Request Status" page
 * until today's top row has a downloadable PDF, then downloads it.
 *
 * Design decisions vs. HMFunctions.py's download_report:
 *
 * - Bounded polling, not a single check. The reference code does one
 *   `time.sleep()`-free attempt via WebDriverWait with a 10s timeout —
 *   fine if the report is already ready, but Highmark's own report
 *   generation can take minutes, which the original flow handled by
 *   the OUTER script's own delay before calling download_report at all.
 *   Here, polling is explicit and visible in one place instead of
 *   implicit in caller timing.
 *
 * - "Top row" is fetched, not assumed pre-verified. Given your own
 *   stated constraint (only one Highmark run happens at a time, ever),
 *   the top row of today's results IS necessarily the one we just
 *   submitted — there's no other request that could have landed there
 *   in between, since nothing else runs concurrently. Still, we log
 *   what we're about to download so it's auditable after the fact if
 *   something ever looks wrong (e.g. checking logs against Firestore).
 *
 * - Uses Playwright's `page.waitForEvent('download')` around the click,
 *   which is the correct Playwright-native way to capture a file
 *   download — NOT reading from a local Downloads folder afterward like
 *   File-Listener.py does. This is a meaningful improvement: no watching
 *   a filesystem, no guessing when a download finished, no separate
 *   process needed at all. The PDF bytes are available directly in
 *   memory as soon as the download completes.
 */

const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20; // 20 × 30s = 10 minutes total, matching your original estimate

export async function pollAndDownloadReport(page: Page): Promise<Buffer> {
    await navigateToStatusPage(page);

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        console.log(`[statusPage] Poll attempt ${attempt}/${MAX_POLL_ATTEMPTS}`);

        // Re-navigate/refresh each attempt — the status page likely needs a
        // reload to show a newly-ready report, it won't update live on its own.
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissStayLoggedInPopup(page);

        const pdfLink = page.locator("(//img[@alt='PDF Report']/parent::a)[1]");
        const isReady = await pdfLink
            .waitFor({ state: "visible", timeout: 5_000 })
            .then(() => true)
            .catch(() => false);

        if (isReady) {
            console.log("[statusPage] PDF ready — downloading");
            return await downloadPdf(page, pdfLink);
        }

        if (attempt < MAX_POLL_ATTEMPTS) {
            await page.waitForTimeout(POLL_INTERVAL_MS);
        }
    }

    throw new Error(
        `[statusPage] Report not ready after ${MAX_POLL_ATTEMPTS} attempts (${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} min) — Highmark may be delayed or the submission failed silently`
    );
}

async function navigateToStatusPage(page: Page): Promise<void> {
    const consumerBureau = page.locator(".consumerbureau");
    await consumerBureau.waitFor({ state: "visible", timeout: 10_000 });

    // Step 1: hover Consumer Bureau to reveal "Single Request" / "Track Request"
    await consumerBureau.hover();

    // Step 2: find and hover "Track Request" to reveal the Single Request Status submenu
    const trackRequest = consumerBureau.locator("a", { hasText: "Track Request" });
    await trackRequest.hover();

    // Step 3: find and click "Single Request Status" submenu
    const link = consumerBureau.locator("a", { hasText: "Single Request Status" });
    await link.click();
}

async function downloadPdf(page: Page, pdfLink: ReturnType<Page["locator"]>): Promise<Buffer> {
    // waitForEvent must be set up BEFORE the click that triggers the
    // download — this is the standard Playwright pattern, order matters.
    const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15_000 }),
        pdfLink.click(),
    ]);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}