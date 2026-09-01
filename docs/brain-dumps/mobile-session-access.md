---
title: Mobile session access
created: 2026-08-30
updated: 2026-08-30
---

# Mobile session access

Toucan should make it possible to connect to and continue sessions from a mobile device, so an active workspace is not tied to the desktop interface.

## Current understanding

- Remote session access is the core capability.
- SSH is an initial possibility for the connection mechanism, not yet a settled design.
- A separate mobile application may be the right client rather than adapting the desktop application directly.
- If a separate app is built, it needs a distinct, appropriate product name.

## Open questions

- What session state and controls must be available remotely?
- Should SSH be the user-facing transport, an implementation detail, or replaced by a purpose-built secure protocol?
- Should the mobile experience be a native app, a web app, or another form of companion client?
- What name best communicates the mobile app's relationship to Toucan?

## Related topics

- [Architecture and code quality](architecture-and-code-quality.md)
