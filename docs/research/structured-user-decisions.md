# Structured user decisions in Codex, Claude, and ACP

Research date: 2026-09-02

## Executive answer

The official integrations do not discover decisions by parsing assistant prose. Codex and Claude both expose a model-invoked, structured user-input tool. The request contains the real questions, option labels, and option descriptions, and it pauses the active turn until the client returns an answer. A client can therefore render a reliable multi-question panel and bind free-text “Other” answers to the exact pending question.

Toucan already has adapters capable of translating those native requests into ACP form elicitation, but currently advertises only `elicitation.url`. Consequently:

- `codex-acp` returns an empty answer instead of forwarding Codex user-input questions.
- `claude-agent-acp` does not take its `AskUserQuestion` form-elicitation branch.
- Toucan sees ordinary assistant text and relies on `decision-message.ts` heuristics, which cannot reliably recover question/option boundaries or resolve the provider's paused request.

The direct fix direction is to support and advertise ACP `elicitation.form`, represent its request/response as a first-class pending decision, and reserve prose recognition as a legacy fallback (if retained at all).

## Codex

### Provider event

Codex's model calls the structured `request_user_input` tool. Its official tool schema instructs the model to send one to three questions, each with:

- stable `id`;
- short `header`;
- full `question`;
- two or three mutually exclusive `options`, each with `label` and `description`;
- the recommended option first and labeled `(Recommended)`;
- no authored “Other” option, because the client adds free text.

See the official [tool specification](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) and [protocol types](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/request_user_input.rs). The app-server sends this as the server-initiated `item/tool/requestUserInput` JSON-RPC request; the response maps question IDs to answer arrays, and `serverRequest/resolved` cleans up the pending request. See the official [app-server request_user_input contract](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#request_user_input).

This means the LLM explicitly identifies the questions and choices. They are not inferred from its prose.

### Official multi-question interaction

The open-source Codex TUI keeps a current question index plus per-question answers and drafts. Left/right navigation switches questions, accepting a selection advances to the next question, and final submission returns all answers together. Its ordinary input surface is repurposed for the current question's notes/free-text while the overlay is active. See the official [Codex TUI request-user-input implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs).

That supports the user's observed VS Code design: one question visible at a time, navigation across all questions, retained answers, and one final structured response. The public source proves navigation but not the closed VS Code extension's exact DOM or tab implementation.

### Shape reaching ACP clients in this checkout

The installed `@agentclientprotocol/codex-acp` 1.1.10 receives Codex app-server `item/tool/requestUserInput`. When the client advertises form elicitation, its `CodexElicitationHandler.buildUserInputRequest` sends:

```json
{
  "method": "elicitation/create",
  "params": {
    "sessionId": "...",
    "toolCallId": "<Codex item id>",
    "mode": "form",
    "message": "Input requested",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "<question id>": {
          "type": "string",
          "title": "<short header>",
          "description": "<full question>",
          "oneOf": [{ "const": "<label>", "title": "<label>", "description": "<option explanation>" }]
        },
        "<question id>__other": {
          "type": "string",
          "title": "Other",
          "description": "Type your own answer instead of choosing an option above."
        }
      }
    }
  }
}
```

Each original question becomes one property. An optional companion field represents “Other.” An accepted ACP response is converted back to Codex's question-ID-keyed answer map. If the client does not advertise `elicitation.form`, the adapter returns `{ answers: {} }` instead. Evidence: installed `node_modules/@agentclientprotocol/codex-acp/dist/index.js`, `CodexElicitationHandler` (package source: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)).

## Claude

Claude uses the structured `AskUserQuestion` tool. The official Agent SDK documentation says it reaches the host through `canUseTool`, pauses execution until the callback responds, and is distinct from normal conversation/streaming input. Claude generates one to four questions, each containing a full `question`, short `header`, two to four options with `label` and `description`, and a `multiSelect` flag. See Anthropic's official [user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input) and [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#askuserquestion).

The answer is supplied through `updatedInput.answers`, keyed by the original question text; multi-select labels are comma-joined. See Anthropic's official [AskUserQuestion hook contract](https://code.claude.com/docs/en/hooks#askuserquestion).

The installed `@agentclientprotocol/claude-agent-acp` 0.66.0 catches `AskUserQuestion` in `canUseTool` and, when the client advertises form elicitation, maps all questions into one ACP form:

- `question_0`, `question_1`, etc. hold single-select `oneOf` or multi-select `anyOf` option schemas;
- `question_0_custom`, etc. are per-question “Other” fields;
- a custom answer takes precedence over that question's selected option;
- the accepted form is translated into the tool's `updatedInput.answers`, allowing the paused tool call to continue.

Evidence: installed `node_modules/@agentclientprotocol/claude-agent-acp/dist/elicitation.js` and `dist/acp-agent.js` (package source: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)).

## ACP contract

ACP form elicitation is explicitly designed for this boundary. The agent sends `elicitation/create` with `mode: "form"`, explanatory `message`, optional `toolCallId`, and a restricted flat JSON Schema. Single-select choices use `oneOf`; each option may have a stable `const`, display `title`, and explanatory `description`. The client chooses the UI, must let the user review/modify answers before sending, and returns `accept`, `decline`, or `cancel`. Clients advertise support with a non-null `clientCapabilities.elicitation.form`. See the official [ACP elicitation specification](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx).

ACP does not prescribe tabs versus a wizard. Either rendering can preserve the structured semantics. A multi-step/tabbed panel is a client UI decision over the schema's ordered properties.

## Exact Toucan gap

In `src/main/acp-session-manager.ts`, Toucan currently:

1. advertises `elicitation: { url: {} }`, not form support;
2. handles `elicitation/create` only for URL mode;
3. declines every form request;
4. derives decisions later from plain `{ type: 'message', role: 'assistant', text }` events.

This is why prose such as numbered implementation recommendations can become clickable, while a normal composer answer cannot settle the actual provider request. A normal prompt/steering message and an elicitation response are different protocol operations.

## Product implications

- Add `elicitation.form` to the client handshake only once Toucan can retain, render, answer, cancel, and restore the request safely.
- Carry the complete structured form request through main/preload/renderer rather than flattening it into message text.
- Model one pending form with multiple question fields. Render one question at a time with tabs or previous/next navigation, retain each answer/draft, then submit all fields in one ACP `accept` response.
- While an elicitation is pending, hide or replace the normal composer. Free text belongs in that question's explicit “Other” field and must resolve the pending RPC.
- Use schema `title`/`description`/`oneOf` as authoritative labels and explanations. Do not synthesize clickable controls from arbitrary prose.
- Keep permission approval (`session/request_permission`) separate from information elicitation (`elicitation/create`); both pause work, but their response contracts differ.
- Add deterministic UI tests by injecting a synthetic `elicitation/create` request with two questions. No model cooperation is needed to exercise the complete renderer flow.
