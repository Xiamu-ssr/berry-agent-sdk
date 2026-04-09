# Examples

## Prerequisites

Node 22+ is recommended.

Examples read credentials from environment variables.

The examples automatically load `.env` from the repo root.

So you can simply do:

```bash
cp .env.example .env
```

and fill the values, or export them in your shell if you prefer.

---

## 1. Basic example

```bash
npm run smoke:basic
```

Shows:
- streaming text events
- tool loop
- session resume

---

## 2. Anthropic smoke test

Required env:

```bash
export ANTHROPIC_API_KEY=...
export ANTHROPIC_BASE_URL=...   # optional
export ANTHROPIC_MODEL=...      # optional
```

Run:

```bash
npm run smoke:anthropic -- "请用一句话介绍 Berry Agent SDK。"
```

What it verifies:
- provider auth/baseURL/model wiring
- streaming output
- final response aggregation
- file-backed session persistence

---

## 3. OpenAI-compatible smoke test

Required env:

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=...      # optional
export OPENAI_MODEL=...         # optional
```

Run:

```bash
npm run smoke:openai -- "Explain Berry Agent SDK in one sentence."
```

What it verifies:
- OpenAI-compatible provider wiring
- streaming output
- final response aggregation
- file-backed session persistence

---

## Notes

- These are **real integration smoke scripts**, not unit tests.
- They currently do not register tools by default.
- Session files are written under `.berry/` and are gitignored.
