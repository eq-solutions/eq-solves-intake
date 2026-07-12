/**
 * XLSX reader.
 *
 * Turns an XLSX file (Buffer / Uint8Array / ArrayBuffer) into one ParsedSheet
 * per worksheet. Each sheet's headers are auto-detected — real spreadsheets
 * often have a title row, blank row, then headers, so we walk down from row 0
 * to find the first row that looks like column headers.
 *
 * Each ParsedSheet has rows as Record<string, unknown>[] keyed by detected
 * header names — exactly the same shape as parseCsv() returns. Downstream
 * consumers (@eq/validation, the orchestrator, the confirm UI) don't need
 * to care whether the source was CSV or XLSX.
 *
 * Behaviour:
 *   - Reads .xlsx and .xlsm (OOXML zip archives) via ExcelJS.
 *   - Legacy .xls (BIFF compound-document) support was DROPPED in the ExcelJS
 *     migration (2026-07-11): ExcelJS reads OOXML only, not the old binary
 *     format. Such files are rejected with a clear error rather than parsed.
 *     (We moved off SheetJS/`xlsx@0.18.5` because it carries unpatched
 *     prototype-pollution + ReDoS advisories on the untrusted-upload path.)
 *   - One ParsedSheet returned per worksheet in workbook order.
 *   - Skips hidden sheets by default (override with includeHidden).
 *   - Header row auto-detected: first row with >= 2 non-empty cells where
 *     the next row also has data. Override with opts.headerRowIndex.
 *   - Excel date cells come back as Date objects, so coerceDate downstream
 *     sees a parseable input.
 *   - Numbers and booleans come through as their native JS types. The
 *     downstream coercers happily accept either.
 *   - Empty rows (every cell blank) are skipped.
 *
 * Out of scope for v1:
 *   - Merged-cell unwrapping. Merged cells in the header row will show as
 *     one populated cell and the rest empty — works fine for most exports.
 *   - Formula re-evaluation. Cells with formulas come through with their
 *     last-saved cached value, which is what every real consumer wants.
 *   - Streaming for huge files. v1 loads the whole workbook into memory.
 */

import ExcelJS from "exceljs";
import type { ParsedSheet, ParseMeta, CsvRow } from "./csv.js";

export interface ParsedWorkbook {
  /** One entry per worksheet (in workbook order). */
  sheets: ParsedXlsxSheet[];
  /** Top-level metadata about the file. */
  meta: WorkbookMeta;
}

export interface ParsedXlsxSheet extends ParsedSheet {
  /** 0-based index of the row used as the header. */
  headerRowIndex: number;
  /** True if this sheet was marked hidden in Excel. */
  hidden: boolean;
}

export interface WorkbookMeta {
  /** Count of sheets in the workbook (including hidden, before any filtering). */
  totalSheets: number;
  /** Count of sheets returned (after filtering). */
  returnedSheets: number;
  /** Format detected from the file's leading bytes. */
  format: string;
}

export interface ParseXlsxOptions {
  /**
   * If supplied, only this sheet is parsed. Useful when the caller already
   * knows which sheet of a multi-tab workbook is relevant.
   */
  sheetName?: string;
  /**
   * Force a specific header row (0-based). Default: auto-detect.
   */
  headerRowIndex?: number;
  /**
   * Include hidden sheets in the result. Default false.
   */
  includeHidden?: boolean;
  /**
   * Max number of rows to scan when auto-detecting the header. Default 20.
   * Real spreadsheets virtually never bury the header more than a few rows in.
   */
  headerScanLimit?: number;
}

/**
 * Parse an XLSX workbook into ParsedSheets.
 */
export async function parseXlsx(
  input: Buffer | Uint8Array | ArrayBuffer,
  opts: ParseXlsxOptions = {},
): Promise<ParsedWorkbook> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input as ArrayBufferLike);

  // ExcelJS reads OOXML (.xlsx/.xlsm) only. Reject a legacy .xls BIFF
  // compound-document up front with a clear message — SheetJS used to handle
  // it, but it was dropped with the xlsx@0.18.5 removal (see file header).
  if (isBiffCompoundDocument(bytes)) {
    throw new Error(
      "Legacy .xls (BIFF) files are no longer supported — re-save as .xlsx and try again.",
    );
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(bytes));

  const worksheets = workbook.worksheets;
  const totalSheets = worksheets.length;
  const includeHidden = opts.includeHidden ?? false;
  const scanLimit = opts.headerScanLimit ?? 20;

  const targetSheets = opts.sheetName
    ? worksheets.filter((ws) => ws.name === opts.sheetName)
    : worksheets;

  const sheets: ParsedXlsxSheet[] = [];

  for (const worksheet of targetSheets) {
    const sheetName = worksheet.name;

    // ExcelJS records visibility on worksheet.state
    // ("visible" | "hidden" | "veryHidden"). Default visible.
    const hidden = worksheet.state === "hidden" || worksheet.state === "veryHidden";
    if (hidden && !includeHidden) continue;

    // Pull all cells as a dense 0-based 2D array so we can detect the header
    // row — the same shape SheetJS's sheet_to_json({ header: 1 }) produced.
    const aoa = worksheetToAoa(worksheet);

    const headerRowIndex = opts.headerRowIndex ?? detectHeaderRow(aoa, scanLimit);

    const headerRaw = (aoa[headerRowIndex] ?? []) as unknown[];
    const headerRow = headerRaw.map((c, i) => normaliseHeader(c, i));

    const dataRows: CsvRow[] = [];
    let emptyRowsSkipped = 0;
    for (let r = headerRowIndex + 1; r < aoa.length; r++) {
      const row = aoa[r] ?? [];
      if (rowIsEmpty(row)) {
        emptyRowsSkipped++;
        continue;
      }
      const obj: CsvRow = {};
      for (let c = 0; c < headerRow.length; c++) {
        const key = headerRow[c]!;
        const cell = row[c];
        obj[key] = normaliseCell(cell);
      }
      dataRows.push(obj);
    }

    const meta: ParseMeta = {
      encoding: "binary",
      delimiter: "xlsx",
      totalRows: dataRows.length,
      emptyRowsSkipped,
      malformedRows: 0,
      // xlsx reader doesn't currently produce per-row malformed diagnostics —
      // SheetJS shape doesn't error per cell the way Papa Parse does. Empty
      // array satisfies the shared ParseMeta contract added 2026-05-19; future
      // work can populate this for empty rows or type mismatches.
      malformed: [],
      bomDetected: false,
    };

    sheets.push({
      sheetName,
      headerRow,
      rows: dataRows,
      meta,
      headerRowIndex,
      hidden,
    });
  }

  return {
    sheets,
    meta: {
      totalSheets,
      returnedSheets: sheets.length,
      format: detectFormat(bytes),
    },
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Turn an ExcelJS worksheet into a dense, 0-based array-of-arrays — one entry
 * per cell in the sheet's used range, blank cells as null. This reproduces the
 * shape SheetJS's `sheet_to_json(ws, { header: 1, defval: null, blankrows: true,
 * raw: true })` returned, so the header-detection + row-building logic below is
 * unchanged.
 */
function worksheetToAoa(worksheet: ExcelJS.Worksheet): unknown[][] {
  const rowCount = worksheet.rowCount;
  const colCount = worksheet.columnCount;
  const aoa: unknown[][] = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = worksheet.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      // Merged cells: SheetJS emitted the value only in the top-left cell and
      // null for the covered ("slave") cells; ExcelJS instead REPEATS the master
      // value into every cell of the merge range. Null the slaves here to keep
      // parity — otherwise a merged banner/title row (1 non-empty cell to SheetJS)
      // reads as several non-empty cells and detectHeaderRow can mis-pick it as
      // the header row.
      if (cell.isMerged && cell.master !== cell) {
        cells.push(null);
      } else {
        cells.push(cellValueToRaw(cell.value));
      }
    }
    aoa.push(cells);
  }
  return aoa;
}

/**
 * Flatten an ExcelJS cell value to the raw JS value SheetJS used to hand back:
 * primitives and Dates pass through; formula cells yield their cached result;
 * rich-text / hyperlink cells yield their text; empty cells become null.
 */
function cellValueToRaw(value: ExcelJS.CellValue | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;

  if (t === "object") {
    const obj = value as unknown as Record<string, unknown>;
    // Formula cell: { formula, result } — use the cached result (cellFormula off).
    if ("result" in obj) return cellValueToRaw(obj.result as ExcelJS.CellValue);
    if ("formula" in obj) return null;
    // Rich text: { richText: [{ text }, ...] }
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    // Hyperlink: { text, hyperlink }
    if ("text" in obj) return obj.text ?? null;
    // Error cell: { error }
    if ("error" in obj) return null;
  }
  return value;
}

/** Copy a Uint8Array into a standalone ArrayBuffer for ExcelJS's loader. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** True if the bytes are a legacy .xls OLE2/BIFF compound document (D0 CF 11 E0). */
function isBiffCompoundDocument(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

/** A row is empty if every cell is null, undefined, or whitespace-only string. */
function rowIsEmpty(row: unknown[]): boolean {
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    if (typeof cell === "string" && cell.trim() === "") continue;
    return false;
  }
  return true;
}

/**
 * Auto-detect the header row. Heuristic:
 *   1. Skip leading empty rows.
 *   2. The first row with >= 2 non-empty cells, where the row below also has
 *      at least one non-empty cell, is the header.
 *   3. Tie-break: prefer rows that are mostly strings (typical of headers).
 *
 * Returns 0 if the heuristic finds nothing — the caller still gets a result,
 * it just uses row 0 as headers (which is usually correct for clean files).
 */
function detectHeaderRow(aoa: unknown[][], scanLimit: number): number {
  const limit = Math.min(aoa.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    const row = aoa[i] ?? [];
    const nonEmpty = row.filter(
      (c) => c !== null && c !== undefined && !(typeof c === "string" && c.trim() === ""),
    );
    if (nonEmpty.length < 2) continue;

    // Look ahead — is there a non-empty row after this?
    const next = aoa[i + 1] ?? [];
    if (rowIsEmpty(next)) continue;

    // Bias toward rows with mostly string cells (real headers).
    const stringRatio = nonEmpty.filter((c) => typeof c === "string").length / nonEmpty.length;
    if (stringRatio >= 0.5) return i;
  }
  // Fallback: first non-empty row.
  for (let i = 0; i < limit; i++) {
    if (!rowIsEmpty(aoa[i] ?? [])) return i;
  }
  return 0;
}

/** Normalise a header cell to a clean string column name. Empty → "col_N". */
function normaliseHeader(cell: unknown, index: number): string {
  if (cell === null || cell === undefined) return `col_${index + 1}`;
  const s = String(cell).trim();
  return s === "" ? `col_${index + 1}` : s;
}

/**
 * Normalise a data cell to a value the downstream coercers understand.
 * Dates come through as Date objects (cellDates: true) — we leave them as
 * Date so coerceDate can recognise them.
 */
function normaliseCell(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return cell;
  if (typeof cell === "string") return cell.trim();
  return cell;
}

/** Best-effort format guess from the leading bytes (mostly informational). */
function detectFormat(bytes: Uint8Array): string {
  if (bytes.length < 4) return "unknown";
  // XLSX/XLSM (ZIP archive): PK\x03\x04
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "xlsx";
  }
  // Legacy XLS (compound document): D0 CF 11 E0
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return "xls";
  }
  return "unknown";
}
