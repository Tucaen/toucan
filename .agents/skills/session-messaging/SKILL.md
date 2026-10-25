---
name: session-messaging
description: Ask a sibling Toucan agent session in this project a question about its intent, plans or live state, and answer questions sent to you.
disable-model-invocation: true
user-invocable: false
---

# Session messaging

Run `node <this skill>/scripts/message.mjs <command>`. It prints one JSON line with an `ok` field; a refusal carries `error`.

- `list`: sibling sessions of this project you can ask - `shortId`, `title`, `provider`, `role` (`chat` or `ticket`), `ticketId`, `branch`, `state` (`idle`, `working`, `waiting_on_human`, `starting`, `not_running`) and `updatedAt`. Orchestrators are not listed: they may ask, but are never asked.
- `ask --to <shortId> --text <question>`: returns at once with the message `id` and `delivery` (`delivered`, or `queued` with a `note` saying why). Do not wait or poll: the answer arrives later as a new message that starts a turn of yours, so end your turn.
- `reply --id <messageId> --text <answer>`: answers a message delivered to you. If the turn a question started ends without a reply, your final message goes back as an implicit reply.

When to use it: for past facts - what a session did, which files it touched, what failed - use session-records and git, which cost the other session nothing. Message a session for what no record holds yet: its intent, its plan, its live state.

Delivery: an idle session starts a turn with the message; a busy one gets it when its turn ends; one waiting on its human (a permission prompt or a question) gets it once the human has answered and its turn ended - messaging never answers a permission prompt. A session that is not running cannot be asked; use session-records for it instead.

Limits: a chain of questions is at most 3 hops deep (an answer never deepens it) and a session may ask at most 5 times per turn, unless the user configured otherwise. A refused ask is shown to the human on the canvas.
