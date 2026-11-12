# Part-matching techniques for distributor catalogs

Research for [Research: part-matching techniques for distributor catalogs](https://github.com/josephsiefers/industrial-parts-distributor-example/issues/5). Compiled 2026-11-12.

**Question:** How should a free-form Purchase Order line be resolved to a distributor SKU? A line can carry a Customer Part Number, a manufacturer part number (MPN), or an abbreviated description such as `1/2-13x2 HHCS ZP`. The setting is a TypeScript/Node 22 + SQLite prototype with a catalog of a few hundred to a few thousand SKUs, and both the Claude and OpenAI APIs are available.

**Source conventions.** Every claim has a URL. Lines marked **[unverified]** could not be checked against a primary source, or are my own reasoning. Lines marked **[marketing]** come from vendor sales material. Maintenance status for npm packages comes from `npm view <pkg> version time` on 2026-11-12.

---

## 0. Framing: three kinds of identifier, three kinds of matching

EDI already separates the identifiers a Purchase Order line can carry. The X12 850 PO1 segment uses qualifiers "BP - the part number of the buyer", "VP - the part number of the vendor (seller)" and "MG - the part number of the manufacturer", among others (VC, VN, IN, UP) ([IBM X12 850 reference](https://www.ibm.com/docs/en/SSRJDU/business_transaction_intelligence/reference/bti_EDI_850_Purchase_order.html)). On emailed POs these arrive unlabelled, so the extraction step has to guess which kind of identifier each token is. Each kind needs a different matcher:

| Identifier on the line | Best matcher | Typical precision |
|---|---|---|
| Customer Part Number (BP) | Cross-Reference exact lookup | Very high when present |
| Distributor SKU (VP) or MPN (MG) | Normalised exact lookup, then fuzzy or trigram matching | High |
| Description only | Attribute parsing, FTS5/BM25 and embeddings for candidates, then attribute check and LLM select | Medium. This is where the hard cases are. |

A useful principle from a (vendor) electronics order-intake write-up: a similar description or a near-match on the manufacturer number is "a search lead, not proof of interchangeability" ([Stacksync blog](https://www.stacksync.com/blog/electronics-genie-customer-part-cross-reference)) **[marketing-adjacent, but the point is sound]**. For this prototype, every layer below the exact-ID layers should produce candidates and evidence, not decisions.

---

## 1. Cross-Reference lookup (Customer Part Number to SKU)

**What it is.** A per-customer table `(customer_id, customer_part_number_norm) -> sku`, plus optional `uom` and `pack_qty` conversion fields. It is the same idea as the BP qualifier in X12 ([IBM](https://www.ibm.com/docs/en/SSRJDU/business_transaction_intelligence/reference/bti_EDI_850_Purchase_order.html)).

**Strengths**
- It is deterministic and the highest-precision signal available. A hit should allow Straight-Through Processing if quantity and price checks pass.
- It is cheap: a B-tree index on `(customer_id, cpn_norm)` in plain SQLite.

**Failure modes [unverified, domain reasoning]**
- The table goes stale: the customer re-uses a CPN for a new part, or the distributor supersedes a SKU.
- A CPN carries a revision suffix (`-A`, `REV B`) that may or may not matter.
- Units differ: the customer orders "per C" (per hundred) while the SKU is sold per box of 50.
- Coverage is low for new customers, so the table only pays off once it fills up. Write confirmed rep resolutions from the Review Queue back into it. This is the main source of compounding accuracy.
- A line may carry a token that looks like a CPN but is actually an MPN. Try the CPN lookup first, then the SKU/MPN lookups, and record which one hit.

**Libraries:** none needed beyond SQLite. Use `better-sqlite3` or `node:sqlite` (see §4).

---

## 2. Part-number normalisation (SKU, MPN, CPN)

**Technique [unverified, standard practice; no single primary source found]**
1. Store the raw string, and also derive a normalised key: Unicode NFKC, upper-case, trim, and remove whitespace, `-`, `.`, `/`, `_` and `#`.
2. Index both the raw and the normalised key, and do exact lookup on the normalised key.
3. Optionally keep a "confusable-folded" key that maps `O→0`, `I/L→1`, `S→5` and `B→8`, for OCR'd or hand-typed POs. Use it only as a candidate generator, never for an automatic decision, because it creates collisions.
4. Remove known prefixes and suffixes (manufacturer line codes, a leading `MFR#` or `P/N:`) in a separate key, not in place.
5. Leading zeros: do not strip them by default, since they are significant in some numbering schemes. Use a separate key if needed.

**Where it fails**
- Over-normalisation causes collisions. Removing `/` and `-` turns `1/2-13` into `1213`, so **never apply part-number normalisation to descriptions.**
- Near-identical MPNs often name genuinely different parts, for example a length or finish suffix (`...-ZP` vs `...-HDG`). Edit distance 1 does not mean "same part".

**Matching after normalisation**
- Exact match on the normalised key.
- Substring matching (a customer writes a partial MPN): use an FTS5 table with `tokenize='trigram'`. It "may match any sequence of characters within a row" and supports indexed `LIKE`/`GLOB`, but "substrings consisting of fewer than 3 unicode characters do not match any rows" ([SQLite FTS5 §4.3.5](https://www.sqlite.org/fts5.html)). Trigram support arrived in SQLite 3.34.0 ([release log](https://www.sqlite.org/releaselog/3_34_0.html)).
- Typos and transpositions: edit distance or Jaro-Winkler over the few-thousand normalised keys, computed in JS (§3).

---

## 3. Fuzzy string matching

**Strengths:** handles typos, transpositions and token re-ordering (`HHCS 1/2-13 X 2` vs `1/2-13X2 HEX CAP SCREW`). With a few thousand SKUs, brute force over the whole catalog in memory takes milliseconds **[unverified estimate]**.

**Failure modes on industrial data**
- These scorers have no idea what the characters mean. `1/2-13x2` and `1/2-13x3` differ by one character, so they score as near-identical even though they are different parts. The same goes for `GR5` vs `GR8` and `M8` vs `M6`.
- Abbreviated and expanded forms score badly against each other (`HHCS` vs `hex head cap screw`) unless both sides are first canonicalised (§6).
- The default pre-processing in fuzzywuzzy-style libraries removes punctuation. fuzzball's default processing "removes non-alphanumeric characters" ([fuzzball README](https://github.com/nol13/fuzzball.js)), which destroys `1/2-13`. Pre-process yourself and set `full_process: false`.

**Node libraries**

| Package | Latest (publish date) | Notes |
|---|---|---|
| `fuzzball` | 2.2.6 (2026-04-30) | Port of TheFuzz/RapidFuzz. Provides `ratio`, `partial_ratio`, `token_sort_ratio`, `token_set_ratio`, `WRatio`, and `extract` with `cutoff`/`limit` ([README](https://github.com/nol13/fuzzball.js)). The token-set scorers suit re-ordered descriptions. **Best fit for descriptions.** |
| `fastest-levenshtein` | 1.0.16 (2022-08-02) | Plain, fast edit distance. Not updated since 2022, but small and stable. Good for part-number keys. |
| `talisman` | 1.1.5 (2026-11-03) | Large toolkit of metrics: Jaro-Winkler, n-gram, and others ([GitHub](https://github.com/Yomguithereal/talisman)). |
| `cmpstr` | 3.4.0 (2026-09-14) | Several similarity metrics. Actively published. |
| `fuse.js` | 7.5.0 (2026-07-13) | Bitap-based in-memory fuzzy search, "designed for searching small-to-medium datasets" ([README](https://github.com/krisk/Fuse)). Better suited to search-as-you-type UI than to scoring candidates. |
| `string-similarity` | 4.0.4 | **Deprecated on npm** ("Package no longer supported"). Avoid. |

---

## 4. Full-text search with SQLite FTS5 (BM25)

**Availability in Node 22**
- `better-sqlite3` 13.1.1 (2026-11-11) requires Node `>=22` and bundles SQLite 3.54.1 compiled with `SQLITE_ENABLE_FTS5` ([compilation.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md)). It is actively maintained.
- `node:sqlite` is built in, but its stability is still "1.1 - Active development". It has been unflagged since v22.13.0, and `loadExtension()` and `allowExtension` were added in v22.13.0 ([Node 22 sqlite docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)). Node 22's bundled SQLite (3.54.1) also defines `SQLITE_ENABLE_FTS5` ([deps/sqlite/sqlite.gyp](https://github.com/nodejs/node/blob/v22.x/deps/sqlite/sqlite.gyp)). Note that the sqlite-vec docs say `node:sqlite` extension loading needs Node 23.5+ ([sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)), which conflicts with Node's own docs **[unverified which is right for 22.x; test it]**. `better-sqlite3` is the lower-risk choice.

**Relevant FTS5 facts** (all from [sqlite.org/fts5.html](https://www.sqlite.org/fts5.html))
- `bm25(tbl, w0, w1, ...)` takes per-column weights. "Better matches are assigned numerically lower values", so `ORDER BY rank` gives best matches first. k1=1.2 and b=0.75 are hard-coded. A default weighting can be set with `INSERT INTO ft(ft, rank) VALUES('rank', 'bm25(10.0, 5.0)')`.
- Tokenizers:
  - `unicode61` (default) treats punctuation as separators. `tokenchars` adds characters back as token characters, and `separators` does the reverse.
  - `porter` wraps another tokenizer and stems its output.
  - `trigram` does substring matching (minimum 3 characters).
- **Query-syntax trap:** barewords may only contain ASCII letters, digits, `_` and non-ASCII characters. "Strings that include any other characters must be quoted." User text such as `1/2-13` will raise syntax errors, or be parsed as operators, unless every token is wrapped in double quotes (with embedded `"` doubled).
- Prefix indexes (`prefix='2 3'`) speed up `term*` queries.
- An external-content table (`content='parts', content_rowid='id'`) plus triggers keeps the index in sync with the catalog table.

**Strengths:** exact-token precision on identifiers and codes. Anthropic's retrieval write-up makes the same point: BM25 is "particularly effective for queries that include unique identifiers or technical terms" ([Anthropic, Contextual Retrieval, 2024-09-19](https://www.anthropic.com/engineering/contextual-retrieval)). It is fast and has zero external dependencies.

**Failure modes on industrial data**
- Abbreviations do not match their expansions (`HHCS` vs `hex cap screw`) unless synonyms are added at index time.
- The `unicode61` tokenizer splits `1/2-13x2` into `1`, `2`, `13x2`. That is noisy, because the digits `1` and `2` appear in almost every fastener row.
- Stemming does nothing useful for codes.
- BM25 gives every attribute the same importance: a match on `ZP` can outweigh a mismatch on diameter.

**Suggested FTS5 design [my recommendation, unverified in practice]**
- Index a *canonical* description generated from parsed attributes (§6), not the raw catalog text. Include synthetic attribute tokens that survive tokenisation, for example `hex cap screw d_1_2 tpi_13 unc len_2 gr_5 fin_zp mat_steel`. The underscore is a legal bareword character, so these tokens can be queried without quoting.
- Use columns `(sku, mpn_norm, canonical_desc, synonyms, raw_desc)` with `bm25` weights favouring the identifier and attribute columns.
- Keep a separate trigram FTS table on `sku`, `mpn_norm` and the customer CPNs for partial-ID matching.

---

## 5. Embeddings and hybrid search

### Providers

**Anthropic** says it "does not offer its own embedding model". Its docs name Voyage AI (now part of MongoDB) as "one embeddings provider with a wide variety of models", and add that "you should assess a variety of embeddings vendors" ([Claude docs: Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings)).
- Current Voyage general-purpose models are `voyage-4-large`, `voyage-4` and `voyage-4-lite`. Each has a 32k context and 1024 dimensions by default (256, 512 or 2048 optional). The rerankers are `rerank-3` and `rerank-3-lite`.
- Keys are now created in MongoDB Atlas. The endpoint is `https://ai.mongodb.com/v1/embeddings`.
- Always set `input_type` to `query` or `document`.
- Vectors are unit-normalised.
- The TypeScript client is npm `voyageai` 0.6.0 (2026-11-09). Set its `environment` option to `https://ai.mongodb.com/v1` ([same page](https://platform.claude.com/docs/en/build-with-claude/embeddings)).
- **[marketing]** The FAQ entry "Why do Voyage AI embeddings have superior quality?" is promotional and contains no benchmark on part data.
- Anthropic's own retrieval experiments "found Gemini and Voyage embeddings to be particularly effective" on its document-chunk corpora ([Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)). That evidence is for prose chunks, not part descriptions.

**OpenAI** offers `text-embedding-3-small` (1536 dimensions, 8192-token input, about 62,500 pages per dollar) and `text-embedding-3-large` (3072 dimensions, about 9,615 pages per dollar). The `dimensions` parameter shortens vectors, and the vectors are normalised to length 1 ([OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)). At the guide's assumption of about 800 tokens per page, that works out to roughly $0.02 and $0.13 per million tokens **[derived, check the pricing page]**. SDK: npm `openai` 7.56.0 (2026-11-12).

**Cost at this scale [estimate]:** 5,000 SKUs at about 40 tokens each is about 200k tokens, which costs cents to embed with either provider. Cost does not decide the provider choice.

### Vector storage in SQLite: `sqlite-vec`
- npm `sqlite-vec` 0.1.9 (2026-03-31), with prebuilt binaries for darwin, linux and windows. The README warns it is "pre-v1, so expect breaking changes!" ([GitHub](https://github.com/asg017/sqlite-vec)).
- Recent tags are all alpha prereleases: `v0.1.10-alpha.4` on 2026-05-18, which is also the last push to `main`. The repo has about 250 open issues (`gh api`, 2026-11-12). So: **maintained but slow-moving, and pre-1.0.** It is sponsored by Mozilla Builders and others.
- Usage: `sqliteVec.load(db)` on a `better-sqlite3` or `node:sqlite` connection ([JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)). Define a table with `vec0(embedding float[1024])`. Query with `WHERE embedding MATCH ? AND k = 20 ORDER BY distance`.
- Metadata columns (up to 16), partition keys and `+auxiliary` columns are supported ([vec0 docs](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)).
- The source supports `distance_metric` values L2 (default), cosine and L1 ([sqlite-vec.c](https://github.com/asg017/sqlite-vec/blob/main/sqlite-vec.c)). For unit-normalised vectors, L2 and cosine give identical rankings ([OpenAI guide](https://developers.openai.com/api/docs/guides/embeddings)).
- **Practical note [my estimate]:** at a few thousand vectors, brute-force cosine similarity over a `Float32Array` in plain JS takes milliseconds. sqlite-vec is a convenience, not a necessity. If its pre-v1 status causes friction, store embeddings as BLOBs and score in JS.

### Hybrid fusion
- Reciprocal Rank Fusion: `score = Σ 1/(k + rank_i)`, normally with k = 60. It comes from Cormack, Clarke & Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009 (PDF: http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf). **[I could not extract the PDF text; the formula and k=60 are from memory, corroborated by Garcia's blog, which uses `:rrf_k` = 60.]**
- Alex Garcia's worked FTS5 + sqlite-vec examples show three patterns: keyword-first `UNION ALL`, RRF with per-side weights, and FTS5 results re-ranked by vector distance ([blog, 2024-10-02](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)). For the third pattern, he notes that re-embedding each result is inefficient and that stored vectors should be read instead.
- Anthropic's retrieval experiments: embeddings plus BM25 cut the top-20 retrieval failure rate by 49%, and adding a reranker cut it by 67% (5.7% → 1.9%) ([Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)). This is a different domain, but the direction supports a hybrid design followed by a rerank step.

### Strengths and failure modes on industrial data
- **Strength:** synonyms and paraphrases the abbreviation dictionary missed ("cap screw" vs "bolt", "lock nut" vs "nylon insert nut"), multilingual text, and descriptions with no usable tokens.
- **Failure mode: numbers.** Sub-word models represent numeric values less exactly. In probing studies, "BERT, which relies on sub-word tokenization, is less exact at representing numeric values" than character-level models ([Wallace et al., EMNLP 2019](https://arxiv.org/abs/1909.07940)). Extrapolating **[unverified for current API models]**: `1/2-13x2` and `1/2-13x2-1/2`, `GR5` and `GR8`, or `ZP` and `HDG` will likely embed almost identically. **Use embeddings for recall, never for the final decision.** Always follow with an attribute-level check or an LLM selection step.
- **Failure mode: identifiers.** Anthropic's write-up notes embeddings "can miss crucial exact matches" ([Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)).
- **Mitigation:** embed the *canonical* attribute string (§6), not the raw abbreviation soup, so that `HHCS` and `hex head cap screw` land together.

---

## 6. Normalising industrial description conventions

No free, authoritative abbreviation standard for fastener descriptions was found. ASME B1.1 (unified threads) and ASME B18.2.1 (hex bolts and screws) are paywalled, and ANSI's preview PDF returned 403. Distributors publish their own glossaries. The usual approach is a **hand-maintained dictionary plus a rule-based attribute parser**, which produces a canonical attribute record per line and per catalog row.

**Precedents**
- Ditto (an entity-matching model) improved F1 by up to 9.8% partly through "domain knowledge injection": "highlighting important pieces of input information" such as product IDs before matching ([Li et al., PVLDB 14(1), 2020, arXiv:2004.00584](https://arxiv.org/abs/2004.00584)).
- ETIM is an open classification standard for technical products. It defines product classes with "main technical characteristics", predefined features, values and synonyms per class ([ETIM](https://www.etim-international.com/classification/)). It is a reasonable template for the attribute schema. **[Not verified whether it covers fasteners in depth, or what its licence terms are.]**

**Conventions to parse** (sources are distributor glossaries, so treat them as indicative)

| Attribute | Examples in the wild | Canonical form (suggested) | Source |
|---|---|---|---|
| Product type | `HHCS` = hex head cap screw (also heavy hex cap screw), `SHCS` = socket head cap screw, `FHCS` = flat head cap screw, `FW` = flat washer, `LW` = lock washer, `NT` = nut | `type=hex_cap_screw` | [AFT Fasteners glossary](https://www.aftfasteners.com/common-fastener-related-abbreviations/) |
| Inch thread | `1/2-13` = ½" diameter, 13 threads per inch, UNC (coarse). `-2A` = class 2 external. `NC`/`UNC` coarse, `NF`/`UNF` fine | `dia_in=0.5, tpi=13, series=UNC` | [AFT](https://www.aftfasteners.com/common-fastener-related-abbreviations/); designation format per secondary summaries of ASME B1.1, e.g. [Engineering ToolBox](https://engineeringtoolbox.com/unified-screw-threads-unc-unf-d_1809.html) **[standard text not read]** |
| Metric thread | `M10-1.25x60` = M10, 1.25 mm pitch, 60 mm long | `dia_mm=10, pitch_mm=1.25, len_mm=60` | A distributor listing string `m10-1.25x60 hhcs cl8.8 zp pt din 960` appeared in a web search snippet, but I did not open the page **[unverified]** |
| Length | `x2`, `X 2"`, `x 2-1/2` (fractions) | `len_in=2.0` (decimal) | domain convention **[unverified]** |
| Grade / class | `GR5`, `Gr 8`, `Class 8.8`, `10.9`. A325 ≈ Grade 5, A490 ≈ Grade 8 | `grade=5` | [AFT](https://www.aftfasteners.com/common-fastener-related-abbreviations/) |
| Finish | `ZP` / Zinc-Clear = zinc plated, `ZY` = zinc with yellow chromate, `HDG` = hot dip galvanized, `PL` = plain, `BO` = black oxide | `finish=zinc_clear` | ZY, HDG and Pl from [AFT](https://www.aftfasteners.com/common-fastener-related-abbreviations/). ZP = zinc plated is inferred from distributor listings pairing "ZP" with "Zinc/Clear" **[not defined in a glossary I could read]**. BO **[unverified]** |
| Material | `SS` (also = set screw, so ambiguous), `18-8`, `316`, `STL` | `material=ss_18_8` | [AFT](https://www.aftfasteners.com/common-fastener-related-abbreviations/) (SS ambiguity) |
| Thread length | `PT` = partial thread, `FT` = fine thread *or* fully threaded (ambiguous) | `thread_len=partial` | [AFT](https://www.aftfasteners.com/common-fastener-related-abbreviations/) |
| UOM / pack | `EA`, `BX/100`, `PK`, `C` (per hundred), `M` (per thousand) | `uom=EA, pack_qty=100` | UN/ECE Rec 20 (units) and Rec 21 (package types) are the formal code lists. PEPPOL uses "Rec 20 including Rec 21 codes – prefixed with X" ([PEPPOL code list](https://docs.peppol.eu/pracc/espd/codelist/UNECERec20)). `C`/`M` per-hundred pricing is an industry convention **[unverified]** |

**Practical rules [my recommendations]**
1. Tokenise descriptions with a custom regex lexer that keeps `1/2-13`, `M10-1.25`, `x2-1/2`, `8.8` and `18-8` intact. Do not use a generic tokenizer.
2. Expand abbreviations using a context-aware dictionary. `SS` and `FT` are ambiguous and need resolving from neighbouring tokens: `SS` next to a thread spec and `SET` suggests set screw. Otherwise leave the value ambiguous and let a later stage decide.
3. Convert fractions to decimals and units to one canonical system per attribute. Keep inch and metric parts separate, and never convert between them for matching purposes.
4. Infer defaults explicitly and mark them as inferred. For example, `1/2-13` implies UNC, and a missing finish might mean plain. A mismatch on an *inferred* attribute should cost less than a mismatch on an *explicit* one.
5. Apply the same parser to both catalog descriptions and PO lines, and match on the attribute records. Hard-filter on diameter, thread pitch, length and type. Score softly on finish and grade when they are absent from the PO line.
6. Normalise the UOM and pack quantity separately from the SKU match. A correct SKU with a wrong quantity conversion is still a wrong Sales Order.
7. An LLM can do the extraction too (Claude or OpenAI with a JSON schema), but its output should be validated by the deterministic parser, or vice versa. The regex parser is fast, free, testable, and covers the long tail of standard fastener notation **[recommendation]**.

---

## 7. LLM select-from-shortlist and rerank

**Evidence**
- Peeters, Steiner & Bizer, "Entity Matching using Large Language Models" (EDBT 2025, [arXiv:2310.11244](https://arxiv.org/abs/2310.11244)): "the best LLMs require no or only a few training examples to perform comparably to PLMs", and "there is no single best prompt but that the prompt needs to be tuned for each model/dataset combination." The benchmarks include product-offer matching. The earlier [arXiv:2305.03423](https://arxiv.org/abs/2305.03423) focuses on product matching with ChatGPT.
- Sun et al., "Is ChatGPT Good at Search? Investigating Large Language Models as Re-Ranking Agents" (EMNLP 2023, [arXiv:2304.09542](https://arxiv.org/abs/2304.09542)): "properly instructed LLMs can deliver competitive, even superior results" to supervised rerankers on IR benchmarks.
- A dedicated reranker is a cheaper middle step. Voyage `rerank-3` and `rerank-3-lite` take a query and documents and return them ranked by relevance ([Claude docs: Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings)). There is no published evidence for them on part data **[unverified]**.

**Pattern: select from a shortlist with constrained output**
- Give the model the parsed PO line plus N candidates (10–20), each showing its SKU and canonical attributes. Ask for `{ sku: <one of the candidate SKUs> | "NO_MATCH", confidence, mismatched_attributes[] }`.
- Claude structured outputs are **GA**. Use `output_config.format` with `type: "json_schema"`, or `strict: true` on a tool. `enum` is supported for strings, so a per-request enum of candidate SKUs plus `NO_MATCH` makes a hallucinated SKU impossible ([Claude docs: Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- Caveats from the same page:
  - Enum casing is not guaranteed ("Compare enum values case-insensitively").
  - Schemas are compiled to grammars and cached for 24 hours. Per-request enums therefore change the schema on every call, which may add compile latency **[unverified impact]**.
  - There are limits of 24 optional parameters and 16 union-typed parameters, plus internal size limits.
  - Asking for step-by-step reasoning in a schema property can trigger a refusal ("Ask for a short explanation instead").
  - Batch processing works with structured outputs at a 50% discount, which is useful for eval runs.

**Strengths:** handles the long tail of abbreviations, ambiguity (`SS`, `FT`), implied defaults and odd phrasing. It also explains its choice, which helps the Review Queue.

**Failure modes**
- *Recall ceiling:* it can only pick what retrieval surfaced. Always include `NO_MATCH`, and measure retrieval recall@N separately.
- *Over-confident selection* when the right SKU is missing and a near neighbour (e.g. a different length) is present. Require `mismatched_attributes` and re-check the choice against the deterministic attribute parser.
- *Number sensitivity:* LLMs can slip on fractions. Show both fractional and decimal forms in candidate attributes **[recommendation]**.
- *Prompt sensitivity* across models and datasets, per Peeters et al. Keep a validation set.
- *Cost and latency* per line. Skip the LLM when an earlier deterministic layer is already conclusive.

---

## 8. Vendor claims (for context only) **[marketing]**
- BoltWise claims "93.5%+ on matchable descriptions" and "95%+ on PO matching", with no dataset or methodology given ([BoltWise vs Conexiom](https://getboltwise.com/boltwise-vs-conexiom)).
- Infor's Endries case study reports AI-driven part matching benefits ([Infor](https://www.infor.com/mea/blog/endries-customer-story)). It is a customer story and was not read in full.
- I found no first-party engineering write-ups from large MRO distributors (Grainger, Fastenal, McMaster) on PO-line matching.

---

## 9. Suggested layered pipeline for this prototype

Run the layers in order of cost. Stop at the first conclusive layer, and keep the evidence from each layer for confidence routing and the Review Queue.

1. **Extract** the PO line into `{raw_text, candidate_ids[], qty, uom, description}`. The LLM extraction is covered by ticket 03.
2. **Cross-Reference exact lookup:** `(customer_id, norm(token))` for every candidate ID token. A hit is conclusive once the UOM conversion is checked.
3. **SKU / MPN exact lookup** on the normalised key. Conclusive if there is exactly one hit and the description does not contradict it, where "contradict" is defined by the attribute parser.
4. **Fuzzy ID match:** trigram FTS5 plus `fastest-levenshtein` or Jaro-Winkler on the normalised keys. This step produces candidates only.
5. **Attribute parse** of the description with the regex lexer and abbreviation dictionary (§6) into a canonical record and a canonical string.
6. **Candidate retrieval** with a union of:
   - attribute hard-filter in SQL (type, diameter, pitch, length);
   - FTS5 BM25 over the canonical string and synonyms;
   - optionally, embeddings (`text-embedding-3-small` or `voyage-4-lite`, stored in sqlite-vec or as plain BLOBs) over the canonical string.

   Fuse the results with RRF (k = 60) and take the top 10–20.
7. **Deterministic attribute scoring** of the shortlist. If exactly one candidate matches every explicit attribute, and the next best has a hard mismatch, this is conclusive.
8. **LLM select-from-shortlist** (Claude structured output, enum = candidate SKUs + `NO_MATCH`) for everything else. Cross-check the pick against the attribute record.
9. **Route:** conclusive layers 2, 3 and 7 with agreeing UOM can go straight through, subject to ticket 10. Everything else goes to the Review Queue with the shortlist and the mismatched attributes. Write rep-confirmed resolutions back to the Cross-Reference table.

**Defer at this scale [recommendation]:** embeddings are optional for a synthetic catalog generated from the same attribute vocabulary, because the parser plus BM25 will probably dominate. Add embeddings when the validation set (ticket 09) shows recall misses caused by vocabulary the dictionary lacks. A dedicated reranker (Voyage `rerank-3`) is optional as well, since the LLM selection step covers that role.

**Recommended packages:** `better-sqlite3` (FTS5 bundled), `sqlite-vec` (optional, pre-v1), `fuzzball` (description token scorers), `fastest-levenshtein` (ID keys), `openai` and/or `voyageai` (embeddings), and `@anthropic-ai/sdk` (selection).
