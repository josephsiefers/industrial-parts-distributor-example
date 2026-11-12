# Extract-then-resolve: the LLM copies, code interprets

Turning a Purchase Order into a Sales Order is split into two stages with a stored artifact between them. **Extraction** has the LLM copy the Purchase Order exactly as written: numbers are parsed into numbers, units, dates, addresses and part identifiers stay verbatim, and the LLM makes no business decisions. **Resolution** then builds the Draft Sales Order with deterministic code against ERP master data: customer, Ship-To, SKU, Unit of Measure conversion and price. The LLM is used again only to choose from a closed list of candidates. We chose this so that every decision with business consequences is auditable ("misread or misinterpreted?"), testable on its own (the extraction eval measures copying accuracy, and conversions get unit tests), and never invented by the model. The cost is more stages and more code than asking the model for the Sales Order directly.

## Considered Options

- **Template / rule-based per-sender profiles.** Very accurate for known layouts, but they break on new ones and every Customer needs onboarding work.
- **End-to-end / direct-to-target.** The LLM outputs the Sales Order with catalog and Customer data in the prompt. It has the fewest parts, but the model guesses pack sizes and SKUs, and errors can't be diagnosed.
- **Agentic / tool-use.** The LLM calls lookup tools and assembles the order itself. It is flexible, but decisions are left to the model, and it is harder to evaluate and less deterministic.

The last two are worth measuring against this approach with the eval harness as a future, separate effort.

## Consequences

- The extraction schema is shared by Claude and OpenAI, so it is limited to 16 nullable fields (see `docs/research/llm-structured-output-and-documents.md`). Copying addresses as single text blocks and identifiers as a labelled list keeps it under the limit.
- The extraction is kept unchanged as the record of what the Customer sent. Interpreted values, their sources, and rep corrections live only on the Draft Sales Order.
