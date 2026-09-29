# Jev model routing assessment for Toucan

Research date: 2026-09-29

## Executive answer

TypeSafe's Jev is a promising decision engine for an **optional** Toucan model router, but it is not itself a coding model or agent. It accepts application state plus typed questions and returns choices, scores, probabilities, and confidence. TypeSafe explicitly lists routing to a fixed set of destinations as a suitable use case and explicitly says Jev cannot replace the model behind a coding agent ([Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents), [intent routing](https://docs.typesafe.ai/patterns/intent-routing)).

The best initial shape for Toucan is conservative session routing: when a user starts an Auto chat, ask Jev to choose among models the user has enabled, apply a confidence threshold, then launch that provider/model and keep it for the session. Per-turn switching within one provider is a possible later experiment. Seamless per-turn switching between Claude and Codex is not a good first design because their ACP adapters own different sessions, transcripts, tool behavior, authentication, and model catalogues.

## What Jev offers

- The HTTP endpoint is directly callable at `POST https://api.typesafe.ai/v1/systemone` with a TypeSafe API key; `jev-latest` is the documented model alias ([quick start](https://docs.typesafe.ai/introduction/quickstart), [API reference](https://docs.typesafe.ai/api)).
- A `choice` selects one of up to 255 caller-defined options and returns the full probability distribution plus confidence. Multiple independent questions can be evaluated in one call ([API reference](https://docs.typesafe.ai/api), [introduction](https://docs.typesafe.ai/introduction)).
- TypeSafe recommends confidence-gated routing: use the answer to select a destination and confidence to decide whether to act, fall back, or ask a human ([confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)).
- TypeSafe reports 70–500 ms latency and $0.042 per million input tokens, but these are vendor claims from an early-access launch and its own workflow evaluations; they should be validated on Toucan traffic before being used in product promises ([launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).
- The API can return `401`, validation errors, rate limits, and overload responses. The official SDKs retry rate-limit and overload failures by default; a direct Toucan client would need an explicit bounded fallback policy ([API reference](https://docs.typesafe.ai/api)).

## Relation to the Factory example

[Factory Router](https://factory.com/product/router) demonstrates the desired product experience: an Auto entry in the model picker, visible underlying model choice, cheaper models for eligible work, stronger models for difficult work, and recovery when a model struggles. Factory's public page does not say that its router uses Jev, so it is an interaction reference rather than evidence about Jev's implementation.

Factory reports substantial production savings, but those numbers are Factory-specific and compare against its own top-tier pricing. They do not predict savings for Toucan users whose Claude and Codex access may be subscription- or quota-based rather than metered identically ([Factory Router](https://factory.com/product/router)).

## Toucan integration options

### 1. Native Jev session router — recommended experiment

Add an `Auto` launch policy rather than a third agent provider. The router receives the first prompt, relevant request metadata, and a bounded candidate list derived from Toucan's remembered provider model catalogue. Each option needs a stable provider/model id and a curated capability/cost description. Toucan applies its own confidence threshold and deterministic constraints, then creates the ordinary Claude or Codex ACP session with the chosen model.

This keeps the routing module deep: one interface such as `route(request): RouteDecision`, with TypeSafe access, question construction, confidence policy, timeouts, failure fallback, privacy minimization, and observability hidden inside. The returned decision should include provider, model, confidence, reason category, and whether fallback was used. The chat must visibly retain both `Auto` and the actual routed provider/model.

Start with one decision per new session. The user can override it, and unavailable/low-confidence/error cases use a configured default. A session-level decision avoids pretending that Claude and Codex conversations can migrate between their distinct provider sessions.

### 2. Same-provider per-turn routing — possible second phase

Toucan already supports changing models at a safe turn boundary through ACP. Jev could choose among models advertised by the current provider before each new turn. This is closer to Factory's per-task behavior but has costs: model-specific prompt caches go cold, reasoning/effort settings differ, and the prompt alone may not reveal task difficulty until the agent inspects the repository. Evaluate it only after session routing has outcome data.

### 3. Factory Droid as a third ACP provider — quickest way to use Factory Router

Factory Droid can run as an ACP agent (`droid exec --output-format acp`), and Factory's SDK documents model id `auto` for Factory Router ([Factory IDE integrations](https://docs.factory.ai/ide-integrations), [Droid Python SDK](https://docs.factory.ai/sdk/python)). Adding Droid to Toucan would reuse Factory's router rather than building a Jev router. It would, however, require a Factory account/billing path and a third agent integration; it would not use the user's existing Claude/Codex sessions or prove that Factory's router is Jev-based.

### 4. Existing decision delegation — useful but not model routing

Toucan already has an opt-in `Decision delegation` preference that detects the TypeSafe Claude plugin and asks the main model to use Jev for decision-shaped subtasks. This is valuable for classification, ranking, and scoring inside a turn, but it is requested rather than enforced and does not choose the coding model that serves the turn. Keep it as a separate feature.

## Optionality and safeguards

- Default Off. Show Auto only after the user configures TypeSafe access and at least two eligible candidates.
- Store credentials through a main-process secret abstraction; never persist the API key in workspace state or expose it to the renderer.
- Send the minimum state needed for routing and disclose that prompt/context is sent to TypeSafe in addition to the selected model provider.
- Apply hard capability filters before Jev (images, context size, required tools/provider features); use Jev only among eligible options.
- Define deterministic fallbacks for timeout, low confidence, rate limiting, and a stale model catalogue. Routing failure must not prevent a normal chat.
- Log decision metadata without prompt contents: candidates, choice, confidence, latency, fallback, eventual user override, and task outcome. Compare quality and realized quota/cost against a no-routing baseline before making routing the default.

## Recommendation

Run a narrow opt-in experiment with two or three well-understood candidates and one decision per new session. Treat confidence as a gate, not decoration, and fall back to the user's preferred strong model whenever the model catalogue is incomplete or Jev is uncertain. Do not attempt automatic cross-provider switching mid-conversation in the first version.

