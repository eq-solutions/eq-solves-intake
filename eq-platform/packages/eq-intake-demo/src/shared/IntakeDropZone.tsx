/**
 * IntakeDropZone — the ONE drop zone for the consolidated Intake screen.
 *
 * Drop (or click to pick) any SimPRO export. Each sheet is parsed +
 * classified by the shared useIntakeBundle hook; this component just renders
 * the zone and the list of what landed ("looks like customers — 92% sure").
 * The destination is chosen separately, below, so the same dropped files can
 * go Into EQ or out to Xero/MYOB/etc. without re-dropping.
 */

import { useRef, useState, type CSSProperties, type DragEvent, type JSX } from "react";
import { roleLabel, type IntakeBundle } from "./intake-bundle.js";

// ---------------------------------------------------------------------------
// Tokens (mirror CSS variables for computed states)
// ---------------------------------------------------------------------------
const SKY  = "#3DA8D8";
const DEEP = "#2986B4";
const ICE  = "#EAF5FB";
const INK  = "#1A1A2E";

// ---------------------------------------------------------------------------
// Entity chip colours
// ---------------------------------------------------------------------------
const ENTITY_CHIP: Record<string, { bg: string; text: string; label: string }> = {
  customer: { bg: "#EAF5FB", text: "#2986B4", label: "Customers" },
  site:     { bg: "#F5F3FF", text: "#6D28D9", label: "Sites" },
  contact:  { bg: "#EEF2FF", text: "#4338CA", label: "Contacts" },
  staff:    { bg: "#FFFBEB", text: "#B45309", label: "Staff" },
  licence:  { bg: "#ECFDF5", text: "#065F46", label: "Licences" },
  asset:    { bg: "#F0FDF4", text: "#166534", label: "Assets" },
};

function EntityChip({ role }: { role: string }): JSX.Element {
  const chip = ENTITY_CHIP[role];
  if (!chip) {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 8px", borderRadius: 999,
        background: "#F4F4F8", color: "#6B7280",
        fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
      }}>
        Unknown
      </span>
    );
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px", borderRadius: 999,
      background: chip.bg, color: chip.text,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
    }}>
      {chip.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Upload icon SVG
// ---------------------------------------------------------------------------
function UploadIcon({ size = 32, color = DEEP }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
const spinnerStyle: CSSProperties = {
  width: 16, height: 16, borderRadius: 999,
  border: `2px solid ${ICE}`,
  borderTopColor: DEEP,
  animation: "eq-spin 0.7s linear infinite",
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function IntakeDropZone({ bundle }: { bundle: IntakeBundle }): JSX.Element {
  const { slots, busy, ingestFiles, removeSlot } = bundle;
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void ingestFiles(files);
  };

  const hasFiles = slots.length > 0;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Drop target */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop a file or click to pick"
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
        style={{
          border: `2px dashed ${dragOver ? SKY : "#D1E9F5"}`,
          background: dragOver ? ICE : hasFiles ? "#FAFCFE" : "white",
          padding: hasFiles ? "14px 20px" : "40px 20px",
          borderRadius: 12,
          textAlign: "center",
          cursor: "pointer",
          transition: "border-color 0.15s, background 0.15s, padding 0.2s",
          userSelect: "none",
        }}
      >
        {busy && slots.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: DEEP, fontSize: 14 }}>
            <span style={spinnerStyle} />
            Reading file…
          </div>
        ) : hasFiles ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, color: DEEP }}>
            <UploadIcon size={16} color={DEEP} />
            Drop another file, or click to pick
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}>
              <div style={{
                width: 52, height: 52, borderRadius: 12,
                background: ICE, display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <UploadIcon size={26} color={DEEP} />
              </div>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK, marginBottom: 4 }}>
              Drop a SimPRO file here
            </div>
            <div style={{ fontSize: 13, color: INK, opacity: 0.5 }}>
              CSV or Excel · We work out what it is
            </div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) void ingestFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      {/* File slot cards */}
      {slots.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map((slot, i) => {
            const isUnknown = slot.role === "unknown";
            const conf = slot.confidence != null && !isUnknown
              ? Math.round(slot.confidence * 100)
              : null;
            const lowConf = conf != null && conf < 70;

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  background: "white",
                  border: `1px solid ${isUnknown ? "#FECACA" : lowConf ? "#FDE68A" : "#D1E9F5"}`,
                  borderRadius: 10,
                }}
              >
                {/* Classification chip */}
                <div style={{ flexShrink: 0 }}>
                  {isUnknown ? (
                    <span style={{
                      display: "inline-flex", alignItems: "center",
                      padding: "2px 8px", borderRadius: 999,
                      background: "#FEF2F2", color: "#DC2626",
                      fontSize: 11, fontWeight: 600,
                    }}>
                      Unknown
                    </span>
                  ) : (
                    <EntityChip role={slot.role} />
                  )}
                </div>

                {/* File info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
                      {slot.file.name}
                    </span>
                    {slot.sheet?.sheetName && slot.sheet.sheetName !== "Sheet1" && (
                      <span style={{ fontSize: 11, color: DEEP }}>
                        [{slot.sheet.sheetName}]
                      </span>
                    )}
                    {slot.sheet && (
                      <span style={{ fontSize: 11, color: INK, opacity: 0.45 }}>
                        {slot.sheet.rows.length.toLocaleString()} rows
                      </span>
                    )}
                    {conf != null && (
                      <span style={{ fontSize: 11, color: lowConf ? "#B45309" : INK, opacity: lowConf ? 1 : 0.45, fontWeight: lowConf ? 600 : 400 }}>
                        {conf}% confident
                      </span>
                    )}
                  </div>
                  {slot.error && (
                    <div style={{ fontSize: 12, color: "#DC2626", marginTop: 2 }}>
                      {slot.error}
                    </div>
                  )}
                  {lowConf && (
                    <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>
                      Low confidence — does this look right?
                    </div>
                  )}
                  {isUnknown && !slot.error && (
                    <div style={{ fontSize: 12, color: "#DC2626", marginTop: 2 }}>
                      Couldn't classify this file — check the column headers.
                    </div>
                  )}
                </div>

                {/* Remove */}
                <button
                  type="button"
                  onClick={() => removeSlot(i)}
                  disabled={busy}
                  aria-label={`Remove ${slot.file.name}`}
                  style={{
                    flexShrink: 0,
                    width: 28, height: 28,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    borderRadius: 6,
                    background: "transparent",
                    border: "1px solid transparent",
                    color: INK, opacity: 0.35,
                    cursor: busy ? "not-allowed" : "pointer",
                    fontSize: 16, lineHeight: 1,
                    transition: "opacity 0.1s, border-color 0.1s",
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.opacity = "1"; (e.target as HTMLButtonElement).style.borderColor = "#E5E7EB"; }}
                  onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.opacity = "0.35"; (e.target as HTMLButtonElement).style.borderColor = "transparent"; }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
