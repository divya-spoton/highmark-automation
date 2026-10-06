// src/automation/login.ts
import { BrowserContext, Page } from "playwright";
import { config } from "../config";
import { solveCaptcha } from "./captcha";
import { browserManager } from "../browser/browserManager";

const MAX_CAPTCHA_ATTEMPTS = 3;
const LOGGED_IN_SELECTOR = "a[href='/Inquiry/Inquiry/Logout_input.action']";
const STAY_LOGGED_IN_SELECTOR = ".stayLogged_button";

/**
 * after some minutes logged in, Highmark shows a "session expiring, stay
 * logged in?" popup on whatever page you're currently on. If ignored, it
 * auto-logs-out to Logout_input.action. This must be checked BEFORE the
 * logout-link check below — a popup sitting on top of the page is a
 * DIFFERENT state from either "logged in cleanly" or "logged out," and
 * needs handling on its own rather than being conflated with either.
 */
export async function dismissStayLoggedInPopup(page: Page): Promise<void> {
    const stayLoggedButton = page.locator(STAY_LOGGED_IN_SELECTOR);
    const isVisible = await stayLoggedButton.isVisible().catch(() => false);
    if (isVisible) {
        console.log("[login] Session-expiry popup detected — clicking 'stay logged in'");
        await stayLoggedButton.click();
        await page.waitForTimeout(2_000); // give the page a moment to process continueSession() and settle
    }
}

/**
 * Checks for a concrete DOM signal that can only exist when actually
 * logged in — NOT just a URL comparison, since a popup, modal, or
 * unexpected interstitial could leave you on the "right" URL without
 * actually being in a usable logged-in state (or vice versa).
 * Short timeout because we're not willing to wait long for something
 * that should already be there if it's there at all.
 */
async function isLoggedIn(page: Page): Promise<boolean> {
    await dismissStayLoggedInPopup(page);
    return page
        .locator(LOGGED_IN_SELECTOR)
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
}

/**
 * Public entry point. Two layers of retry, deliberately different in kind:
 *
 * - INNER (inside performLogin): retries a wrong captcha guess a few
 *   times — the expected, routine failure mode, recoverable by just
 *   trying again on the same page.
 *
 * - OUTER (here): if performLogin fails outright even after its inner
 *   retries — meaning something structurally wrong happened, like a
 *   stuck popup, unexpected navigation, or a crashed page state — we
 *   don't keep hammering the same broken page. We recycle the ENTIRE
 *   browser/context (fresh start, no leftover popup/modal state can
 *   possibly survive that) and attempt the whole login flow one more
 *   time. Only if that also fails do we give up and let the job fail —
 *   which is correct: at that point something is either genuinely down
 *   on Highmark's side, or credentials are wrong, and no amount of
 *   retrying in-process will fix that. A human needs the alert.
 */
export async function ensureLoggedIn(): Promise<Page> {
    try {
        return await attemptEnsureLoggedIn();
    } catch (err) {
        console.warn("[login] First attempt failed structurally, recycling browser and retrying once:", err);
        await browserManager.recycle();
        return await attemptEnsureLoggedIn(); // if this throws too, it propagates to worker.ts as a real job failure
    }
}

async function attemptEnsureLoggedIn(): Promise<Page> {
    const context = await browserManager.getSessionContext();
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(config.highmark.homePageUrl, { waitUntil: "domcontentloaded" });

    if (await isLoggedIn(page)) {
        console.log("[login] Existing session still valid");
        return page;
    }

    console.log("[login] Not logged in — performing login");
    await performLogin(page);

    // Verify AFTER login too — don't just trust that submit succeeded
    // because waitForURL resolved. Same signal, same reason: URL alone
    // isn't proof.
    if (!(await isLoggedIn(page))) {
        throw new Error("[login] Login submitted but logged-in signal never appeared");
    }

    return page;
}

async function performLogin(page: Page): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
        console.log(`[login] Attempt ${attempt}/${MAX_CAPTCHA_ATTEMPTS}`);

        try {
            // "load" (not "domcontentloaded"): the button-enabling script
            // (checkFormValidity + whatever else initializes this page)
            // isn't guaranteed to have finished running just because the
            // HTML has been parsed. Giving it the full load event reduces
            // — though per the comment below, doesn't by itself eliminate —
            // the chance we act before that script is ready.
            await page.goto(config.highmark.loginUrl, { waitUntil: "load" });
            await page.fill("#username", config.highmark.username);
            await page.fill("#password", config.highmark.password);

            const captchaImage = await page.locator("#captchaId").screenshot();
            const captchaText = await solveCaptcha(captchaImage);
            await page.fill("#captchavalue", captchaText);

            // #loginButton starts `disabled` in the markup. Highmark's own
            // JS enables it via checkFormValidity(), wired to onkeyup on
            // #username and #password ONLY — #captchavalue has no such
            // handler at all (confirmed from the page's source). Since
            // captcha is necessarily the last field we fill, nothing ever
            // re-runs that check afterward, so the button stays disabled no
            // matter how the fields are filled (page.fill(), real
            // keystrokes, whatever) — this part is a permanent gap in fill
            // order vs. the one thing that triggers the check, not a timing
            // fluke. Call the site's own validator directly instead of
            // relying on it firing implicitly.
            //
            // Wait for the function to exist first: if Highmark's own JS
            // hasn't finished initializing yet (see "load" comment above),
            // calling it too early is a silent no-op, not an error.
            await page
                .waitForFunction(() => typeof (window as unknown as { checkFormValidity?: unknown }).checkFormValidity === "function", undefined, {
                    timeout: 10_000,
                })
                .catch(() => console.warn("[login] window.checkFormValidity never appeared — Highmark's login page JS may have changed or failed to load"));

            await page.evaluate(() => {
                const fn = (window as unknown as { checkFormValidity?: () => void }).checkFormValidity;
                if (typeof fn === "function") fn();
            });

            // Fast, clearly-labeled failure if the above didn't actually
            // enable it, instead of a bare 30s click timeout with no
            // diagnostic.
            await page
                .waitForFunction(
                    () => !(document.querySelector("#loginButton") as HTMLInputElement | null)?.disabled,
                    undefined,
                    { timeout: 5_000 }
                )
                .catch(() =>
                    console.warn("[login] #loginButton still disabled 5s after calling checkFormValidity() — clicking anyway (will likely time out)")
                );

            await page.click("#loginButton");

            // Wait a beat for the page to settle, then let isLoggedIn
            // (checked by the caller) be the real judge — this inner check
            // just decides whether to retry the captcha or not.
            await page.waitForTimeout(2_000);
            if (await isLoggedIn(page)) {
                console.log("[login] Success");
                return;
            }

            console.warn(`[login] Attempt ${attempt} failed`);
        } catch (err) {
            // IMPORTANT: this catch is what makes MAX_CAPTCHA_ATTEMPTS mean
            // what it says. Without it, a page.click()/waitForFunction
            // timeout (or any other Playwright action timeout) throws past
            // this loop on the very first attempt, and the caller's single
            // browser-recycle retry becomes the ONLY other chance — 2 real
            // attempts total instead of the intended 3+1. A thrown timeout
            // here almost always means "this specific page load was bad,"
            // which the next loop iteration's fresh page.goto() is exactly
            // positioned to recover from.
            console.warn(`[login] Attempt ${attempt} threw:`, err instanceof Error ? err.message : err);
        }
    }

    throw new Error(`[login] Failed after ${MAX_CAPTCHA_ATTEMPTS} captcha attempts`);
}