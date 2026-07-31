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

        await page.goto(config.highmark.loginUrl, { waitUntil: "domcontentloaded" });
        await page.fill("#username", config.highmark.username);
        await page.fill("#password", config.highmark.password);

        const captchaImage = await page.locator("#captchaId").screenshot();
        const captchaText = await solveCaptcha(captchaImage);
        await page.fill("#captchavalue", captchaText);
        await page.click("#loginButton");

        // Wait a beat for the page to settle, then let isLoggedIn (checked by
        // the caller) be the real judge — this inner check just decides
        // whether to retry the captcha or not.
        await page.waitForTimeout(2_000);
        if (await isLoggedIn(page)) {
            console.log("[login] Success");
            return;
        }

        console.warn(`[login] Attempt ${attempt} failed`);
    }

    throw new Error(`[login] Failed after ${MAX_CAPTCHA_ATTEMPTS} captcha attempts`);
}