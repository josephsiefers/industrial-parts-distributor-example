// PROTOTYPE, throwaway. Renders the latest results/*.json into a single self-contained report.html.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { comparePO, score, type FieldResult } from "./compare.ts";

const latest = process.argv[2] ?? `results/${readdirSync("results").filter((f) => f.endsWith(".json")).sort().at(-1)}`;
const data = JSON.parse(readFileSync(latest, "utf8"));
const heroIds: string[] = [...new Set<string>(data.runs.map((r: any) => r.heroId))].sort();
const truth = Object.fromEntries(heroIds.map((id) => [id, JSON.parse(readFileSync(`heroes/${id}/truth.json`, "utf8"))]));
const body = Object.fromEntries(heroIds.map((id) => [id, readFileSync(`heroes/${id}/body.txt`, "utf8")]));
const cols: { provider: string; variant: string }[] = [];
for (const r of data.runs) if (!cols.some((c) => c.provider === r.provider && c.variant === r.variant)) cols.push({ provider: r.provider, variant: r.variant });
cols.sort((a, b) => a.variant.localeCompare(b.variant) || a.provider.localeCompare(b.provider));
const colName = (c: { provider: string; variant: string }) => `${c.variant} · ${c.provider === "anthropic" ? "Claude" : "OpenAI"}`;
const find = (h: string, c: { provider: string; variant: string }) => data.runs.find((r: any) => r.heroId === h && r.provider === c.provider && r.variant === c.variant);

const esc = (v: unknown) => (v === undefined ? "<i class=dim>—</i>" : v === null ? "<i class=dim>null</i>" : String(typeof v === "string" ? v : JSON.stringify(v)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "↵<br>"));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const runCost = (r: any) => sum(r.steps.map((s: any) => s.costUsd ?? 0));
const runLatency = (r: any) => sum(r.steps.map((s: any) => s.latencyMs)) / 1000;
const classOk = (h: string, r: any) => r.classification?.toLowerCase() === truth[h].classification;
const fields = (h: string, r: any): FieldResult[] => comparePO(truth[h].expectedPurchaseOrder, r.purchaseOrder);

// ---- per-variant aggregate
const agg = cols.map((c) => {
  const rs = heroIds.map((h) => ({ h, r: find(h, c) })).filter((x) => x.r);
  const scored = rs.map(({ h, r }) => score(fields(h, r)));
  return {
    c,
    classAcc: `${rs.filter(({ h, r }) => classOk(h, r)).length}/${rs.length}`,
    fieldAcc: `${sum(scored.map((s) => s.exact + s.normalised))}/${sum(scored.map((s) => s.total))}`,
    exactAcc: `${sum(scored.map((s) => s.exact))}`,
    failures: rs.flatMap(({ r }) => r.steps.filter((s: any) => !s.ok).map((s: any) => s.reason)).length,
    cost: sum(rs.map(({ r }) => runCost(r))),
    latency: sum(rs.map(({ r }) => runLatency(r))) / rs.length,
  };
});

const summary = `
<table class=sum><tr><th>Approach · provider</th><th>Classification correct</th><th>Fields matched (exact + normalised / total)</th><th>of which exact</th><th>Failed calls</th><th>Total cost</th><th>Mean latency / email</th></tr>
${agg.map((a) => `<tr><td>${colName(a.c)}</td><td>${a.classAcc}</td><td>${a.fieldAcc}</td><td>${a.exactAcc}</td><td>${a.failures}</td><td>$${a.cost.toFixed(4)}</td><td>${a.latency.toFixed(1)}s</td></tr>`).join("")}
</table>`;

const perHeroGrid = `
<table class=sum><tr><th>Email</th>${cols.map((c) => `<th>${colName(c)}</th>`).join("")}</tr>
${heroIds.map((h) => `<tr><td><a href="#" onclick="show('${h}');return false">${h}</a></td>${cols.map((c) => {
  const r = find(h, c); if (!r) return "<td>—</td>";
  const s = score(fields(h, r));
  const bad = r.steps.some((x: any) => !x.ok);
  return `<td class="${classOk(h, r) && s.exact + s.normalised === s.total ? "good" : "warn"}">${classOk(h, r) ? "✓" : "✗ " + esc(r.classification)} · ${s.exact + s.normalised}/${s.total}${bad ? " · <b>call failed</b>" : ""}</td>`;
}).join("")}</tr>`).join("")}
</table>`;

const heroTab = (h: string) => {
  const t = truth[h];
  const runs = cols.map((c) => find(h, c));
  const results = runs.map((r) => (r ? fields(h, r) : []));
  const paths = results.find((x) => x.length)?.map((x) => x.path) ?? [];
  const allPaths = [...new Set(results.flatMap((rs) => rs.map((x) => x.path)))];
  const rows = (allPaths.length ? allPaths : paths).map((p) => {
    const exp = results.map((rs) => rs.find((x) => x.path === p)).find(Boolean)?.expected;
    const cells = results.map((rs) => {
      const f = rs.find((x) => x.path === p);
      return f ? `<td class="${f.match}">${esc(f.actual)}</td>` : "<td>—</td>";
    }).join("");
    const allExact = results.every((rs) => rs.find((x) => x.path === p)?.match === "exact");
    return `<tr class="${allExact ? "allok" : ""} ${p.endsWith("rawText") ? "raw" : ""}"><th>${p}</th><td class=exp>${esc(exp)}</td>${cells}</tr>`;
  }).join("");
  const classRow = `<tr><th>classification</th><td class=exp>${t.classification}</td>${runs.map((r) => `<td class="${r && classOk(h, r) ? "exact" : "mismatch"}">${esc(r?.classification)}<div class=dim>${esc(r?.classificationReason)}</div></td>`).join("")}</tr>`;
  const uncertainties = runs.map((r, i) => (r?.uncertainties ? `<div class=card><h4>${colName(cols[i])}: self-reported uncertainties</h4>${r.uncertainties.length ? `<ul>${r.uncertainties.map((u: any) => `<li><code>${esc(u.field)}</code> <b>${u.kind}</b>: ${esc(u.note)}</li>`).join("")}</ul>` : "<p class=dim>none reported</p>"}</div>` : "")).join("");
  const steps = runs.map((r, i) => r ? `<tr><th>${colName(cols[i])}</th><td>${r.steps.map((s: any) => `${s.step} <b>${s.model}</b> ${s.ok ? "ok" : `<span class=bad>${s.reason}: ${esc(s.detail?.slice(0, 300))}</span>`} · ${(s.latencyMs / 1000).toFixed(1)}s${s.firstCallForSchema ? " (first call for schema)" : ""} · in ${s.usage?.inputTokens ?? "?"} / out ${s.usage?.outputTokens ?? "?"} (reasoning ${s.usage?.reasoningTokens ?? "?"}) · $${(s.costUsd ?? 0).toFixed(4)}${s.note ? ` · <i>${s.note}</i>` : ""}`).join("<br>")}</td></tr>` : "").join("");
  return `<section id="tab-${h}" class=tab hidden>
  <h2>${h}</h2><p class=notes>${esc(t.heroNotes)}</p>
  <details open><summary>Email body</summary><pre>${esc(body[h]).replace(/↵<br>/g, "\n")}</pre></details>
  <label><input type=checkbox onchange="document.body.classList.toggle('hideok',this.checked)"> Hide rows where every run matches exactly</label>
  <label><input type=checkbox checked onchange="document.body.classList.toggle('hideraw',!this.checked)"> Show rawText rows</label>
  <div class=scroll><table class=cmp><tr><th>Field</th><th>Expected (hand-written)</th>${cols.map((c) => `<th>${colName(c)}</th>`).join("")}</tr>${classRow}${rows}</table></div>
  ${uncertainties}
  <h3>Calls</h3><table class=steps>${steps}</table>
</section>`;
};

const html = `<!doctype html><meta charset=utf-8><title>PROTOTYPE · Extraction approach</title>
<style>
:root{color-scheme:dark;--bg:#16171b;--fg:#e4e4e7;--panel:#1f2026;--panel2:#26272e;--line:#3a3b44;--dim:#8b8d98;--accent:#6f8cff;
--bad-bg:#4a1f24;--norm-bg:#47391a;--exp-bg:#1c2a4a;--good-bg:#173a28;--warn-bg:#3d2a17;--bad-fg:#ff8a8a}
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px 32px;background:var(--bg);color:var(--fg);max-width:1800px}
a{color:var(--accent)} code{background:var(--panel2);padding:0 4px;border-radius:3px}
h1{font-size:20px;margin:0 0 4px} .banner{background:var(--norm-bg);border:1px solid #8a6d2a;color:#f3d98b;padding:6px 10px;border-radius:6px;display:inline-block;font-size:12px}
.intro{max-width:900px} table{border-collapse:collapse;margin:8px 0 20px} th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.sum th{background:var(--panel2)} .good{background:var(--good-bg)} .warn{background:var(--warn-bg)}
nav button{margin:0 4px 6px 0;padding:6px 10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer} nav button.on{background:var(--accent);color:#0d0f1a;border-color:var(--accent)}
pre{background:var(--panel);border:1px solid var(--line);padding:12px;overflow:auto;font-size:12px;max-height:420px}
.cmp{font-size:12px} .cmp th{background:var(--panel);white-space:nowrap} .cmp td{max-width:260px;word-break:break-word}
td.exp{background:var(--exp-bg)} td.mismatch{background:var(--bad-bg)} td.normalised{background:var(--norm-bg)} td.exact{}
.hideok tr.allok{display:none} .hideraw tr.raw{display:none} tr.raw td{font-family:ui-monospace,monospace;font-size:11px;color:var(--dim)}
.dim{color:var(--dim)} .bad{color:var(--bad-fg)} .notes{background:var(--panel);padding:8px 12px;border-left:3px solid var(--accent);max-width:1000px}
.card{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 14px;margin:8px 0;max-width:1000px} .card h4{margin:4px 0} .scroll{overflow-x:auto}
label{margin-right:16px;font-size:12px} .swatch{padding:0 4px;border-radius:3px}
</style>
<div class=banner>PROTOTYPE · throwaway · answers the "Extraction approach" Wayfinder ticket</div>
<h1>Extraction approach: one call, or classify then extract? Does self-reporting help?</h1>
<div class=intro>
<p>Each hand-made hero email was run through three approaches on both providers, using the <code>PurchaseOrder</code> schema from the data model decision (extract-then-resolve: copy as written, interpret nothing). Run file: <code>${latest}</code>.</p>
<ul>${Object.entries(data.variants).map(([k, v]) => `<li><b>${k}</b>: ${v}</li>`).join("")}</ul>
<p>Mid models: Claude Sonnet 5.5 / GPT-6.1 Sol (same price). Cheap models: Claude Haiku 5.5 / GPT-6 Luna. Reasoning effort: low. Cell colours: <span class=swatch style="background:var(--bad-bg)">mismatch</span>, <span class=swatch style="background:var(--norm-bg)">matches after normalising case, whitespace and punctuation</span>, blue = expected, no colour = exact. Expected values are one person's hand-written truth, and some are deliberately debatable (see each email's notes).</p>
<p><b>Things to react to:</b> Does B's extra call earn its cost and latency, or does A classify just as well? Do C's self-reported uncertainties point at real problems (would they make useful Flags?) or are they noise? Where the models disagree with the truth, which side is wrong?</p>
</div>
<h3>By approach</h3>${summary}
<h3>By email</h3>${perHeroGrid}
<nav>${heroIds.map((h) => `<button id="btn-${h}" onclick="show('${h}')">${h}</button>`).join("")}</nav>
${heroIds.map(heroTab).join("\n")}
<script>
function show(h){document.querySelectorAll('.tab').forEach(s=>s.hidden=s.id!=='tab-'+h);document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.id==='btn-'+h));}
show(${JSON.stringify(heroIds[0])});
</script>`;
writeFileSync("report.html", html);
console.log(`Wrote report.html from ${latest}`);
