import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { readFileSync } from "fs";
import { config } from "./config";
import { recoverOrphanedJobsOnStartup } from "./queue/lock";
import { startQueueWatcher } from "./queue/listener";
import { runJob } from "./worker";
import { browserManager } from "./browser/browserManager";

initializeApp({
    credential: cert(JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"))),
});

async function main() {
    console.log("[index] Starting Highmark automation worker...");

    await recoverOrphanedJobsOnStartup();

    const workerId = `worker-${process.pid}-${Date.now()}`;
    const stopWatching = startQueueWatcher(workerId, runJob);

    const shutdown = async () => {
        console.log("[index] Shutting down...");
        stopWatching();
        await browserManager.shutdown();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main();