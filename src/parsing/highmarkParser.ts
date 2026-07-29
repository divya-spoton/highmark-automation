import pdfParse from "pdf-parse";

/**
 * Ports Parsers.py's regex extraction logic to TypeScript. Structure
 * kept deliberately close to the original (same section-splitting
 * approach, same regexes) since these were tuned against real Highmark
 * PDF output — this isn't the place to "improve" the parsing logic
 * without a real PDF to test against; it's a straight port.
 *
 * Design decisions vs. Parsers.py:
 *
 * - Takes a Buffer directly (the in-memory PDF bytes from
 *   pollAndDownloadReport), not a file path — same reasoning as the
 *   captcha/download Buffers discussed above. `pdf-parse` (the Node
 *   equivalent of pypdf) accepts a Buffer natively.
 *
 * - getSection's original Python (`text.split(section)[1]...`) throws an
 *   unhelpful IndexError if `section` isn't found at all (e.g. Highmark
 *   changed their PDF's wording). Ported version below throws a clear,
 *   named error instead — "which section couldn't be found" is much
 *   more useful in a log than a generic index-out-of-bounds message,
 *   especially since this is exactly the kind of thing that silently
 *   breaks if Highmark ever changes their report template.
 *
 * - No `print()` debug statements carried over (the reference code prints
 *   the extracted data at several points) — proper logging happens at
 *   the call site in worker.ts once, not scattered through parsing
 *   internals.
 */

export interface HighmarkClientDetails {
  name?: string;
  date_of_birth?: string;
  Age?: string;
  gender?: string;
  father_name?: string;
  spouse_name?: string;
  mother_name?: string;
  phone_number?: string;
  id?: string;
  id_type?: string;
  email_id?: string;
}

export interface HighmarkScore {
  name?: string;
  rangeStart?: string;
  rangeEnd?: string;
  score?: string;
}

export interface HighmarkExtractedData {
  user_details: HighmarkClientDetails;
  attributes: Record<string, string>;
  score: HighmarkScore;
}

function getSection(text: string, section: string, nextSection: string): string {
  const afterSection = text.split(section);
  if (afterSection.length < 2) {
    throw new Error(`[highmarkParser] Section "${section}" not found in PDF text — Highmark's report format may have changed`);
  }
  const remainder = afterSection[1];
  const beforeNext = remainder.split(nextSection);
  if (beforeNext.length < 2) {
    throw new Error(`[highmarkParser] Section "${nextSection}" not found after "${section}" — Highmark's report format may have changed`);
  }
  return beforeNext[0];
}

function getPerformanceAttributes(text: string): Record<string, string> {
  const section = getSection(text, "Perform Attributes", "Personal Info Variations");
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);

  const attributes: Record<string, string> = {};
  const pairPattern = /([A-Z][A-Z0-9\- ]*?)\s*:\s*([\d,.]*)(?=[A-Z]|$)/g;

  for (const line of lines) {
    const pairs = [...line.matchAll(pairPattern)];
    if (pairs.length > 0) {
      for (const match of pairs) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key) attributes[key] = value;
      }
    } else {
      attributes[line] = "";
    }
  }
  return attributes;
}

function getScore(text: string): HighmarkScore {
  const section = getSection(text, "CRIF HM Score(S):", "Score Trend");
  const match = section.match(/([A-Z\s]+?[\d.]+)(\d{3})-(\d{3})(\d{3})/);
  if (!match) return {};

  return {
    name: match[1].trim(),
    rangeStart: match[2],
    rangeEnd: match[3],
    score: match[4],
  };
}

function getClientDetails(text: string): HighmarkClientDetails {
  const section = getSection(text, "Inquiry Input Information", "CRIF HM Score(S)");
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);

  const data: HighmarkClientDetails = {};

  const line1Match = lines[0]?.match(/Name: (.*)DOB\/Age:([\d-]+) Gender:(.*)/);
  if (line1Match) {
    data.name = line1Match[1].trim();
    const dobOrAge = line1Match[2].trim();
    if (dobOrAge.includes("-") || dobOrAge.includes("/")) {
      data.date_of_birth = dobOrAge;
    } else {
      data.Age = dobOrAge;
    }
    data.gender = line1Match[3].trim();
  }

  const line2Match = lines[1]?.match(/Father:(.*)Spouse:(.*)Mother:(.*)/);
  if (line2Match) {
    data.father_name = line2Match[1].trim();
    data.spouse_name = line2Match[2].trim();
    data.mother_name = line2Match[3].trim();
  }

  const line3Match = lines[2]?.match(
    /Phone Numbers:(.*)ID\(s\):\s*([a-zA-Z]{5}[0-9]{4}[a-zA-Z]|[0-9]{14})\s*\[(.*)\]\s*Email ID\(s\):(.*)/
  );
  if (line3Match) {
    data.phone_number = line3Match[1].trim();
    data.id = line3Match[2].trim();
    data.id_type = line3Match[3].trim().toLowerCase();
    data.email_id = line3Match[4].trim();
  }

  return data;
}

export async function parseHighmarkPdf(pdfBuffer: Buffer): Promise<HighmarkExtractedData> {
  const { text: rawText } = await pdfParse(pdfBuffer);

  // Matches Parsers.py's parse_pdf_text: truncate at "Disclaimer" per page.
  // pdf-parse concatenates all pages into one string already, so we apply
  // the same cut once across the whole text rather than per-page.
  const text = rawText.split("Disclaimer")[0];

  return {
    user_details: getClientDetails(text),
    attributes: getPerformanceAttributes(text),
    score: getScore(text),
  };
}