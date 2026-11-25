// PROTOTYPE, throwaway. PurchaseOrder copied verbatim from the
// "Purchase Order and Sales Order data model" decision (issue #2).
import { z } from "zod";

export const PurchaseOrderLine = z.object({
  kind: z.enum(["product", "charge", "comment"]),
  rawText: z.string().describe("The whole line exactly as written"),
  lineNumber: z.string().nullable(),
  identifiers: z.array(
    z.object({
      value: z.string(),
      label: z.string().describe('Column header or prefix as written, e.g. "Mfr#"; "" if none'),
    }),
  ),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  uom: z.string().nullable().describe("Unit of Measure exactly as written"),
  unitPrice: z.number().nullable(),
  extendedPrice: z.number().nullable(),
  requestedDeliveryDate: z.string().nullable().describe("As written; do not reformat"),
});

export const PurchaseOrder = z.object({
  poNumber: z.string().nullable(),
  poDate: z.string().nullable(),
  requestedDeliveryDate: z.string().nullable(),
  customerAccountNumber: z.string().nullable(),
  shipToText: z.string().nullable(),
  billToText: z.string().nullable(),
  notes: z.string().nullable(),
  orderTotal: z.number().nullable(),
  lines: z.array(PurchaseOrderLine),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

// Six non-PO classes from the "Synthetic dataset design" decision (issue #7).
export const Classification = z.enum([
  "purchase_order",
  "quote_request",
  "order_status_inquiry",
  "invoice_or_remittance",
  "po_acknowledgement",
  "out_of_office",
  "newsletter",
  "other",
]);
export type Classification = z.infer<typeof Classification>;

// --- Variant A: one call. Spends the 16th (last) nullable slot on purchaseOrder.
export const OneCall = z.object({
  classification: Classification,
  classificationReason: z.string().describe("One short sentence"),
  purchaseOrder: PurchaseOrder.nullable().describe("null unless classification is purchase_order"),
});

// --- Variants B and C, step 1: classify on a cheap model.
export const Classify = z.object({
  classification: Classification,
  reason: z.string().describe("One short sentence"),
});

// --- Variant C, step 2: extraction plus model self-report. No extra nullables.
export const Uncertainty = z.object({
  field: z.string().describe('Path of the field, e.g. "poNumber" or "lines[2].quantity"'),
  kind: z.enum(["ambiguous", "conflicting", "unreadable", "possibly_missing"]),
  note: z.string().describe("One short sentence quoting the text that caused it"),
});
export const PurchaseOrderWithUncertainties = PurchaseOrder.extend({
  uncertainties: z.array(Uncertainty),
});
export type Uncertainty = z.infer<typeof Uncertainty>;
