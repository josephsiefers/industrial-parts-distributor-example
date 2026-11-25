// PROTOTYPE, throwaway. The three extraction approaches being compared.
import { PROMPTS, wrapEmail } from "./prompts.ts";
import { MODELS, type Provider, type ProviderName, type StepResult } from "./providers.ts";
import { Classify, OneCall, PurchaseOrder, PurchaseOrderWithUncertainties, type Classification, type Uncertainty } from "./schema.ts";

export interface Email { from: string; subject: string; bodyText: string }

export interface VariantOutcome {
  classification: Classification | null;
  classificationReason: string | null;
  purchaseOrder: PurchaseOrder | null;
  uncertainties: Uncertainty[] | null; // null = variant doesn't ask for them
  steps: Array<{ step: string } & StepResult>;
}

export const VARIANTS = {
  A: "One call (mid model): classify + extract in one schema",
  B: "Classify (cheap model), then extract (mid model)",
  C: "Classify (cheap model), then extract + self-reported uncertainties (mid model)",
} as const;
export type VariantId = keyof typeof VARIANTS;

export async function runVariant(id: VariantId, providerName: ProviderName, call: Provider, email: Email): Promise<VariantOutcome> {
  const text = wrapEmail(email);
  const m = MODELS[providerName];

  if (id === "A") {
    const r = await call({ model: m.mid, system: PROMPTS.oneCall, text, schema: OneCall, schemaName: "one_call" });
    const d = r.data as any;
    return {
      classification: d?.classification ?? null,
      classificationReason: d?.classificationReason ?? null,
      purchaseOrder: d?.purchaseOrder ?? null,
      uncertainties: null,
      steps: [{ step: "one_call", ...r }],
    };
  }

  const c = await call({ model: m.cheap, system: PROMPTS.classify, text, schema: Classify, schemaName: "classify" });
  const cd = c.data as any;
  const out: VariantOutcome = {
    classification: cd?.classification ?? null,
    classificationReason: cd?.reason ?? null,
    purchaseOrder: null,
    uncertainties: null,
    steps: [{ step: "classify", ...c }],
  };
  if (cd?.classification?.toLowerCase() !== "purchase_order") return out;

  const withU = id === "C";
  const x = await call({
    model: m.mid,
    system: withU ? PROMPTS.extractWithUncertainties : PROMPTS.extract,
    text,
    schema: withU ? PurchaseOrderWithUncertainties : PurchaseOrder,
    schemaName: withU ? "purchase_order_with_uncertainties" : "purchase_order",
  });
  out.steps.push({ step: "extract", ...x });
  if (x.ok && x.data) {
    const { uncertainties, ...po } = x.data as any;
    out.purchaseOrder = po;
    out.uncertainties = withU ? uncertainties ?? [] : null;
  }
  return out;
}
