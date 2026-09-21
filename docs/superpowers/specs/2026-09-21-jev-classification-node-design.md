# n8n-nodes-jev-classification — design

Date: 2026-09-21. Status: approved for implementation.

## Goal

An n8n community node for **Jev**, TypeSafe AI's System One model
(`POST https://api.typesafe.ai/v1/systemone`). Jev takes text (state) plus typed
questions and returns typed answers with calibrated probabilities: it classifies,
scores and checks, it does not generate text. Typical latency 70–500 ms, input
tokens $0.042/M, output free.

The package must pass n8n verification: scaffolded by `@n8n/node-cli`, zero runtime
dependencies, MIT, English only, no env/fs access, published from GitHub Actions
with npm provenance.

## Positioning

Three community packages already wrap this API (`n8n-nodes-jev`,
`n8n-nodes-typesafe`, `n8n-nodes-typesafe-ai`). All process items one request at a
time. This package is the *classification* node that feels like n8n's built-in
**Text Classifier** (categories → one output branch per category) and is built for
throughput:

- **Parallel requests** across items (worker pool, default 4).
- **Many items per request** (optional fan-out: N items packed into one `state`,
  one question per item, answers demuxed). TypeSafe's own benchmark: 12x cheaper,
  10x faster than separate calls.
- Retries with exponential backoff on 429/529, honoring `retry-after`.

## Package

- name `n8n-nodes-jev-classification`, version starts at 0.1.0
- repo `https://github.com/khmuhtadin/n8n-nodes-jev-classification`
- author khmuhtadin <contact@khmuhtadin.com>, MIT
- style: programmatic (needed for concurrency, batching and dynamic outputs)
- devDeps only: `@n8n/node-cli`, eslint, prettier, typescript, release-it, vitest
- `n8n.strict: true`, default eslint config untouched (cloud eligibility)

## Credential — `jevClassificationApi`

displayName "Jev (TypeSafe) API". One field: **API Key** (password). Sends
`Authorization: Bearer <key>`. Test request: `GET https://api.typesafe.ai/v1/models`.
documentationUrl → README credentials section. Base URL is a constant
`https://api.typesafe.ai` in code, not a credential field.

## Node — `jevClassification`, displayName "Jev Classification"

`group: ['transform']`, `usableAsTool: true`, one main input, dynamic outputs.
Subtitle `={{$parameter["operation"]}}`.

### Parameters (top → bottom)

1. **Operation** (`operation`, options, noDataExpression):
   - `classify` — name "Classify", action "Classify text into categories",
     description "Pick one category and route the item to that output"
   - `score` — "Score", action "Score text against levels",
     description "Rate the text on an ordered scale you define"
   - `check` — "Check", action "Check whether a statement is true",
     description "Yes/no question, routes to Yes or No output"
   - `ask` — "Ask Questions", action "Ask custom questions",
     description "Send any mix of questions as JSON, get all answers"
2. **Input** (`inputType`, options): `text` (default) "Text", `json` "JSON",
   `item` "Whole Input Item".
   - `text` → **Text** (`text`, string, rows 3, required, placeholder
     "e.g. {{ $json.message }}")
   - `json` → **JSON** (`json`, json, required, default `{}`)
3. **Instructions** (`instructions`, string, rows 2, required; hidden for `ask`).
   Placeholders per operation: classify "e.g. Which team should handle this ticket?",
   score "e.g. How frustrated is the customer?", check "e.g. Does the message ask for a refund?".
4. classify → **Categories** (`categories`, fixedCollection, multipleValues,
   entries `category` (required, noDataExpression) + `description` (optional)).
   Category names become outputs, so they can't be expressions. Min 2.
5. score → **Levels** (`levels`, fixedCollection, multipleValues, entry `level`
   (required)). Ordered lowest → highest. Min 2, max 10.
6. check → **Yes Means** (`yesMeans`) / **No Means** (`noMeans`), optional strings.
7. ask → **Questions** (`questions`, json, required). A `questions` map exactly as in
   the API reference (`{ id: { type, instructions, criteria } }`).
8. **Options** (collection):
   - **Model** (`model`, options): `jev-latest` (default), `jev-preview`, plus
     `custom` → **Model ID** string (e.g. `jev-1.13.0`).
   - **Confidence Threshold** (`confidenceThreshold`, number 0–1, default 0.5).
     classify/score: below this the item is marked `needsReview` and (classify) goes
     to the "Needs Review" output. check: probability ≥ threshold means Yes.
   - **When Uncertain** (`uncertainHandling`, options, classify only):
     `review` (default) "Send to Needs Review output", `best` "Send to best category anyway".
   - **Items per Request** (`itemsPerRequest`, number, default 1, min 1, max 50).
     Packs N items into one request as `state = { items: [...] }`, one question per
     item with instructions prefixed "About `items[i]` only: ". Description warns that
     large states reduce accuracy and that state + longest question must fit 32k tokens.
   - **Parallel Requests** (`concurrency`, number, default 4, min 1, max 20).
   - **Max Retries** (`maxRetries`, number, default 3, min 0, max 10) on 429/529/5xx.
   - **Timeout** (`timeout`, number ms, default 60000).
   - **Output Field** (`outputField`, string, default `jev`).
   - **Include Input Fields** (`includeInput`, boolean, default true). Boolean
     descriptions start with "Whether …".

### Outputs

`outputs` is an expression evaluating a `configuredOutputs($parameter)` function
(same pattern as n8n's Text Classifier):

- classify → one output per category name, plus "Needs Review" when
  `uncertainHandling` is `review` (default).
- check → `Yes`, `No`.
- score, ask → single output.

### Output item shape

`{ ...input.json (if includeInput), [outputField]: result }`, `pairedItem` set.

- classify: `{ category, confidence, needsReview, probabilities, model }`
- score: `{ score, level, confidence, needsReview, probabilities, legend, model }`
  (`level` = text of the most probable level)
- check: `{ answer: boolean, probability, model }`
- ask: `{ answers, usage, model }` (raw API answers map)

### Request building (pure helpers, unit tested)

`nodes/JevClassification/helpers.ts` exports:

- `buildQuestion(op, params) → Question` for classify/score/check
- `buildRequests(states, questionsPerItem, itemsPerRequest) → Request[]` packs items
  (state `{items:[...]}` and question keys prefixed `i<idx>_` when N>1, plain
  otherwise), returns for each request the list of item indexes it covers
- `splitAnswers(response, request) → per-item answers`
- `toResult(op, answers, options) → result object` (+ output index for routing)
- `retryDelayMs(attempt, retryAfterHeader) → ms` (exponential, base 500 ms, cap
  8 s, honors retry-after seconds)
- `runPool(tasks, concurrency)` ordered results

`execute()` only orchestrates: read params → build states → build requests →
`runPool` of `sendRequest` (uses `this.helpers.httpRequestWithAuthentication` with
`returnFullResponse` + `ignoreHttpStatusErrors`, retry loop) → demux → route.

### Errors

- 401 → NodeOperationError "The TypeSafe API key was rejected. Check the credential."
- 422 → NodeOperationError with the API `detail` message, itemIndex
- 429/529 after retries → NodeApiError "TypeSafe is rate limiting or overloaded. Lower Parallel Requests or retry later."
- other → NodeApiError.
- `continueOnFail()` → failed item(s) get `{ error }` in json on output 0.
- Validation: <2 categories/levels, empty instructions, invalid JSON → NodeOperationError before any request.

## Testing

- `test/helpers.test.ts` (vitest): question building for all ops, batching pack/
  unpack for N=1 and N>1, result shaping, routing index, retry delay, pool ordering.
- `test/node.test.ts`: `execute()` with a fake `IExecuteFunctions` (stub
  `httpRequestWithAuthentication`), covering classify routing incl. Needs Review,
  check Yes/No, batching demux, retry on 429, continueOnFail.
- `scripts/smoke.ts`: hits the real API using `TYPESAFE_API_KEY` from env (script
  only; node code never touches env), runs all four operations through the compiled
  node with a fake context. Run manually: `npm run smoke`.

## CI / release

- `ci.yml`: lint, build, test on PR and push to main.
- `publish.yml`: from n8n-nodes-starter, tag `*.*.*` → `npm run release` with
  `id-token: write` (npm provenance). Auth: `NPM_TOKEN` secret (granular token) or
  npm Trusted Publisher once the package exists.
- All commits authored by the repo owner; no AI co-author trailers.

## Docs

README (English): what Jev is, why this node (table vs LLM classifier), install,
credentials, each operation with screenshots-free examples, output shapes, options
(batching/concurrency guidance from TypeSafe's jaggedness page), example workflows
in `examples/*.json`, limits/costs, development, license.
