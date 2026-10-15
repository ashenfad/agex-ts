---
"@agex-ts/kvgit": minor
---

**Sync heads per remote:** a branch's last-synced head is kept per `Remote.id` (a `PackRemote`'s is its repo), so one branch synced with two remotes never takes one's head for the other's.
