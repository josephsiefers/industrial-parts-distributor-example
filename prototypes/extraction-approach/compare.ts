// PROTOTYPE, throwaway. Pure comparison of an extracted Purchase Order against hand-written truth.
// Deliberately lenient (normalised text match is shown separately from exact): scoring strictness
// belongs to the "Eval metrics and harness" ticket, not here.
import type { PurchaseOrder } from "./schema.ts";

export type Match = "exact" | "normalised" | "mismatch";
export interface FieldResult { path: string; expected: unknown; actual: unknown; match: Match }

const norm = (s: string) => s.toLowerCase().replace(/[\s"'.,;:]+/g, " ").trim();

export function compareValue(expected: unknown, actual: unknown): Match {
  if (expected === actual) return "exact";
  if (typeof expected === "number" && typeof actual === "number") return Math.abs(expected - actual) < 0.005 ? "exact" : "mismatch";
  if (typeof expected === "string" && typeof actual === "string") {
    if (expected.trim() === actual.trim()) return "exact";
    if (norm(expected) === norm(actual)) return "normalised";
  }
  return "mismatch";
}

const HEADER = ["poNumber", "poDate", "requestedDeliveryDate", "customerAccountNumber", "shipToText", "billToText", "notes", "orderTotal"] as const;
const LINE = ["kind", "lineNumber", "description", "quantity", "uom", "unitPrice", "extendedPrice", "requestedDeliveryDate", "rawText"] as const;

const idString = (ids: { value: string; label: string }[] | undefined) =>
  (ids ?? []).map((i) => `${i.value} [${i.label}]`).sort().join(" | ");

export function comparePO(expected: PurchaseOrder | null, actual: PurchaseOrder | null): FieldResult[] {
  if (!expected || !actual) {
    return [{ path: "purchaseOrder", expected: expected ? "a Purchase Order" : null, actual: actual ? "a Purchase Order" : null, match: !expected && !actual ? "exact" : "mismatch" }];
  }
  const out: FieldResult[] = HEADER.map((f) => ({ path: f, expected: expected[f], actual: actual[f], match: compareValue(expected[f], actual[f]) }));
  out.push({ path: "lines.length", expected: expected.lines.length, actual: actual.lines.length, match: compareValue(expected.lines.length, actual.lines.length) });
  const n = Math.max(expected.lines.length, actual.lines.length);
  for (let i = 0; i < n; i++) {
    const e = expected.lines[i] as any, a = actual.lines[i] as any;
    const eIds = idString(e?.identifiers), aIds = idString(a?.identifiers);
    out.push({ path: `lines[${i}].identifiers`, expected: e ? eIds : undefined, actual: a ? aIds : undefined, match: e && a ? compareValue(eIds, aIds) : "mismatch" });
    for (const f of LINE) {
      out.push({ path: `lines[${i}].${f}`, expected: e?.[f], actual: a?.[f], match: e && a ? compareValue(e[f], a[f]) : "mismatch" });
    }
  }
  return out;
}

export const score = (rs: FieldResult[]) => ({
  exact: rs.filter((r) => r.match === "exact").length,
  normalised: rs.filter((r) => r.match === "normalised").length,
  total: rs.length,
});
