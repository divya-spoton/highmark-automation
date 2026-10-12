import { Page } from "playwright";
import { dismissStayLoggedInPopup } from "./login";
import { clickAndWaitForNavigation } from "./navigation";

export interface ExpectedApplicant {
    firstName: string;
    lastName: string;
    dob: string; // DD/MM/YYYY, as submitted
}

interface RowSnapshot {
    reportId: string;
    memberName: string;
    dob: string | null;
    status: string;
    requestedAt: number | null; // epoch ms, parsed from the Date:Time column (IST)
    hasPdfReady: boolean;
    pdfLocator: ReturnType<Page["locator"]>;
}

export interface StatusPageCheck {
    /** A recent, non-failed row for this applicant that is already on the portal — reuse it instead of submitting. */
    existingReportId: string | null;
    /** Every report ID visible before we (maybe) submit — anything not in here afterwards is new. */
    knownReportIds: Set<string>;
}

/**
 * How old an existing report on the status page may be and still be reused
 * instead of paying for a fresh inquiry. Covers the "previous attempt
 * submitted but failed to download, job was requeued" case, which is exactly
 * what was burning duplicate inquiries.
 */
const REUSE_MAX_AGE_HOURS = 24;

const FAILED_STATUS_PATTERN = /fail|error|reject|invalid/i;

/**
 * Call this BEFORE fillAndSubmitInquiryForm. Opens the status page and
 * (a) looks for a report for this applicant that already exists, so the
 * caller can skip submitting entirely, and (b) records every report ID
 * currently listed, so a new one can be told apart after submission.
 */
export async function checkStatusPage(page: Page, expected: ExpectedApplicant): Promise<StatusPageCheck> {
    await navigateToStatusPage(page);
    const rows = await readAllRows(page);
    const knownReportIds = new Set(rows.map((r) => r.reportId));

    const existing = findApplicantRow(rows, expected, (r) => isRecent(r) && !FAILED_STATUS_PATTERN.test(r.status));
    if (existing) {
        console.log(
            `[statusPage] Pre-check: existing report for "${existing.memberName}" (${existing.reportId}, status "${existing.status}") found — reusing it, NOT submitting a new inquiry`
        );
    } else {
        const top = rows[0] ? `top: ${rows[0].reportId} "${rows[0].memberName}"` : "table empty";
        console.log(
            `[statusPage] Pre-check: no existing report for "${expected.firstName} ${expected.lastName}" among ${rows.length} row(s) (${top}) — a new inquiry is needed`
        );
    }

    return { existingReportId: existing?.reportId ?? null, knownReportIds };
}

async function readAllRows(page: Page): Promise<RowSnapshot[]> {
    const rows = page.locator("#cust tbody tr");
    const count = await rows.count();
    const snapshots: RowSnapshot[] = [];

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const cells = row.locator("td");
        if ((await cells.count()) < 8) continue; // "nothing found" placeholder row, or similar

        const reportId = (await cells.nth(0).innerText()).trim();
        const dateTime = (await cells.nth(1).innerText()).trim();
        const memberName = (await cells.nth(7).innerText()).trim();

        // Status and Inquiry Details text live in tooltip <span>s that are
        // hidden until hover (class="info" pattern) — innerText() respects
        // visibility and returns "" for them, so use textContent() instead.
        const status = ((await cells.nth(2).textContent()) ?? "").trim();
        const detailsText = (await cells.nth(6).textContent()) ?? "";
        const dobMatch = detailsText.match(/Dob\s*:\s*([\d-]{8,10})/);
        const dob = dobMatch ? dobMatch[1] : null;

        const pdfLocator = row.locator("a", { has: page.locator("img[alt='PDF Report']") });
        const hasPdfReady = (await pdfLocator.count()) > 0;

        snapshots.push({ reportId, memberName, dob, status, requestedAt: parsePortalDateTime(dateTime), hasPdfReady, pdfLocator });
    }

    return snapshots;
}

/** "12/10/2026 12:59 PM" (DD/MM/YYYY, portal time = IST) → epoch ms. */
function parsePortalDateTime(text: string): number | null {
    const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    const [, d, mo, y, h, min, ampm] = m;
    let hour = Number(h) % 12;
    if (ampm.toUpperCase() === "PM") hour += 12;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${String(hour).padStart(2, "0")}:${min}:00+05:30`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
}

function isRecent(row: RowSnapshot): boolean {
    // Unparseable date → don't reuse; paying for a fresh report beats
    // handing back one of unknown age.
    if (row.requestedAt === null) return false;
    return Date.now() - row.requestedAt <= REUSE_MAX_AGE_HOURS * 60 * 60 * 1000;
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
 * Newest row matching this applicant by name AND DOB (plus any extra
 * filter). Scans the whole table rather than trusting the top row: the
 * table's order isn't something we control, and a single unexpected row on
 * top used to fail the job outright — which then got requeued and paid for
 * a second inquiry.
 */
function findApplicantRow(
    rows: RowSnapshot[],
    expected: ExpectedApplicant,
    filter: (row: RowSnapshot) => boolean = () => true
): RowSnapshot | null {
    const matches = rows.filter((r) => namesMatch(r.memberName, expected) && dobMatches(r.dob, expected.dob) && filter(r));
    // Stable sort: rows with equal/unknown times keep table order (newest first).
    matches.sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
    return matches[0] ?? null;
}

/**
 * Highmark takes some time to generate the report. This polls the
 * "Single Request Status" page until the applicant's row has a
 * downloadable PDF, then downloads it.
 *
 * - Every poll re-opens the page through the menu instead of
 *   `page.reload()`. Reload raced the menu click's navigation (reloading
 *   the previous page, so we saw "no rows" while the real page had them,
 *   or crashed with "Not attached to an active page"), and reloading a
 *   page that was the result of a form POST risks re-submitting it.
 *
 * - The row we want is identified by name + DOB, and either a specific
 *   report ID (when reusing an existing report) or "not in the set of
 *   report IDs seen before we submitted". Unrelated rows are ignored, not
 *   treated as fatal.
 *
 * - Uses Playwright's `page.waitForEvent('download')` around the click,
 *   so the PDF bytes come straight back in memory — no Downloads folder
 *   watching.
 */
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20; // 20 × 30s = 10 minutes total

export async function pollAndDownloadReport(
    page: Page,
    expected: ExpectedApplicant,
    target: { reportId: string } | { knownReportIds: Set<string> }
): Promise<Buffer> {
    const pick = (rows: RowSnapshot[]) =>
        "reportId" in target
            ? findApplicantRow(rows, expected, (r) => r.reportId === target.reportId)
            : findApplicantRow(rows, expected, (r) => !target.knownReportIds.has(r.reportId));

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        console.log(`[statusPage] Poll attempt ${attempt}/${MAX_POLL_ATTEMPTS}`);
        await navigateToStatusPage(page);

        const rows = await readAllRows(page);
        const row = pick(rows);

        if (rows.length === 0) {
            console.log("[statusPage] No rows in table yet");
        } else if (!row) {
            console.log(`[statusPage] ${rows.length} row(s) listed, none for "${expected.firstName} ${expected.lastName}" yet (top: ${rows[0].reportId} "${rows[0].memberName}")`);
        } else if (row.hasPdfReady) {
            console.log(`[statusPage] Verified match on "${row.memberName}" (${row.reportId}) — downloading`);
            return await downloadPdf(page, row.pdfLocator);
        } else if (FAILED_STATUS_PATTERN.test(row.status)) {
            throw new Error(`[statusPage] Highmark reports status "${row.status}" for "${row.memberName}" (${row.reportId}) — no report to download.`);
        } else {
            console.log(`[statusPage] Correct row ("${row.memberName}", ${row.reportId}, status "${row.status}") found, PDF not generated yet`);
        }

        if (attempt < MAX_POLL_ATTEMPTS) {
            await page.waitForTimeout(POLL_INTERVAL_MS);
        }
    }

    throw new Error(
        `[statusPage] No matching, ready report for "${expected.firstName} ${expected.lastName}" after ${MAX_POLL_ATTEMPTS} attempts — either Highmark is delayed, or the submission never went through. Not downloading anything. If you requeue, the worker will pick up the report from the status page if it appears, rather than submitting again.`
    );
}

async function navigateToStatusPage(page: Page): Promise<void> {
    await dismissStayLoggedInPopup(page);

    const consumerBureau = page.locator(".consumerbureau");
    await consumerBureau.waitFor({ state: "visible", timeout: 10_000 });

    // Step 1: hover Consumer Bureau to reveal "Single Request" / "Track Request"
    await consumerBureau.hover();

    // Step 2: find and hover "Track Request" to reveal the Single Request Status submenu
    const trackRequest = consumerBureau.locator("a", { hasText: "Track Request" });
    await trackRequest.hover();

    // Step 3: click "Single Request Status" and wait for THAT page to load —
    // reading the table before this resolves reads the previous page.
    const link = consumerBureau.locator("a", { hasText: "Single Request Status" });
    await clickAndWaitForNavigation(page, link);
    await dismissStayLoggedInPopup(page);

    // The results table is server-rendered, but give it a moment; an
    // account with no requests may legitimately have no table at all.
    await page.locator("#cust").waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
        console.warn("[statusPage] #cust table not found on status page");
    });
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
