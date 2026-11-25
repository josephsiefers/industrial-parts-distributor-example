// PROTOTYPE, throwaway. Runs every hero email x provider x variant and writes results/<timestamp>.json.
// Usage: pnpm run run [--only=A,B] [--provider=anthropic]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { anthropicProvider, openaiProvider, type Provider, type ProviderName } from "./providers.ts";
import { runVariant, VARIANTS, type VariantId } from "./variants.ts";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const variants = (arg("only")?.split(",") ?? Object.keys(VARIANTS)) as VariantId[];

const providers: Partial<Record<ProviderName, Provider>> = {};
if (process.env.ANTHROPIC_API_KEY && arg("provider") !== "openai") providers.anthropic = anthropicProvider();
if (process.env.OPENAI_API_KEY && arg("provider") !== "anthropic") providers.openai = openaiProvider();
if (!Object.keys(providers).length) {
  console.error("No API keys. Put ANTHROPIC_API_KEY and/or OPENAI_API_KEY in the repo-root .env (gitignored).");
  process.exit(1);
}

const heroes = readdirSync("heroes").sort().map((id) => {
  const env = JSON.parse(readFileSync(`heroes/${id}/envelope.json`, "utf8"));
  return { id, email: { ...env, bodyText: readFileSync(`heroes/${id}/body.txt`, "utf8") } };
});

const runs: any[] = [];
// Providers in parallel; within a provider, sequential so first-call (grammar compile) latency is visible.
await Promise.all(
  Object.entries(providers).map(async ([name, call]) => {
    const seenSchemas = new Set<string>();
    for (const v of variants) {
      for (const h of heroes) {
        const outcome = await runVariant(v, name as ProviderName, call!, h.email);
        for (const s of outcome.steps) {
          const key = `${s.step}:${v === "C" && s.step === "extract" ? "C" : v === "A" ? "A" : "BC"}`;
          (s as any).firstCallForSchema = !seenSchemas.has(key);
          seenSchemas.add(key);
        }
        runs.push({ heroId: h.id, provider: name, variant: v, ...outcome });
        const st = outcome.steps.map((s) => `${s.step}:${s.ok ? "ok" : s.reason}@${(s.latencyMs / 1000).toFixed(1)}s`).join(" ");
        console.log(`${name.padEnd(9)} ${v} ${h.id.padEnd(26)} ${String(outcome.classification).padEnd(16)} lines=${outcome.purchaseOrder?.lines.length ?? "-"}  ${st}`);
      }
    }
  }),
);

mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), variants: VARIANTS, runs }, null, 2));
console.log(`\nWrote ${file}. Now: pnpm report`);
