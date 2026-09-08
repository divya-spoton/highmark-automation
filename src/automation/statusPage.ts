import { Page } from "playwright";
import { dismissStayLoggedInPopup } from "./login";

export interface ExpectedApplicant {
    firstName: string;
    lastName: string;
    dob: string; // DD/MM/YYYY, as submitted
}

interface RowSnapshot {
    reportId: string;
    memberName: string;
    dob: string | null;
    hasPdfReady: boolean;
    pdfLocator: ReturnType<Page["locator"]>;
}

/** Call this BEFORE fillAndSubmitInquiryForm, to know what "new" means. */
export async function getCurrentTopReportId(page: Page): Promise<string | null> {
    await navigateToStatusPage(page);
    const top = await readTopRow(page);
    return top?.reportId ?? null;
}

async function readTopRow(page: Page): Promise<RowSnapshot | null> {
    const rows = page.locator("#cust tbody tr");
    if ((await rows.count()) === 0) return null;

    const row = rows.first();
    const cells = row.locator("td");

    const reportId = (await cells.nth(0).innerText()).trim();
    const memberName = (await cells.nth(7).innerText()).trim();

    // The Inquiry Details cell's content lives in a tooltip <span> that's
    // hidden until hover (class="info" pattern) — innerText() respects
    // visibility and will return "" for it, so use textContent() instead.
    const detailsText = (await cells.nth(6).textContent()) ?? "";
    const dobMatch = detailsText.match(/Dob\s*:\s*([\d-]{8,10})/);
    const dob = dobMatch ? dobMatch[1] : null;

    const pdfLocator = row.locator("a", { has: page.locator("img[alt='PDF Report']") });
    const hasPdfReady = (await pdfLocator.count()) > 0;

    return { reportId, memberName, dob, hasPdfReady, pdfLocator };
}

function normalizeNameTokens(name: string): string[] {
    return name
        .toUpperCase()
        .replace(/\b(MR|MRS|MS|SHRI|SMT)\b/g, "")
        .split(/\s+/)
        .filter(Boolean)
        .sort();
}

function namesMatch(portalName: string, expected: ExpectedApplicant): boolean {
    const a = normalizeNameTokens(portalName);
    const b = normalizeNameTokens(`${expected.firstName} ${expected.lastName}`);
    const overlap = a.filter((t) => b.includes(t));
    // Require at least 2 overlapping tokens (or all of them, if the name is
    // a single word) — a single shared common word (e.g. two "Sethi"s) is
    // not enough to trust with a financial document.
    return overlap.length >= Math.min(2, b.length);
}

function dobMatches(portalDob: string | null, expectedDob: string): boolean {
    if (!portalDob) return true; // portal leaves this blank sometimes — don't hard-fail on absence
    const [d, m, y] = expectedDob.split("/");
    const normalized = `${d.padStart(2, "0")}-${m.padStart(2, "0")}-${y}`;
    return portalDob === normalized;
}

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

export async function pollAndDownloadReport(
    page: Page,
    expected: ExpectedApplicant,
    baselineReportId: string | null
): Promise<Buffer> {
    await navigateToStatusPage(page);

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        console.log(`[statusPage] Poll attempt ${attempt}/${MAX_POLL_ATTEMPTS}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissStayLoggedInPopup(page);

        const top = await readTopRow(page);

        if (!top) {
            console.log("[statusPage] No rows in table yet");
        } else if (top.reportId === baselineReportId) {
            console.log(`[statusPage] Top row (${top.reportId}) unchanged from baseline — our submission hasn't landed yet`);
        } else if (!namesMatch(top.memberName, expected)) {
            // The top row changed, but it's not our submission. This should
            // never happen if the submit actually went through — surfacing
            // it loudly rather than downloading a stranger's report.
            throw new Error(
                `[statusPage] New top row "${top.reportId}" ("${top.memberName}") does not match expected applicant "${expected.firstName} ${expected.lastName}" — refusing to download. This almost certainly means the inquiry submission failed silently.`
            );
        } else if (!dobMatches(top.dob, expected.dob)) {
            throw new Error(
                `[statusPage] Top row "${top.reportId}" matched by name but DOB "${top.dob}" != expected "${expected.dob}" — refusing to download as a precaution.`
            );
        } else if (top.hasPdfReady) {
            console.log(`[statusPage] Verified match on "${top.memberName}" (${top.reportId}) — downloading`);
            return await downloadPdf(page, top.pdfLocator);
        } else {
            console.log(`[statusPage] Correct row ("${top.memberName}", ${top.reportId}) found, PDF not generated yet`);
        }

        if (attempt < MAX_POLL_ATTEMPTS) {
            await page.waitForTimeout(POLL_INTERVAL_MS);
        }
    }

    throw new Error(
        `[statusPage] No matching, ready report for "${expected.firstName} ${expected.lastName}" after ${MAX_POLL_ATTEMPTS} attempts — either Highmark is delayed, or the submission never went through. Not downloading anything.`
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