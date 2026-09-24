# Hybrid memory

Each reply receives a compact personal dossier, the current conversation state,
up to 50 timestamped recent messages, an older conversation summary, and relevant
long-term memories. Recent history has a 6,000 estimated-token budget within the
existing 16,000 total input budget. Dates use the user's timezone, falling back
to UTC. Timestamps count toward the history budget.

## Canonical facts and dossier

`Memory` remains the source of truth. `Relationship.userDossier` is a bounded
projection rebuilt in the same transaction as extraction and forgetting. It has
category quotas (6 facts, 4 preferences, 4 habits, 3 inside jokes, 5 current life
situations), a 4,200-character fact-text budget, and no mid-fact truncation. Facts
must have confidence >= 0.75 to appear. Boundaries are separately always supplied.

The extractor must quote the current user message to promote a memory to the
dossier. Companion claims cannot supply that evidence. Inside jokes require user
participation and include the shared reference's origin. Quoted evidence is a
provenance check, not a guarantee that an LLM's interpretation is correct.

Current-life entries expire when specified (capped at 90 days); otherwise they
expire after 7 days. Expired entries disappear from the live dossier at read time,
even if no worker runs. They remain eligible for explicitly historical recall and
are labeled as past situations with unknown outcomes. No TTL index deletes them.

Stable keys replace corrected facts and archive the prior version. Existing keys
and the dossier are provided to extraction to reduce contradictory duplicates.
Sequence checks prevent late workers from overwriting newer facts. The existing
forget endpoint deletes every version of the key and clears old history/summary
context; it now also rebuilds the dossier. Vector hits are checked against current
MongoDB records before injection because Atlas indexing is eventually consistent.

The extractor can record actual assistant callbacks with an exact assistant quote.
These update `lastMentionedAt`, independently of `lastRetrievedAt`. Recent callbacks
are labeled for three days and the prompt discourages repetition. Recent message
history still supplies repetition context while background extraction is pending.

## Retrieval

Keyword matching filters the relationship's active memories before selecting up
to 200 candidates; it is no longer restricted to the first 50 unrelated facts.
This is a bounded regex fallback, not a full-text BM25 engine. At larger scale,
replace it with an Atlas Search lexical index and evaluate recall/latency.

Vector and keyword results are combined with reciprocal rank fusion and deduplicated
by canonical key. Atlas filters include user ID, relationship ObjectId, active
status, and embedding model. Current dossier entries are not duplicated in the
long-term prompt section. Retrieval timestamps do not change fact update dates.
Vector failures fall back to lexical recall; request cancellation still propagates.

`MEMORY_VECTOR_MIN_SCORE` defaults to 0.6. This is a configurable starting point,
not a calibrated probability. Evaluate greetings, paraphrases, named events,
corrections, unrelated queries and forgotten facts on representative conversations
before changing it. No memory system guarantees that the generation model will
use a fact naturally or interpret a correction correctly.

## Enable and maintain Atlas

Configure `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` (or the existing provider key),
`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, and `MEMORY_VECTOR_INDEX`.
For OpenRouter use `openai/text-embedding-3-small`; old unprefixed
`text-embedding-*` names are normalized only for OpenRouter endpoints.

```sh
npm run memory:audit
npm run memory:backfill
npm run memory:audit
```

Audit is read-only. Backfill verifies the embedding provider, creates/updates the
named vector index, embeds missing or incompatible active memories, and reviews
legacy facts against original and nearby historical user messages for dossier inclusion. It makes
provider calls and database writes; progress logs contain counts, not user text.
It does not send chat messages. Missing/ambiguous evidence is not promoted.

Backfill is resumable: vectors use conditional writes so corrections or deletions
during provider calls cannot be overwritten. Legacy review records
`dossierReviewedAt` and `dossierReviewVersion`; completed reviews at the current
version are skipped on reruns. This also repairs legacy source references that
pointed to an acknowledgement instead of the original user disclosure. A relationship write
in each transaction makes concurrent forgetting conflict and retry safely.

Only set `MEMORY_VECTOR_SEARCH_ENABLED=true` after the named index is queryable
and backfill succeeds. Restart the backend to load .env changes. Index propagation
may lag writes. New extraction creates embeddings while search is enabled. Rerun
the maintenance command after provider failures or model/dimension changes; all
query and stored vectors must use the same model and dimensions.

For embedding-only maintenance, run:

```sh
node scripts/memory-maintenance.js --apply
```

## Verification

`npm test` includes real MongoDB replica-set integration coverage for greeting
familiarity, corrections, forgetting, history limits/dates, scoped retrieval,
stale vector results, late jobs, and backfill races. Vector-search aggregation is
mocked locally because mongodb-memory-server does not run Atlas Search; validate
the actual index and provider separately against Atlas.
