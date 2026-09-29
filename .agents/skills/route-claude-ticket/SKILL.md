---
name: route-claude-ticket
description: Fetch one ticket and ask Jev which currently advertised Claude model and effort should implement it.
disable-model-invocation: true
user-invocable: true
---

# Route Claude Ticket

Act as a dispatcher. Resolve the requested ticket, pass its evidence to Jev, and return Jev's model and effort recommendation for a new conversation. Finish after reporting the route; the dispatcher neither implements the ticket nor changes its own model.

Run commands from the Toucan repository root.

## 1. Resolve the task

Treat the text following the skill invocation as a ticket identifier, ticket link, or complete task description.

- For an identifier or link, use the connected ticket source. A Notion ticket is read through the available Notion connector or MCP, not through web search.
- Collect the title, description, acceptance criteria, labels, affected area, and only those comments that change the current scope. Preserve uncertainty as data; make no complexity judgment yourself.
- For a complete task description, use it directly.

This step is complete when the state contains enough evidence to distinguish routine execution from difficult diagnosis or architecture. If the source cannot be read, stop and ask the user to paste the ticket; an identifier alone is not routing evidence.

## 2. Prepare the request

Write one temporary JSON file outside the repository. It contains `task` and no credentials:

```json
{
  "task": {
    "id": "CIC-13",
    "title": "...",
    "description": "...",
    "acceptanceCriteria": ["..."],
    "labels": ["..."]
  }
}
```

The helper reads Claude candidates from Toucan's latest `agent-models.json`, which is populated from ACP session configuration. It removes the `default` alias because that duplicates a concrete model. To override discovery, add `models` using exact ACP ids, names, and descriptions. Supply every currently advertised concrete Claude model and invent none.

This step is complete when the temporary file parses as JSON and represents every scope-bearing ticket field.

## 3. Ask Jev

Run:

```text
node .agents/skills/route-claude-ticket/scripts/route-ticket.mjs --input <temporary-json-file>
```

The helper reads `TYPESAFE_API_KEY`, sends one request to `jev-latest`, and prints one JSON object. It asks Jev separately for the least-powerful adequate model and for reasoning depth, then maps the latter to `low`, `medium`, `high`, `xhigh`, or `max`. Remove only the exact temporary file after reading the result.

On an error result, report its `error` and stop. A missing key is resolved by launching Toucan with `TYPESAFE_API_KEY` available to the agent process. Do not inspect or print the key.

This step is complete when the helper returns `ok: true` and its chosen model id exists in `candidates`.

## 4. Report the route

Copy the helper's result without re-ranking it:

```text
Claude routing recommendation
Model: <name> (<id>)
Effort: <effort>
Model confidence: <confidence>
Model probabilities: <one line per candidate>
Reasoning-depth score: <score>
Review required: <yes when reviewRequired is true, otherwise no>
```

When review is required, state that Jev was uncertain and leave the final choice to the user. Mention that effort is advisory and the user should choose the closest value the selected model's new-session picker offers. End with: `Start the implementation in a new conversation using this route.`
