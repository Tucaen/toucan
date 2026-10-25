# Sibling-session messaging (#2)

v1 carries **asks only**: one session asks a sibling session of its project a question and the answer comes back as a message of its own. A handoff is a later follow-up on the same channel. Canvas rendering is #3.

## Settled design

- **Interface**: a dependency-free CLI beside session-records, usable by Claude and Codex sessions: `list`, `ask --to <shortId> --text`, `reply --id <msgId> --text`. A short id is the first 8 characters of the node id; there is no `ticket:<id>` addressing.
- **Reach**: same project only, any provider. Chats and ticket sessions are targets; orchestrators are not, but may send.
- **Delivery**: an idle target starts a new turn with the message. A busy target gets it when its turn ends - it is never steered. A target with a pending permission prompt or question queues it, and the asker is told `queued: target waiting on human`; messaging never answers a permission prompt. A target that is closed, exited or not running is refused, with a pointer to session-records.
- **The asker is never blocked**: `ask` returns at once and the answer wakes the asker as a new message.
- **Reply**: the target calls `reply --id`. When the turn the question started ends without one, its final text goes back marked implicit.
- **Safety**: hop depth limit 3 (a reply cannot start a deeper chain) and at most 5 asks per session per turn, both settings in `<userData>\session-messaging.json`. Turns that messages start are ordinary turns, so they count wherever provider pacing counts working sessions. An ask over a limit is refused by the CLI and published as a canvas notice for the human.
- **Persistence**: queued messages and open asks persist in `<userData>\session-messages.json` and are delivered once the target runs again after a restart. A question whose turn was cut short - by a stop, a crash or a restart - goes back to the queue and is asked again once its target runs; an asker whose target left the canvas is woken with `target closed; use session-records`.
- **Tool guidance**: the session instruction says to prefer session-records and git for past facts, and messaging for intent, plans and live state. No automatic routing.
- **Human visibility**: every message and reply reaches the canvas (`sessionMessagingApi`, #3 renders inline entries and a temporary edge while an ask is open). There is no approval step.

## Where it lives

- `src/shared/session-messaging.ts` - vocabulary, settings parsing, delivery verdict, prompt and instruction texts, canvas event types.
- `src/main/session-messenger.ts` - delivery, queueing, reply routing, implicit replies, limits, restart persistence.
- `src/main/messaging-endpoint.ts` - the per-node token and localhost listener the CLI talks to.
- `src/main/session-messaging-directory.ts` and `src/main/session-messaging-store.ts` - the canvas's sessions as messaging sees them, the message file and the settings file.
- `.agents/skills/session-messaging/` - the agent-facing skill and CLI.
