---
"@agex-ts/kvgit": minor
---

**A fake GitHub for tests:** `FakeGithub` (`@agex-ts/kvgit/github/fake`) stands in for the GitHub API `PackRemote` uses, in-process or over HTTP with `serveFakeGithub` (`@agex-ts/kvgit/github/fake-server`), which answers cross-origin requests so a browser can sync against it; failures and a request-size limit can be injected. `pnpm -F @agex-ts/kvgit fake-github` runs one.
