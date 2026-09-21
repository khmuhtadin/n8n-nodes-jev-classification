# Changelog

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
