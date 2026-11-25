# PROTOTYPE: Extraction approach (throwaway, never merged)

Answers the Wayfinder ticket [Extraction approach](https://github.com/josephsiefers/industrial-parts-distributor-example/issues/8): should an email become a Purchase Order in one call (classify + extract) or in two (classify, then extract)? And should the model self-report anything beyond nulls?

## Verdict

- **Classify then extract (variant B).** Accuracy was the same as one call; B was chosen for lifecycle fit, separate evaluation, lower cost on non-POs, and a spare nullable slot.
- **No self-reported uncertainties (variant C dropped).** They are the model's free-text opinion, unverified, inconsistent across providers, and noisy on Claude.
- **Strict as-written truth** as written in `heroes/*/truth.json` (except hero-04, below).

Full resolution: see the ticket's resolution comment.

## Superseded by the decision (the code here is as-run, not corrected)

- `prompts.ts` tells the model that "the newest message is authoritative: apply its changes". **Rejected:** in-thread amendments are out of scope. Extraction copies lines as written and the amendment sentence goes into `notes`. `heroes/hero-04-forwarded-change/truth.json` (quantity 150) is therefore wrong under the decision; it should be 100, with the amendment in `notes`.
- Variant C, `PurchaseOrderWithUncertainties` and `PROMPTS.extractWithUncertainties`: dropped.

## Run it

```sh
# keys in the repo-root .envrc (gitignored): OPENAI_API_KEY, ANTHROPIC_API_KEY
pnpm install
set -a; source ../../.envrc; set +a
npx tsx run.ts [--provider=openai|anthropic] [--only=A,B]
npx tsx report.ts [results/<file>.json]   # writes report.html (open in a browser)
```

`results/combined-both-providers.json` merges the two runs the verdict was based on (OpenAI 2026-11-25T00:27, Claude 2026-11-25T00:51); `report.html` is rendered from it.
