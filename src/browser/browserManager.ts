// src/browser/browserManager.ts
import { chromium, Browser, BrowserContext } from "playwright";
import { config } from "../config";

const RESTART_AFTER_N_JOBS = 25;

export class BrowserManager {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private jobsSinceRestart = 0;

    /**
     * Returns the SAME context every call. Session reuse is safe here because every job authenticates
     * as the same single Highmark account; there's no per-customer login to
     * keep isolated. Still forces a periodic full recycle (new browser, new
     * context, forced relogin) every N jobs as a defensive reset
     */
    async getSessionContext(): Promise<BrowserContext> {
        await this.ensureRunning();

        this.jobsSinceRestart += 1;
        if (this.jobsSinceRestart > RESTART_AFTER_N_JOBS) {
            console.log(`[browserManager] Hit ${RESTART_AFTER_N_JOBS} jobs — recycling`);
            await this.recycle();
            await this.ensureRunning();
        }

        return this.context!;
    }

    private async ensureRunning(): Promise<void> {
        if (this.browser?.isConnected() && this.context) return;

        console.log("[browserManager] Launching Chromium + session context...");
        this.browser = await chromium.launch({
            headless: config.dryRun ? false : true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        this.browser.on("disconnected", () => {
            console.warn("[browserManager] Browser disconnected unexpectedly");
            this.browser = null;
            this.context = null;
        });
        this.context = await this.browser.newContext({ viewport: { width: 1366, height: 768 } });
    }

    /** Forces a fresh browser + context (and therefore a forced relogin
     *  next job) — used both by the periodic counter above and by login.ts
     *  if a session recovery attempt fails outright. */
    async recycle(): Promise<void> {
        await this.context?.close().catch(() => { });
        await this.browser?.close().catch(() => { });
        this.browser = null;
        this.context = null;
        this.jobsSinceRestart = 0;
    }

    async shutdown(): Promise<void> {
        await this.recycle();
    }
}

export const browserManager = new BrowserManager();