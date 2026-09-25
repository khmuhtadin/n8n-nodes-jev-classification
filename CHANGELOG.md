# Changelog

## 0.3.0 (2026-09-26)

- Credential: new **Base URL** field (default `https://api.typesafe.ai`) so the node can call Jev through OpenRouter (`https://openrouter.ai/api`) or the Vercel AI Gateway (`https://ai-gateway.vercel.sh/typesafe`). Existing credentials keep the TypeSafe URL. Closes #1.
- Credential test now sends one tiny real request to `/v1/systemone` instead of listing models, because gateways serve the models list without a key.

## 0.2.0 (2026-09-21)

- Classify: new **Categories Source** option. **Fixed** (default) keeps one output per category. **Dynamic** reads the categories per item from a comma-separated string, a JSON array or a JSON object of name to description, so they can come from an expression or be filled by an AI Agent. Dynamic mode has a single **Result** output.
- When Uncertain is hidden in dynamic mode (no Needs Review output); `jev.needsReview` is still set.

## 0.1.1 (2026-09-21)

- Fix: the regular "Jev Classification" node was hidden from the nodes panel (only the AI Agent tool variant showed). The node codex now uses the same AI category and subcategories as n8n's built-in Text Classifier, so it appears under Advanced AI and in search.
- Add search aliases: jev, typesafe, classify, classifier, router, score, sentiment, triage.

## 0.1.0 (2026-09-21)

Initial release.

- Node **Jev Classification** (`n8n-nodes-jev-classification.jevClassification`, typeVersion 1) for the TypeSafe AI System One API (`POST /v1/systemone`).
- Credential **Jev (TypeSafe) API** (`jevClassificationApi`) with API key, bearer auth and a connection test against `GET /v1/models`.
- Operations:
  - **Classify**: pick one category, one output branch per category plus a **Needs Review** branch for low confidence.
  - **Score**: rate text on an ordered scale you define, returns probability-weighted score, most probable level, legend and confidence.
  - **Check**: yes/no question, routes items to **Yes** or **No**.
  - **Ask Questions**: send any mix of choice, score and noul questions as raw JSON and get the answers map back.
- Input from a text expression, a JSON expression, or the whole input item.
- Options: Model (`jev-latest`, `jev-preview`, custom ID), Confidence Threshold, When Uncertain, Items per Request (pack up to 50 items into one request), Parallel Requests (worker pool, up to 20), Max Retries with exponential backoff honoring `retry-after`, Timeout, Output Field, Include Input Fields.
- Retries on 429, 529 and 5xx; clear errors for 401 and 422; `continueOnFail` support.
- `usableAsTool: true` so the node can be attached to an AI Agent.
- Example workflows in `examples/`, unit tests with vitest, smoke script against the live API.
