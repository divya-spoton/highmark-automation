import { PDFParse } from "pdf-parse";

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
  /** Full extracted text — summarised by the onHighmarkReportParsed Cloud Function. */
  raw_text: string;
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

// Sentinel used to mark where the per-page Disclaimer/footer boilerplate
// was stripped out of the Perform Attributes section, so the line-
// reconstruction loop knows never to bridge a wrapped key across that gap.
const PAGE_BREAK_MARKER = "\u0000PAGEBREAK\u0000";

function getPerformanceAttributes(text: string): Record<string, string> {
  const section = getSection(text, "Perform Attributes", "Personal Info Variations");

  // This section legitimately spans a page break, so CRIF's repeated
  // per-page footer (Disclaimer paragraph through the "-- N of M --"
  // marker) lands inside it. Replace it with a marker rather than
  // deleting it outright
  const withMarker = section.replace(/Disclaimer:[\s\S]*?-- \d+ of \d+ --/g, PAGE_BREAK_MARKER);
  const rawLines = withMarker.split("\n").map((l) => l.trim()).filter(Boolean);

  // Reconstruct logical lines: CRIF wraps long attribute keys mid-name at
  // a hyphen (e.g. "NEW-DELINQ-ACCOUNT-IN-LAST-SIX-" / "MONTHS: 0"). A
  // physical line with no colon yet that ends in "-" is an incomplete key
  // continued on the next physical line — join with no separator, since
  // the hyphen is already the correct join point.
  const logicalLines: string[] = [];
  let buffer = "";
  for (const line of rawLines) {
    if (line === PAGE_BREAK_MARKER) {
      if (buffer) {
        // Key was mid-wrap exactly where the page break was stripped.
        // Per (3) above, its true continuation is not recoverable from
        // plain reading-order text — log and drop rather than risk
        // fusing it to an unrelated attribute that happens to follow.
        console.warn(`[highmarkParser] getPerformanceAttributes: key truncated at page break, value unrecoverable (Phase A known gap): "${buffer}"`);
        buffer = "";
      }
      continue;
    }
    buffer = buffer ? buffer + line : line;
    const hasColon = buffer.includes(":");
    const endsWithHyphen = buffer.endsWith("-");
    if (hasColon || !endsWithHyphen) {
      logicalLines.push(buffer);
      buffer = "";
    }
  }
  if (buffer) logicalLines.push(buffer); // flush any trailing incomplete buffer

  const attributes: Record<string, string> = {};
  const pairPattern = /([A-Z][A-Z0-9\- ]*?)\s*:\s*([\d,.]*)(?=[A-Z]|$)/g;

  for (const line of logicalLines) {
    const pairs = [...line.matchAll(pairPattern)];

    if (pairs.length === 0) {
      // Report format changed in a way our line-reconstruction didn't
      // anticipate. Log it and move on rather than aborting the whole
      // parse — the rest of the attributes are still good, and this
      // surfaces in logs instead of silently vanishing or corrupting
      // the Firestore doc with a garbage key.
      console.warn(`[highmarkParser] getPerformanceAttributes: unmatched line, skipped: "${line}"`);
      continue;
    }

    for (const match of pairs) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!key || !value) continue; // blank per Highmark — omit rather than write ""
      if (key in attributes) {
        // Same reasoning: don't let a second write silently clobber the
        // first with no trace of it happening.
        console.warn(`[highmarkParser] getPerformanceAttributes: duplicate key "${key}" — overwriting "${attributes[key]}" with "${value}"`);
      }

      attributes[key] = value;
    }

  }
  return attributes;
}

function getScore(text: string): HighmarkScore {
  // "Verification" (not "Score Trend") because it's present in BOTH the
  // scored and no-score report layouts — "Score Trend" only exists when
  // there's an actual score
  const section = getSection(text, "CRIF HM Score(S):", "Verification");

  // The real extracted text has tab/space gaps in BOTH places the old
  // regex assumed zero gap: between the score-name's version number and
  // the range, and between the range and the score itself
  // (e.g. "PERFORM CONSUMER 2.2 \t300-900 \t672"). Treat these as three
  // whitespace-separated fields instead of one contiguous digit run.
  const match = section.match(/([A-Z0-9. ]+?)\s+(\d{3})-(\d{3})\s+(\d{3})/);

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

  const setIfPresent = <K extends keyof HighmarkClientDetails>(field: K, value: string) => {
    const trimmed = value.trim();
    if (trimmed) data[field] = trimmed;
  };


  const line1Match = lines[0]?.match(/Name: (.*)DOB\/Age:(.*?)Gender:(.*)/);
  if (line1Match) {
    setIfPresent("name", line1Match[1]);
    const dobOrAge = line1Match[2].trim();
    if (dobOrAge.includes("-") || dobOrAge.includes("/")) {
      setIfPresent("date_of_birth", dobOrAge);
    } else {
      setIfPresent("Age", dobOrAge);
    }
    setIfPresent("gender", line1Match[3]);
  } else {
    console.warn(`[highmarkParser] getClientDetails: line1 didn't match expected format: "${lines[0]}"`);
  }


  const line2Match = lines[1]?.match(/Father:(.*)Spouse:(.*)Mother:(.*)/);
  if (line2Match) {
    setIfPresent("father_name", line2Match[1]);
    setIfPresent("spouse_name", line2Match[2]);
    setIfPresent("mother_name", line2Match[3]);
  } else {
    console.warn(`[highmarkParser] getClientDetails: line2 didn't match expected format: "${lines[1]}"`);
  }

  const line3Match = lines[2]?.match(
    /Phone Numbers:(.*)ID\(s\):\s*([a-zA-Z]{5}[0-9]{4}[a-zA-Z]|[0-9]{14})\s*\[(.*)\]\s*Email ID\(s\):(.*)/
  );
  if (line3Match) {
    setIfPresent("phone_number", line3Match[1]);
    setIfPresent("id", line3Match[2]);
    setIfPresent("id_type", line3Match[3].toLowerCase());
    setIfPresent("email_id", line3Match[4]);
  } else {
    console.warn(`[highmarkParser] getClientDetails: line3 didn't match expected format: "${lines[2]}"`);
  }

  return data;
}

export async function parseHighmarkPdf(pdfBuffer: Buffer): Promise<HighmarkExtractedData> {
  // v2 API: pass raw PDF bytes via the `data` property.
  // PDFParse's constructor explicitly handles Buffer → Uint8Array conversion.
  const parser = new PDFParse({ data: pdfBuffer });
  let text: string;
  try {
    ({ text } = await parser.getText());
  } finally {
    await parser.destroy();
  }

  return {
    user_details: getClientDetails(text),
    attributes: getPerformanceAttributes(text),
    score: getScore(text),
    raw_text: text,
  };
}