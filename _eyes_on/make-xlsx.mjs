// Builds a 3-sheet XLSX that mimics a real SimPRO-style multi-tab export.
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";

const wb = XLSX.utils.book_new();

XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["job_number", "client", "status"],
    ["J-001", "Acme Pty", "open"],
    ["J-002", "Beta Industries", "closed"],
    ["J-003", "Civic Health Network", "open"],
  ]),
  "Jobs",
);

XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["first_name", "last_name", "employment_type", "active"],
    ["James", "Patel", "employee", true],
    ["Sarah", "O'Brien", "subcontractor", true],
    ["Michael", "Henderson", "employee", true],
  ]),
  "Staff",
);

XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["metric", "value"],
    ["total_hours", 162],
    ["total_jobs", 8],
    ["total_revenue", 184500],
  ]),
  "Summary",
);

XLSX.writeFile(wb, "C:/Projects/eq-intake/_eyes_on/multi-sheet.xlsx");
console.log("wrote multi-sheet.xlsx");
