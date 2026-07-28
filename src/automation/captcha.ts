// src/automation/captcha.ts
import { config } from "../config";

/**
 * - Takes the captcha image as an in-memory Buffer (what
 *   `page.locator(...).screenshot()` returns in login.ts) instead of a
 *   file path. No temp file to write, read, and clean up — one less
 *   thing that can fail (disk full, path collision between concurrent
 *   runs — not a real risk here since we're sequential, but no reason
 *   to introduce a file-based dependency when Buffers work directly).
 *
 * - Uses Gemini's REST API directly via fetch rather than a Python-style
 *   SDK wrapper class. Node's built-in fetch (Node 18+) is enough here;
 *   no need for an extra SDK dependency for a single call type.
 *
 * - Validates the response shape before returning it. A vision model can
 *   return an empty string, whitespace, or a refusal sentence instead of
 *   captcha text — filling that straight into the captcha field wastes
 *   a login attempt on a response that was never going to work. We
 *   check for a plausible captcha string shape and throw loudly instead,
 *   so login.ts's retry loop gets a real captcha exception, not a wasted
 *   attempt on garbage.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CAPTCHA_PROMPT =
    "This image contains a distorted text captcha (letters and/or digits). " +
    "Respond with ONLY the captcha text, exactly as shown, no spaces, no punctuation, " +
    "no explanation, nothing else.";

// Highmark's captcha is letters-only—
// adjust this if you confirm it sometimes includes digits.
const PLAUSIBLE_CAPTCHA = /^[A-Za-z0-9]{4,8}$/;

export async function solveCaptcha(imageBuffer: Buffer): Promise<string> {
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(`${GEMINI_URL}?key=${config.gemini.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: CAPTCHA_PROMPT },
                        { inline_data: { mime_type: "image/png", data: base64Image } },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "<unreadable body>");
        throw new Error(`[captcha] Gemini API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const rawText: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
        throw new Error("[captcha] Gemini response had no text content");
    }

    const candidate = rawText.trim();

    if (!PLAUSIBLE_CAPTCHA.test(candidate)) {
        throw new Error(`[captcha] Gemini returned an implausible captcha value: "${candidate}"`);
    }

    return candidate;
}