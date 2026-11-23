"use client";

/**
 * Turns an uploaded CSV / XLSX file or pasted text into { phone, name } rows.
 * Parsing happens in the browser; the server re-validates every number.
 */
export interface RawRow {
  phone: string;
  name?: string;
}

const PHONE_HEADERS = /^(phone|phone ?number|mobile|mobile ?number|cell|tel|telephone|number|contact ?number|msisdn|whatsapp)$/i;
const NAME_HEADERS = /^(name|full ?name|contact ?name|first ?name|customer|customer ?name)$/i;
const looksLikePhone = (v: string) => /^[+(]?[\d\s().-]{6,}$/.test(v.trim());

function fromTable(table: string[][]): RawRow[] {
  const rows = table.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some(Boolean));
  if (!rows.length) return [];
  const header = rows[0];
  let phoneCol = header.findIndex((h) => PHONE_HEADERS.test(h));
  let nameCol = header.findIndex((h) => NAME_HEADERS.test(h));
  let body = rows;
  if (phoneCol >= 0) {
    body = rows.slice(1);
  } else {
    // No recognised header: use the first column that looks like phone numbers.
    const sample = rows.slice(0, 20);
    phoneCol = Math.max(0, header.findIndex((_, i) => sample.filter((r) => looksLikePhone(r[i] ?? "")).length >= Math.ceil(sample.length / 2)));
    if (!looksLikePhone(rows[0][phoneCol] ?? "")) body = rows.slice(1); // first row was a header we didn't recognise
    nameCol = nameCol >= 0 ? nameCol : header.findIndex((_, i) => i !== phoneCol && !looksLikePhone(rows[1]?.[i] ?? rows[0][i] ?? "") && (rows[1]?.[i] ?? rows[0][i]));
  }
  return body
    .map((r) => ({ phone: r[phoneCol] ?? "", name: nameCol >= 0 ? r[nameCol] || undefined : undefined }))
    .filter((r) => r.phone);
}

export async function parseFile(file: File): Promise<RawRow[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error("That file is larger than 10 MB. Split it into smaller files.");
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    const data = await readSheet(file);
    return fromTable(data.map((row) => row.map((c) => (c == null ? "" : String(c)))));
  }
  if (name.endsWith(".csv") || name.endsWith(".txt") || file.type === "text/csv") {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    return fromTable(parsed.data);
  }
  if (name.endsWith(".xls")) throw new Error("Old .xls files aren't supported. In Excel, use File → Save As → .xlsx or .csv.");
  throw new Error("Upload a .csv or .xlsx file.");
}

/** Pasted text: one contact per line, either "phone" or "name, phone" / "phone, name" (comma, tab or semicolon). */
export function parsePasted(text: string): RawRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
      const phone = parts.find(looksLikePhone) ?? parts[0];
      const name = parts.find((p) => p !== phone);
      return { phone, name };
    });
}
