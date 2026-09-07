// src/utils/logger.ts
//
// Prefixes every console.log/warn/error call across the whole process with
// a timestamp, without touching the hundreds of existing call sites.
// Call installTimestampedLogging() ONCE, as early as possible, in any file
// that's run directly (index.ts, simulateJob.ts, manualTest.ts) — it only
// affects the process it's called in.

function timestamp(): string {
    return new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
}

export function installTimestampedLogging(): void {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args: any[]) => originalLog(`[${timestamp()}]`, ...args);
    console.warn = (...args: any[]) => originalWarn(`[${timestamp()}]`, ...args);
    console.error = (...args: any[]) => originalError(`[${timestamp()}]`, ...args);
}