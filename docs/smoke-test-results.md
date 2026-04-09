# Smoke Test Results

Date: 2026-04-09

These are lightweight real-provider smoke checks used to validate that Berry Agent SDK is not only passing unit tests, but also wiring correctly to live providers.

## Anthropic-compatible

Provider used:
- OpenClaw local provider config: `zenmux`
- API shape: Anthropic Messages-compatible

Validated:
- auth / base URL wiring
- model selection
- streaming text output
- final aggregated result
- file-backed session persistence path

Prompt:
- `请用一句话介绍 Berry Agent SDK。`

Observed result:
- successful response returned
- usage info returned
- no local wiring error

## OpenAI-compatible

Provider used:
- OpenClaw local provider config: `smewfast`
- API shape: OpenAI-compatible chat completions

Validated:
- auth / base URL wiring
- model selection
- streaming text output
- final aggregated result
- file-backed session persistence path

Prompt:
- `Explain Berry Agent SDK in one sentence.`

Observed result:
- successful response returned
- no local wiring error

## Caveats

These were smoke tests, not exhaustive integration tests.

Still worth expanding later:
- tool-call streaming validation against live providers
- stopReason behavior under live tool use
- retry / timeout / abort behavior under real network conditions
