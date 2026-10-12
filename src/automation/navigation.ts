import { Locator, Page } from "playwright";

/**
 * Clicks something that triggers a full page navigation and waits until the
 * NEW document has actually loaded.
 *
 * A bare `click()` returns as soon as the click is dispatched — the old page
 * is still in the DOM for a moment, so anything read right after it (or a
 * `page.reload()` fired right after it) can hit the previous page instead of
 * the one we navigated to. The listener is set up BEFORE the click so a fast
 * navigation can't slip past it.
 */
export async function clickAndWaitForNavigation(
    page: Page,
    target: Locator,
    { timeoutMs = 30_000, optional = false }: { timeoutMs?: number; optional?: boolean } = {}
): Promise<void> {
    const navigated = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: timeoutMs,
    });
    try {
        await target.click();
    } catch (err) {
        navigated.catch(() => {}); // don't leave an unhandled rejection behind
        throw err;
    }

    try {
        await navigated;
    } catch (err) {
        // `optional`: the click succeeded but no navigation followed (e.g. the
        // site handled it in-page). Only the WAIT is optional — click
        // failures above always throw.
        if (!optional) throw err;
        console.warn(`[navigation] No navigation within ${timeoutMs}ms after click — continuing`);
        return;
    }
    await page.waitForLoadState("domcontentloaded");
}
