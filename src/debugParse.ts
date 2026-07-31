import { writeFileSync } from "fs";
import { PDFParse } from "pdf-parse";

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error("Usage: npx tsx src/debugParse.ts <path-to-pdf>");
        process.exit(1);
    }

    // v2 API: pass the file path string directly — PDFParse handles reading it
    const parser = new PDFParse({ url: filePath });
    const { text } = await parser.getText();

    const outPath = filePath.replace(/\.pdf$/i, "_raw.txt");
    writeFileSync(outPath, text, "utf-8");
    console.log(`Raw text written to ${outPath}`);
}

main();