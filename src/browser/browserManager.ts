import { chromium, Browser, BrowserContext } from "playwright";

/**
 * Owns exactly one Chromium process for the lifetime of the worker.
 *
 * Design decisions:
 * - Browser launched ONCE, reused across jobs. Relaunching per job is slow
 *   (a few hundred ms to a couple seconds of pure startup cost) and pointless —
 *   the browser process itself holds no customer data between jobs.
 * - A fresh `context` per job is what actually gives you isolation: no
 *   cookies/session/cache leaking between customer A's run and customer B's.
 *   Every job gets its own context, and it is ALWAYS closed in a `finally`
 *   block by the caller (worker.ts) — this class doesn't do the closing
 *   itself, because the job logic (login/form-fill/download) is the thing
 *   that knows when it's actually done, including on the failure path.
 * - `jobsSinceRestart` forces a full browser process restart every N jobs,
 *   regardless of whether anything's gone wrong. This is deliberately
 *   defensive: even if a leak sneaks in somewhere we didn't catch, it can
 *   only accumulate for N jobs before getting wiped by a fresh process.
 * - `launch()` is idempotent and safe to call repeatedly — worker.ts calls
 *   `getContext()` before every job, and this class figures out internally
 *   whether the browser needs (re)launching.
 */

const RESTART_AFTER_N_JOBS = 25;

export class BrowserManager {
    private browser: Browser | null = null;
    private jobsSinceRestart = 0;

    /** Returns a ready-to-use, isolated context for one job. */
    async getContext(): Promise<BrowserContext> {
        await this.ensureBrowserRunning();

        this.jobsSinceRestart += 1;
        if (this.jobsSinceRestart > RESTART_AFTER_N_JOBS) {
            console.log(
                `[browserManager] Hit ${RESTART_AFTER_N_JOBS} jobs — recycling browser process`
            );
            await this.restart();
        }

        return this.browser!.newContext({
            // Highmark's portal is desktop-oriented; a realistic desktop viewport
            // avoids layout surprises vs. Playwright's small default viewport.
            viewport: { width: 1366, height: 768 },
        });
    }

    private async ensureBrowserRunning(): Promise<void> {
        if (this.browser && this.browser.isConnected()) {
            return;
        }
        console.log("[browserManager] Launching Chromium...");
        this.browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
            // --no-sandbox and --disable-dev-shm-usage are the standard pair needed
            // to run Chromium inside a Docker container reliably — Docker's default
            // /dev/shm size is small and the sandbox has issues under containerd,
            // so both flags are close to mandatory in this environment specifically
            // (not something you'd add running Playwright on your own laptop).
        });

        // If Chromium crashes outright (not just "job failed", the actual OS
        // process dying), `disconnected` fires. We don't try to be clever here —
        // just null it out so the NEXT getContext() call relaunches from scratch.
        this.browser.on("disconnected", () => {
            console.warn("[browserManager] Browser disconnected unexpectedly");
            this.browser = null;
        });
    }

    private async restart(): Promise<void> {
        if (this.browser) {
            await this.browser.close().catch((err) => {
                console.warn("[browserManager] Error closing browser during restart:", err);
            });
        }
        this.browser = null;
        this.jobsSinceRestart = 0;
        await this.ensureBrowserRunning();
    }

    /** Call this on process shutdown (SIGTERM/SIGINT) for a clean exit. */
    async shutdown(): Promise<void> {
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
    }
}

export const browserManager = new BrowserManager();