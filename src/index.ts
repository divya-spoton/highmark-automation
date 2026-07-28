import { chromium } from "playwright";

async function main() {
    const browser = await chromium.launch({ headless: false }); // headed, so you SEE it
    const page = await browser.newPage();
    await page.goto("https://example.com");
    console.log(await page.title());
    await browser.close();
}

main();