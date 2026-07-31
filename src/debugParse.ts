import { writeFileSync } from "fs";
import { PDFParse } from "pdf-parse";
import { parseHighmarkPdf } from "./parsing/highmarkParser";
import { readFileSync } from "fs";

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error("Usage: npx tsx src/debugParse.ts <path-to-pdf>");
        process.exit(1);
    }

    // to get the raw text
    // v2 API: pass the file path string directly — PDFParse handles reading it
    // const parser = new PDFParse({ url: filePath });
    // const { text } = await parser.getText();

    // to test the parsing
    const buffer = readFileSync(filePath);
    const parsedData = await parseHighmarkPdf(buffer);

    const outputPath = "./output"

    const outPath = outputPath.replace(/\.pdf$/i, "_raw.txt");
    writeFileSync(outPath, JSON.stringify(parsedData, null, 2), "utf-8");
    console.log(`Raw text written to ${outPath}`);
}

main();
