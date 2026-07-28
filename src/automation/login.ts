import { Page } from "playwright";
import { config } from "../config";
import { solveCaptcha } from "./captcha";

/**
 * - No `ensure_logged_in` / "stay logged in" handling. That existed in the
 *   Selenium version because it reused ONE browser across many jobs and
 *   had to detect/recover an existing session. Here, every job gets a
 *   fresh context (browserManager.ts), so every job starts fully logged
 *   out — there is no prior session to detect or recover. Simpler by
 *   construction, not by omission.
 *
 * - Retries the whole login attempt (including a fresh captcha) up to
 *   MAX_ATTEMPTS times, because a wrong captcha guess is the single most
 *   likely failure mode here and it's recoverable by just trying again
 *   with a new captcha image — not something that should fail the entire
 *   job on attempt 1.
 *
 * - If Gemini can't solve it after MAX_ATTEMPTS,
 *   we throw — the job gets marked failed and alerted on, per the queue
 *   design, rather than hanging forever waiting for stdin nobody will type into.
 *
 * - Success is verified explicitly by checking the URL after submit,
 *   never assumed just because "the click didn't throw."
 */

const MAX_ATTEMPTS = 3;

export async function login(page: Page): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[login] Attempt ${attempt}/${MAX_ATTEMPTS}`);

        await page.goto(config.highmark.loginUrl, { waitUntil: "domcontentloaded" });

        await page.fill("#username", config.highmark.username);
        await page.fill("#password", config.highmark.password);

        // Screenshot the captcha element directly into memory — no temp file,
        const captchaImage = await page.locator("#captchaId").screenshot();
        const captchaText = await solveCaptcha(captchaImage);

        await page.fill("#captchavalue", captchaText);
        await page.click("#loginButton");

        // Give the page a moment to navigate, then check where we actually landed.
        // waitForURL with a timeout means we don't hang indefinitely if the site
        // is slow or the login silently did nothing.
        const succeeded = await page
            .waitForURL(config.highmark.homePageUrl, { timeout: 10_000 })
            .then(() => true)
            .catch(() => false);

        if (succeeded) {
            console.log("[login] Success");
            return;
        }

        console.warn(`[login] Attempt ${attempt} failed (wrong captcha or slow login)`);
    }

    throw new Error(`[login] Failed to log in after ${MAX_ATTEMPTS} attempts`);
}