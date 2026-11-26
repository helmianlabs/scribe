# Code signing policy

**Status (November 26, 2026): not active.** Releases v0.1.0 through v0.1.4
are unsigned. Signing through [SignPath.io](https://about.signpath.io/),
with a certificate from [SignPath Foundation](https://signpath.org/), is
planned; the release workflow skips the signing step until it is set up.
The policy below is the one that will apply once signing is on.

Only Windows release artifacts built by this repository's GitHub Actions
workflow from the source code in this repository are signed. Every signing
request is approved manually by an Approver.

## Team roles

- Committers and reviewers: [helmianlabs members](https://github.com/orgs/helmianlabs/people)
- Approvers: [helmianlabs owners](https://github.com/orgs/helmianlabs/people?query=role%3Aowner)

All team members use multi-factor authentication for GitHub and SignPath.
Changes from people who are not committers are reviewed before merge.

## Privacy policy

See [PRIVACY.md](PRIVACY.md). In short: the spoke only connects to the Helmian
server that the person installing it pairs it with, to receive and report work
that person (or their Helmian agents, under their approvals) asked for.
