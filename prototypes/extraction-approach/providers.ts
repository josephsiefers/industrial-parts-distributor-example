// PROTOTYPE, throwaway. Thin adapters over the two official SDKs, roughly the
// LlmProvider shape from docs/research/llm-structured-output-and-documents.md §5.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

export type ProviderName = "anthropic" | "openai";

export interface StepResult {
  model: string;
  ok: boolean;
  reason?: "refusal" | "truncated" | "schema_parse_failed" | "api_error";
  detail?: string;
  data?: unknown;
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens: number };
  latencyMs: number;
  costUsd?: number;
  note?: string;
}

// $ per million tokens (input, output), from the research doc §3.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "gpt-6.1-sol": [2, 10],
  "gpt-6-luna": [0.1, 0.5],
};
const cost = (model: string, u?: StepResult["usage"]) => {
  const p = PRICES[model];
  return p && u ? (u.inputTokens * p[0] + u.outputTokens * p[1]) / 1e6 : undefined;
};

export const MODELS: Record<ProviderName, { mid: string; cheap: string }> = {
  anthropic: { mid: "claude-sonnet-5-5", cheap: "claude-haiku-5-5" },
  openai: { mid: "gpt-6.1-sol", cheap: "gpt-6-luna" },
};

export interface StructuredReq {
  model: string;
  system: string;
  text: string;
  schema: z.ZodObject;
  schemaName: string;
}

export type Provider = (req: StructuredReq) => Promise<StepResult>;

const isEffortError = (e: unknown) => /effort/i.test(String((e as Error)?.message ?? e));

export function anthropicProvider(): Provider {
  const client = new Anthropic();
  return async function call(req, withEffort = true): Promise<StepResult> {
    const t0 = performance.now();
    try {
      const res = await client.messages.parse({
        model: req.model,
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: "user", content: req.text }],
        output_config: { format: zodOutputFormat(req.schema), ...(withEffort ? { effort: "low" as const } : {}) },
      });
      const latencyMs = performance.now() - t0;
      const usage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        reasoningTokens: (res.usage as any).output_tokens_details?.thinking_tokens ?? 0,
      };
      const base = { model: req.model, stopReason: res.stop_reason ?? undefined, usage, latencyMs, costUsd: cost(req.model, usage) };
      if (res.stop_reason === "refusal") return { ...base, ok: false, reason: "refusal" };
      if (res.stop_reason === "max_tokens") return { ...base, ok: false, reason: "truncated" };
      return { ...base, ok: true, data: res.parsed_output, note: withEffort ? undefined : "effort param rejected; ran without it" };
    } catch (e: any) {
      if (withEffort && isEffortError(e)) return (call as any)(req, false);
      const latencyMs = performance.now() - t0;
      const reason = e?.status ? "api_error" : "schema_parse_failed";
      return { model: req.model, ok: false, reason, detail: String(e?.message ?? e), latencyMs };
    }
  } as Provider;
}

export function openaiProvider(): Provider {
  const client = new OpenAI();
  return async function call(req, withEffort = true): Promise<StepResult> {
    const t0 = performance.now();
    try {
      const res = await client.responses.parse({
        model: req.model,
        max_output_tokens: 16000,
        input: [
          { role: "system", content: req.system },
          { role: "user", content: req.text },
        ],
        text: { format: zodTextFormat(req.schema, req.schemaName) },
        ...(withEffort ? { reasoning: { effort: "low" as const } } : {}),
      });
      const latencyMs = performance.now() - t0;
      const u: any = res.usage;
      const usage = {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
      };
      const base = { model: req.model, stopReason: res.status ?? undefined, usage, latencyMs, costUsd: cost(req.model, usage) };
      const refusal = res.output
        .flatMap((o: any) => (o.type === "message" ? o.content : []))
        .find((c: any) => c.type === "refusal");
      if (refusal) return { ...base, ok: false, reason: "refusal", detail: (refusal as any).refusal };
      if (res.status === "incomplete") return { ...base, ok: false, reason: "truncated", detail: JSON.stringify(res.incomplete_details) };
      return { ...base, ok: true, data: res.output_parsed, note: withEffort ? undefined : "effort param rejected; ran without it" };
    } catch (e: any) {
      if (withEffort && isEffortError(e)) return (call as any)(req, false);
      const latencyMs = performance.now() - t0;
      const reason = e?.status ? "api_error" : "schema_parse_failed";
      return { model: req.model, ok: false, reason, detail: String(e?.message ?? e), latencyMs };
    }
  } as Provider;
}
