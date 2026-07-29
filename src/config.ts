/**
 * Centralizes required env vars and validates them at process startup,
 * not at first use. If HIGHMARK_USERNAME is missing, we want the worker
 * to refuse to start entirely — not launch fine, accept a job, and fail
 * three minutes into a Highmark session because a field was undefined.
 */

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

export const config = {
    highmark: {
        username: requireEnv("HIGHMARK_USERNAME"),
        password: requireEnv("HIGHMARK_PASSWORD"),
        loginUrl: "https://hub.crifhighmark.com/Inquiry/Inquiry/login.action",
        homePageUrl: "https://hub.crifhighmark.com/Inquiry/Inquiry/portalHome.action",
        creditType: process.env.HIGHMARK_CREDIT_TYPE ?? "CIR", // confirm actual value against the live <select> options
        creditAmount: Number(process.env.HIGHMARK_CREDIT_AMOUNT ?? 500000),
    },
    gemini: {
        apiKey: requireEnv("GEMINI_API_KEY"),
    },
    firebase: {
        serviceAccountPath: requireEnv("FIREBASE_SERVICE_ACCOUNT_PATH"),
    },
    dryRun: requireEnv("DRY_RUN") === "true",
};