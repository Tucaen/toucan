# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Tucaen/toucan/security/advisories/new),
not in a public issue. Include the Toucan version (shown on the version chip in the header), the
steps to reproduce, and what an attacker gains.

You should get a first response within a week. Once a fix is released, the advisory is published
with credit to the reporter unless you ask otherwise.

## Supported versions

Only the latest release is supported. Installed builds update themselves, so a fix ships as a new
release rather than a backport.

## Scope

Toucan runs terminals and coding agents with the permissions of the user who starts it; an agent
doing what its own permission mode allows is not a Toucan vulnerability. Areas where a report is
especially welcome:

- the mobile companion server and its pairing, which accept connections from other devices
- anything that lets web content in the renderer reach Node or the main process
- the update feed and installer
