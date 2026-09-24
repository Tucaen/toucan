# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's tracker (`Tucaen/toucan` on GitHub).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | _not in use_         | Maintainer needs to evaluate this issue  |
| `needs-info`               | _not in use_         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | _not in use_         | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding label string from this table. Where the right-hand column says _not in use_, **do not create the label** — the repo deliberately does not carry it. Skip that step and say so instead of inventing a substitute.

This is a solo repo, so the inbound-triage roles (`needs-triage`, `needs-info`, `ready-for-human`) have no queue to feed: the author writes the issues. The two that survive are the ones that gate agent work.

Repo-specific labels that are *not* triage roles — `blocked`, `backlog`, `frontier-model` — are documented in `issue-tracker.md`.
