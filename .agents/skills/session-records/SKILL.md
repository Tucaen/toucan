---
name: session-records
description: Search Toucan's session outcome records (what earlier agent conversations did, touched and failed on) by file, failure text, title or date.
disable-model-invocation: true
user-invocable: false
---

# Session records

Run `node <this skill>/scripts/query-sessions.mjs --dir <outcomes dir> [filters]`. It prints one JSON line: `{ ok, project, total, returned, more?, records }`, newest first. Each record is its frontmatter plus a `file` name and, only where a filter matched, `sections`.

Filters combine (AND). Text filters are case-insensitive substrings.

- `--file <text>`: written files; returns the matching `files` lines.
- `--failure <text>`: turn failures and tool failures; returns the matching lines.
- `--title <text>`: title only, no sections.
- `--started-since/--started-until/--updated-since/--updated-until <date>`: `YYYY-MM-DD` (until is inclusive of that day) or a full timestamp.
- `--project <folder or path>` / `--all-projects`: defaults to the current checkout's project, resolved to the main checkout from a worktree.
- `--include task,asks,main-result,last-result,files,failures,tool-failures`: add whole sections to every hit.
- `--limit <n>`: default 10.
