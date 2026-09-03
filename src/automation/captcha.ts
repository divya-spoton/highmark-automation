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

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const CAPTCHA_PROMPT =
    "This image contains a distorted text captcha (letters and/or digits). " +
    "Respond with ONLY the captcha text, exactly as shown, no spaces, no punctuation, " +
    "no explanation, nothing else.";

// Highmark's captcha is letters-only—
// adjust this if you confirm it sometimes includes digits.
const PLAUSIBLE_CAPTCHA = /^[A-Za-z0-9]{4,8}$/;

export async function solveCaptcha(imageBuffer: Buffer): Promise<string> {
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            temperature: 0, // deterministic reading of a fixed image, not creative generation
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: CAPTCHA_PROMPT },
                        {
                            type: "image_url",
                            image_url: { url: `data:image/png;base64,${base64Image}` },
                        },
                    ],
                },
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "captcha_response",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: { captchaText: { type: "string" } },
                        required: ["captchaText"],
                        additionalProperties: false,
                    },
                },
            },
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "<unreadable body>");
        throw new Error(`[captcha] OpenAI API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content;
    if (!rawText) throw new Error("[captcha] OpenAI response had no content");

    let candidate: string;
    try {
        candidate = JSON.parse(rawText).captchaText?.trim();
    } catch {
        throw new Error(`[captcha] OpenAI response wasn't valid JSON: "${rawText}"`);
    }

    if (!candidate || !PLAUSIBLE_CAPTCHA.test(candidate)) {
        throw new Error(`[captcha] OpenAI returned an implausible captcha value: "${candidate}"`);
    }
    return candidate;
}