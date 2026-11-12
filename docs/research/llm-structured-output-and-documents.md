# Claude and OpenAI: structured output and document input (TypeScript)

Researched 2026-11-12 for [Research: Claude and OpenAI structured output and document input in TypeScript](https://github.com/josephsiefers/industrial-parts-distributor-example/issues/4). Sources are the vendor docs and the published npm tarballs, which I unpacked and read. I made no live API calls (no keys in this environment), so nothing here has been tested against the APIs. Unverified points are marked **UNVERIFIED**.

## TL;DR

- **Both vendors now have generally available, grammar-constrained structured output with first-party Zod helpers.** Anthropic uses `client.messages.parse()` with `output_config: { format: zodOutputFormat(Schema) }` and reads `parsed_output`. OpenAI uses `client.responses.parse()` with `text: { format: zodTextFormat(Schema, "name") }` and reads `output_parsed`. Neither needs a beta header. When a request completes normally, both guarantee schema-valid JSON. Neither guarantees it on a refusal or when output hits the token limit.
- **A Zod schema shared between providers must follow the stricter rules of each.** OpenAI requires every field to be `required`, so its helper throws on `.optional()` without `.nullable()`. Anthropic caps a request at **16 union-typed parameters** (`.nullable()` creates a union) and **24 optional parameters**. It also rejects `min`/`max`/`minLength`/`maxLength`, although its SDK moves these into field descriptions and checks them locally. Design the Purchase Order schema to stay under these limits.
- **PDFs:** both providers accept PDFs natively and send the model both the extracted text and an image of each page. Anthropic allows 600 pages and 128 MB per request. OpenAI allows 50 MB per file and 50 MB per request.
- **Spreadsheets:** Anthropic doesn't accept XLSX, so it must be converted to text first. OpenAI accepts XLSX natively but runs it through an opaque "augmentation" step that reads the first 1,000 rows per sheet and adds a model-generated summary. **For a fair eval, convert XLSX to CSV/Markdown in our own code and send the same text to both providers.**
- **Models (the price tiers line up exactly):** Claude Sonnet 5.5 and GPT-6.1 Sol both cost $2 in / $10 out per million tokens. Claude Haiku 5.5 and GPT-6 Luna both cost $0.10 / $0.50. Every model in this list has a context window of about 1M tokens and a 128K output limit.
- **Recommendation:** write our own thin provider interface (one adapter of roughly 100–150 lines per vendor) on top of the two official SDKs, rather than using the Vercel AI SDK. Reasoning is in [section 5](#5-hand-rolled-interface-vs-vercel-ai-sdk).

## Versions checked (npm registry, 2026-11-12)

| Package | Version | Zod peer |
|---|---|---|
| `@anthropic-ai/sdk` | 1.8.0 | `^3.25.0 \|\| ^4.0.0` (the helper imports `zod/v4`) |
| `openai` | 7.56.0 | `^3.25 \|\| ^4.0` (the helper accepts `zod/v3`, `zod/v4`, and `zod/v4-mini`) |
| `ai` (Vercel AI SDK) | 7.0.171 | `^3.25.76 \|\| ^4.1.8` |
| `@ai-sdk/anthropic` / `@ai-sdk/openai` | 4.0.103 / 4.0.116 | n/a |
| `zod` | 4.6.7 | n/a |

Source: `npm view <pkg> version peerDependencies`. The helper source was read from the tarballs (`npm pack`): `@anthropic-ai/sdk/src/helpers/zod.ts`, `openai/helpers/zod.d.ts`, and `openai/lib/transform.js`.

---

## 1. Structured output

### 1a. Anthropic (Claude)

**Mechanism.** JSON output is requested with `output_config.format = { type: "json_schema", schema }`. Strict tool use is a separate feature, enabled with `strict: true` on a tool definition, and the two can be used together. The feature is GA and needs no beta header. The old `output_format` parameter is deprecated and only works if you send the `structured-outputs-2025-11-13` beta header. The supported-model list covers every current model (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, and others). Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const PurchaseOrderExtraction = z.object({
  customerPoNumber: z.string(),
  lines: z.array(z.object({
    customerPartNumber: z.string(),
    description: z.string(),
    quantity: z.number(),
    uom: z.string(),
    unitPrice: z.number().nullable(),
  })),
});

const client = new Anthropic();
const res = await client.messages.parse({
  model: "claude-sonnet-5-5",
  max_tokens: 4096,
  system: "Extract the purchase order. Never invent part numbers.",
  messages: [{ role: "user", content: [/* document + text blocks, see section 2 */] }],
  output_config: { format: zodOutputFormat(PurchaseOrderExtraction) },
});

if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") { /* handle */ }
const po = res.parsed_output; // typed z.infer<typeof PurchaseOrderExtraction> | null
```

Helper behaviour, from reading `src/helpers/zod.ts` in 1.8.0:
- It calls `z.toJSONSchema(schema, { reused: "ref" })` and then `transformJSONSchema`. That transform removes unsupported keywords and adds them to the field description instead.
- It parses the response with **`schema.safeParse`** against the **original** Zod schema. On failure it **throws** an `AnthropicError` that lists the validation issues. So any `.min()`, `.positive()`, or `.refine()` in the shared schema becomes a runtime exception, not a routing signal (see section 4).
- `jsonSchemaOutputFormat()` from `@anthropic-ai/sdk/helpers/json-schema` is the equivalent helper for a plain JSON schema.
- Beta-namespace versions `betaZodOutputFormat` and `betaZodTool` also exist, in `helpers/beta/zod.ts`.

**Guarantees** (source: the structured-outputs page above):
- Output comes from constrained decoding. The docs say responses "always match the schema": no JSON parse errors, required fields present, correct types.
- Exceptions:
  - `stop_reason: "refusal"`: returned with HTTP 200, the tokens are billed, and the output may not match the schema.
  - `stop_reason: "max_tokens"`: the output may be truncated.
  - **Enum casing is not guaranteed.** For example, `"Conversation Topic 3"` can come back for `"Conversation topic 3"`. Compare enum values case-insensitively.
- A field asking for step-by-step reasoning can trigger a `reasoning_extraction` refusal. Ask for a short explanation instead.
- Optional properties are emitted after all required properties.
- The first request with a new schema takes extra time to compile its grammar. The compiled grammar is cached for 24 hours after last use. Changing `output_config.format` invalidates the prompt cache.

**JSON Schema limits** (same source):
- Supported: object, array, string, integer, number, boolean, null, `enum`, `const`, `anyOf`, `allOf` (not combined with `$ref`), internal `$ref`/`$defs`, and the string formats date, date-time, email, uri, uuid, and similar.
- Not supported: recursive schemas; `minimum`/`maximum`/`multipleOf`; `minLength`/`maxLength`; array constraints other than `minItems` 0 or 1; `additionalProperties` set to anything but `false`. A map or record type comes back as `{}`, so use an array of `{key, value}` instead.
- Complexity limits per request:
  - **20 strict tools**
  - **24 optional parameters in total**
  - **16 parameters that use `anyOf` or type arrays in total.** `z.string().nullable()` becomes `anyOf [string, null]`, so it counts toward this limit.
  - A 180-second compile timeout
  - A 400 error, "Schema is too complex", for schemas that exceed the limits.
- **Incompatible with citations** (400 error) and with message prefill.
- Works with batch (50% off), streaming, and token counting.

**UNVERIFIED:** I'm assuming the 16-union and 24-optional limits count property *definitions* in the schema, not the number of line-item instances in the output. The schema is static, so this is the natural reading, but I haven't tested it.

### 1b. OpenAI

**Mechanism.** On the Responses API, the output format goes in `text.format = { type: "json_schema", name, schema, strict: true }`. Chat Completions uses `response_format` instead. Function calling with `strict: true` is the tool-call equivalent. Structured output is supported from GPT-4o onwards, including all current GPT-6.x models, and the docs recommend `gpt-6-astra` for new projects. Source: https://developers.openai.com/api/docs/guides/structured-outputs (Markdown version: append `.md`).

```ts
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

const openai = new OpenAI();
const res = await openai.responses.parse({
  model: "gpt-6.1-sol",
  max_output_tokens: 4096,
  input: [
    { role: "system", content: "Extract the purchase order. Never invent part numbers." },
    { role: "user", content: [/* input_file + input_text, see section 2 */] },
  ],
  text: { format: zodTextFormat(PurchaseOrderExtraction, "purchase_order") },
});

if (res.status === "incomplete") { /* res.incomplete_details?.reason === "max_output_tokens" */ }
// Refusals show up as a `refusal` content part in res.output, so check before trusting the result.
const po = res.output_parsed; // typed | null
```

**Guarantees:**
- The docs: "Structured Outputs constrains completed, non-refusal model output to your supplied JSON Schema."
- Exceptions: refusals arrive as a `refusal` content part; responses cut off at the token limit come back as `status: "incomplete"`.
- The first request with a new schema is slower; later requests with the same schema are not.
- The docs also warn that the model will force output into the schema even for unrelated input, which can produce hallucinations. Give the prompt an explicit way out, such as "not a PO" or empty values.

Source: the structured-outputs guide, "Handle edge cases" section.

**JSON Schema rules** (same guide, "Supported schemas" section):
- **Every field must be `required`.** Model an optional field as `type: [T, "null"]`. The SDK enforces this: `openai/lib/transform.js` throws "uses `.optional()` without `.nullable()` which is not supported by the API".
- `additionalProperties: false` must be set on every object.
- **The root must be an object, not `anyOf`.** A top-level `z.discriminatedUnion` is invalid.
- Supports `pattern`, `format`, `minimum`/`maximum`/`multipleOf`, `minItems`/`maxItems`, `$defs`, and recursion. Unlike Anthropic, numeric bounds are enforced by the grammar.
- Not supported: `allOf`, `not`, `if`/`then`/`else`, `dependentRequired`.
- Size limits: 5,000 properties, 10 levels of nesting, 120,000 characters of names/enums/consts in total, and 1,000 enum values.
- Keys are emitted in schema order.

### 1c. Rules for a Zod schema shared by both providers

These follow from the limits above:
1. Make the root a `z.object`. Discriminated unions are fine nested inside it, but not at the root.
2. Use `.nullable()` and never `.optional()`. Keep **the total number of nullable fields across the extraction schema at 16 or fewer**, because of Anthropic's union limit. Collect related nullable fields into one nullable object. For example, make `shipTo` a single nullable object instead of five nullable strings.
3. No `z.record` or maps. Use arrays of `{ key, value }`.
4. No recursion.
5. Keep **business constraints out of the extraction schema**: no `.min()`, `.positive()`, `.refine()`, or regex SKU checks. Anthropic would only describe them to the model and then throw locally when they fail. OpenAI would force the value into range. Either way you lose the signal that the data was bad. Run those checks in the Validate stage instead, and feed the results to the confidence/routing gate.
6. Use `.describe()` generously. Both converters pass the description through to the model.
7. Compare enum values case-insensitively (an Anthropic-specific caveat).

---

## 2. Document input

### 2a. Anthropic

```ts
import { readFile } from "node:fs/promises";
const pdfBase64 = (await readFile("po.pdf")).toString("base64");

content: [
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
  { type: "text", text: "Extract the purchase order from the attached document." },
]
// Alternatives: source: { type: "url", url }  or  source: { type: "file", file_id }  (Files API)
```
- **How a PDF is processed:** each page is converted to an image, and the page's extracted text is sent alongside it. Text costs about 1,500–3,000 tokens per page, plus image tokens for each page. There is no separate PDF fee. Put the PDF before the text in the prompt.
- **Limits:**
  - Request size: 128 MB.
  - Pages: **600 per request**, or 100 when the request's context window is under 1M tokens.
  - Encrypted or password-protected PDFs are rejected.
- **Models:** all current models.

Source: https://platform.claude.com/docs/en/build-with-claude/pdf-support

- **Files API:** GA, no beta header (`client.files.upload` with `toFile(...)`, `source: { type: "file", file_id }`).
  - Limits: 500 MB per file, 1 TB per organisation.
  - Uploads are free, and file content is billed as input tokens when used.
  - Files are scoped to the workspace, are **not ZDR-eligible**, and can be set to expire with `expires_in_seconds`.
  - TS SDK 0.122.0 and later dropped the beta namespace for this.

  Source: https://platform.claude.com/docs/en/build-with-claude/files

  For this prototype, inline base64 is simpler.
- **XLSX/DOCX:** **not supported in document blocks.** Convert them to text and send that inline. CSV, Markdown, and TXT can also be uploaded with `text/plain` and passed as a `document` block. For DOCX that contains images, convert to PDF first (source: the Files API page, "Working with other file formats").
- **Citations:** these work on PDF and text documents, giving `page_location` and `char_location` with the `cited_text`. But they are **incompatible with `output_config.format`**. Anthropic's suggested workaround is to ask for "one line per field" with citations and parse that output yourself (source: https://platform.claude.com/docs/en/build-with-claude/citations, "Get structured data with citations"). This could be a later Review Queue feature: highlighting the source text behind each extracted field. It is not needed for v1.

### 2b. OpenAI

```ts
import { readFileSync } from "node:fs";
const b64 = readFileSync("po.pdf").toString("base64");

content: [
  { type: "input_file", filename: "po.pdf", file_data: `data:application/pdf;base64,${b64}` /*, detail: "high" */ },
  { type: "input_text", text: "Extract the purchase order from the attached document." },
]
// Alternatives: file_id (upload with purpose: "user_data")  or  file_url (Responses API only)
```
- **How files are processed:**
  - PDF: extracted text plus page images, on vision-capable models (GPT-4o and later). The `detail` setting can be `auto`, `low`, or `high`. On GPT-5.6 and later, `auto` means `high`. It only affects the page images.
  - DOCX, PPTX, TXT: **text only**, with embedded images dropped.
  - **Spreadsheets** (`.xlsx`, `.xls`, `.csv`, `.tsv`): a special augmentation step that reads "the first 1,000 rows per sheet and adds model-generated summary and header metadata".
- **Limits:** **each file must be under 50 MB, and all files in one request together must be under 50 MB.** **UNVERIFIED:** the docs give no PDF page limit.
- **Chat Completions accepts PDFs only**, so use the Responses API.

Source: https://developers.openai.com/api/docs/guides/file-inputs (the old `pdf-files` URL redirects to the same content).

### 2c. Recommendation for this prototype

| Input | What we send to both providers |
|---|---|
| PDF | The native PDF (base64 inline). This is the "LLM technique worth showing" from the map, and both providers send text plus page images. |
| XLSX | **Convert in our own code** to one Markdown/CSV block per sheet, then send it as text. This keeps the comparison fair and avoids OpenAI's non-deterministic summarisation step. It also gives us a testable seam. SheetJS warns that its npm-registry package is stale (0.18.5) and says to install from the CDN instead: `pnpm add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (https://docs.sheetjs.com/docs/getting-started/installation/nodejs). `exceljs` 4.4.0 also works, but its last release was in 2024. |
| Free-text email | The email body as plain text, wrapped in delimiters (helpful for the prompt-injection discussion). |

---

## 3. Models, prices, limits (verified 2026-11-12)

Prices are US dollars per million tokens (input / output).

| | Model ID | Price | Context | Max out | Notes |
|---|---|---|---|---|---|
| **Claude, top** | `claude-fable-5-2` | $8 / $40 | 1M | 128K | Anthropic's suggested step up when Opus 5.5 falls short on evals |
| **Claude, default** | `claude-opus-5-5` | $4 / $20 | 1M | 128K | Anthropic's suggested starting model ("start with Opus 5.5") |
| **Claude, mid** | `claude-sonnet-5-5` | $2 / $10 | 1M | 128K | Cache hits cost 5% of the input price |
| **Claude, cheap** | `claude-haiku-5-5` | $0.10 / $0.50 for prompts up to 100K tokens; $0.50 / $2.50 above | 1M | 128K | Described as being for "classification, extraction, and routing" |
| **OpenAI, top** | `gpt-6-astra` | $10 / $50 | 1.05M (922K input) | 128K | OpenAI's suggested starting model |
| **OpenAI, mid** | `gpt-6.1-sol` | $2 / $10 | 1.05M (922K input) | 128K | "Near-Astra performance… at lower cost" |
| **OpenAI, mid-low** | `gpt-6.1-terra` | $1 / $5 | 1.05M (922K input) | 128K | Visual reasoning |
| **OpenAI, cheap** | `gpt-6-luna` | $0.10 / $0.50 | 1.05M (922K input) | 128K | For high-volume work |

Sources:
- Claude: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI: https://developers.openai.com/api/docs/models and the per-model pages, e.g. https://developers.openai.com/api/docs/models/gpt-6.1-sol

Pricing details that matter for us:
- **Batch:** 50% off at both vendors. OpenAI's Flex tier is also 50% off.
- **OpenAI long context:** above 272K input tokens, input is billed at 2× and output at 1.5× for the whole request. This is irrelevant for POs.
- **Haiku 5.5 tiers:** the 100K-token price step is irrelevant for POs.
- **Reasoning:** all current models of both vendors reason by default (Claude "adaptive thinking", OpenAI `reasoning.effort`), and that reasoning is billed as output. Turn effort down for extraction.
- **Tokenizer:** Claude 4.7 and later produce about 30% more tokens for the same text than older Claude models, per the pricing page.

**Suggested eval pairings** (the prices are identical, so the comparison is clean): Sonnet 5.5 vs GPT-6.1 Sol, and Haiku 5.5 vs GPT-6 Luna. Add Opus 5.5 or GPT-6 Astra as a ceiling if budget allows.

**Rough cost per PO (UNVERIFIED estimate):**
- Assumptions: a 2-page PDF at about 2 × (2,000 text tokens + roughly 1,500 image tokens), plus prompt and schema, for about 8K input tokens. About 1–2K output tokens.
- Sonnet 5.5 or GPT-6.1 Sol: about $0.03 per PO.
- Haiku 5.5 or GPT-6 Luna: under $0.002 per PO.
- Measure real figures from the `usage` fields in the eval harness.

---

## 4. Implications for the pipeline design

- **Report a failure as one of three kinds, not a single "error":**
  - a refusal or truncation from the API;
  - the SDK's Zod parse throwing (Anthropic throws `AnthropicError`; OpenAI's `parse` throws on validation failure);
  - business-rule failures from our own Validate stage.
  
  All three are signals for the confidence/routing gate.
- **Schema-valid does not mean correct.** Both vendors say structured outputs can still contain mistakes or hallucinations, and OpenAI explicitly warns that the model will force unrelated input into the schema. The Validate stage plus Cross-Reference matching remains the actual safeguard.
- **Classify-then-extract fits naturally:** make one small structured call (`{ isPurchaseOrder: boolean, reason: string }`) on a cheap model, then the extraction call.
- **The first call per schema is slow** at both vendors, because of grammar compilation. Warm up the schema before timing latency in the eval.

---

## 5. Hand-rolled interface vs Vercel AI SDK

**What the AI SDK (v7) offers today** (sources: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data, https://ai-sdk.dev/providers/ai-sdk-providers/anthropic, https://ai-sdk.dev/providers/ai-sdk-providers/openai):

```ts
import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

const { output, usage } = await generateText({
  model: anthropic("claude-sonnet-5-5"), // or openai("gpt-6.1-sol")
  output: Output.object({ schema: PurchaseOrderExtraction }),
  messages: [{ role: "user", content: [
    { type: "file", data: pdfBuffer, mediaType: "application/pdf" },
    { type: "text", text: "Extract the purchase order." },
  ]}],
});
```

- `generateText` with `output: Output.object({ schema })` is the documented path for structured output. Failures throw `NoObjectGeneratedError`.
- **Anthropic:** `structuredOutputMode: "auto"` uses native `output_config.format` on the 5.5 models. It **silently switches to a forced "json" tool** for schemas with **more than 10 optional properties**, recursion, or open objects, on models that allow forced tool use. The docs say Sonnet 5.5 and Opus 5.5 reject forced tool use, so on those models it falls back to `outputFormat` with a warning. **UNVERIFIED:** which path Haiku 5.5 takes in that case.
- **OpenAI:** uses the Responses API by default, and `strictJsonSchema` defaults to `true`. **XLSX and other non-PDF files are not passed through** unless you set `passThroughUnsupportedFiles: true`.

**Recommendation: write our own thin interface over the two official SDKs.**
- *Both SDKs now ship equivalent Zod helpers,* so the AI SDK mainly unifies the input-part format and `usage`. That is about 100–150 lines of adapter code per provider.
- *The eval harness needs raw provider detail:* `stop_reason`/`status`, refusal parts, cache and reasoning token counts, and exact request IDs. With our own adapters we see exactly which mechanism ran (native grammar vs. JSON-tool fallback). Those differences are the comparison the eval is meant to measure, so the adapter shouldn't hide them.
- *Interview value:* "here are the provider differences and how my interface absorbs them" is a strong whiteboard talking point. "I used a library" isn't.
- *Fewer moving parts:* this avoids three extra packages that change quickly (`ai` is at 7.0.171) and an extra layer between our code and the vendor docs.
- *When the AI SDK would be the better choice:* if we add a third provider, need streaming UI, or need tool-calling agent loops. None of these is in scope. If it's adopted later, the interface below maps onto it directly.

Suggested shape (to be finalised in ticket 07, extraction approach):

```ts
export type InputPart =
  | { kind: "text"; text: string }
  | { kind: "pdf"; filename: string; data: Buffer };

export type LlmResult<T> =
  | { ok: true; data: T; usage: Usage; model: string; latencyMs: number }
  | { ok: false; reason: "refusal" | "truncated" | "schema_parse_failed" | "api_error";
      detail: string; usage?: Usage; model: string; latencyMs: number };

export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens: number }

export interface LlmProvider {
  readonly name: "anthropic" | "openai";
  structured<S extends z.ZodObject>(req: {
    model: string; system: string; parts: InputPart[];
    schema: S; schemaName: string; maxOutputTokens: number;
  }): Promise<LlmResult<z.infer<S>>>;
}
```
How the Anthropic adapter maps `InputPart` (in an `AnthropicProvider` class):
- `pdf` becomes a `document` block with a base64 source.
- `text` becomes a `text` block.
- Use `messages.parse` with `zodOutputFormat`.
- Map `stop_reason` to `reason`, and catch `AnthropicError` as `schema_parse_failed`.

How the OpenAI adapter maps `InputPart` (in an `OpenAIProvider` class):
- `pdf` becomes `input_file` with a `file_data` data URL.
- `text` becomes `input_text`.
- Use `responses.parse` with `zodTextFormat`.
- Map `status: "incomplete"` and refusal parts to `reason`.

---

## Open items / not verified

- Whether Anthropic's 16-union and 24-optional limits are counted per schema definition or per instance. Run a spike with the real PO schema and one API key per vendor.
- OpenAI's PDF page limit (not stated in the docs) and the exact image tokens per PDF page at each provider. Measure with token counting or `usage`.
- Real extraction accuracy of the two providers on our POs. That is the eval's job (ticket 11).
- Which structured-output path the AI SDK uses for Haiku 5.5 when the schema has more than 10 optional fields. Moot if we write our own adapters.
