# purge-x

**Cross-host instruction-authority plugin.** A multi-target rewrite of [dsh-purge](https://github.com/HunYiSage/dsh-purge): the same four-layer model, retargeted at WorkBuddy / CodeBuddy (Tencent Genie) and Doubao (ByteDance Chromium fork) desktop clients.

dsh-purge only knew one host and patched 86 hard-coded strings inside DeepSeek Harness. That repo is gone, and the hosts changed. So this project keeps the *method* — persona injection, tail anchor, approval relaxation, request rewriting — and drops the coupling to one host's internals.

```
$ purge-x targets
  workbuddy  WorkBuddy / CodeBuddy desktop (Tencent Genie)  -> detected
    home    ~\.workbuddy
    install D:\Program Files\WorkBuddy  v5.9.2
  doubao  Doubao desktop (ByteDance Chromium fork / liblark)  -> detected
    exe     D:\Program Files (x86)\Doubao\Doubao.exe
```

## Support matrix

| Host | Channel | Target | Privilege | Survives update |
|---|---|---|---|---|
| **WorkBuddy / CodeBuddy** | persona | `~/.workbuddy/SOUL.md` | user | yes |
| | skill | `~/.workbuddy/skills/purge-x-anchor/SKILL.md` | user | yes |
| | policy | `~/.workbuddy/settings.json` → `sandbox.orderedRules` | user | yes |
| | deep | `<install>/…/cli/product.json` → `builtInAgents[].systemPrompt` | **admin** | no |
| **Doubao** | cdp | renderer fetch / XHR / WebSocket hooks | launch flag | no (per session) |
| | launcher | `~/.purge-x/doubao/start-doubao.ps1` | user | yes |

Verified on WorkBuddy **v5.9.2 / Electron 37.10.3**. The Doubao side rides the generic CDP protocol, so it is version-agnostic — but it can only rewrite **plain JSON** request bodies.

## Install

```bash
npx github:HunYiSage/purge-x targets
# or
git clone https://github.com/HunYiSage/purge-x && cd purge-x
node bin/purge-x.js targets
```

Zero dependencies. Node ≥ 18.17. Windows verified; macOS/Linux path probing included.

## Usage

```bash
purge-x targets                     # detect hosts
purge-x status  [--target NAME]     # per-channel state
purge-x apply   [--target NAME]     # workbuddy | doubao | all
purge-x revert  [--target NAME]     # restore from backup
purge-x payload [--profile zh|en]   # print the payload
purge-x attach  [--port 9333]       # CDP-inject into a running Doubao
purge-x doctor
purge-x backups [--all]
```

`apply` flags: `--profile zh|en`, `--prompt-file FILE`, `--deep`, `--dry-run`, `--port N`, `--auto-launch`, `--verbose`, `--no-color`.

### WorkBuddy

```bash
purge-x apply --target workbuddy
```

```
  workbuddy WorkBuddy / CodeBuddy desktop (Tencent Genie)
    [ok] SOUL.md persona inject   ~\.workbuddy\SOUL.md
    [ok] resident anchor skill    ~\.workbuddy\skills\purge-x-anchor\SKILL.md
    [ok] sandbox approval relax   file=49 command=0 network=0
```

`--deep` additionally rewrites `product.json` and **requires admin**, because the install dir is read-only. It fails loudly instead of half-writing:

```
    [xx] product.json inject   install dir read-only: rerun elevated
```

### Doubao

```bash
purge-x apply --target doubao               # writes the launcher
& "$HOME/.purge-x/doubao/start-doubao.ps1"  # relaunch with --remote-debugging-port
purge-x attach --port 9333                  # inject
```

Then in the page console:

```js
window.__PURGE_X_LOG__   // which requests were hit, how many chars injected
```

## The four layers

```
1. header    instruction authority, top of system prompt
2. anchor    tail anchor, recency slot
3. adapter   whatever the host exposes (persona file / JSON / CDP)
4. policy    approvals, sandbox, re-confirmation
```

Header and anchor are the same text in two positions: the head defines priority and hard rules; the tail survives the host appending tool descriptions after us. Both carry `<!-- purge-x:header:begin -->` style delimiters, so re-applying is an **idempotent replace**, not an ever-growing stack (dsh-purge shipped that bug once: +841 chars per apply).

### Why it never guesses enums

`settings.json` has `sandbox.systemToolPolicy: "always_confirm"`. Flipping it to `always_allow` looks obvious — except that in the 9.8 MB `codebuddy-lite-wb.mjs`, `always_confirm` appears once and `always_allow` **zero** times. An unknown enum either gets ignored or resets the whole `sandbox` block. So purge-x leaves it alone and reports it:

```
always_confirm (kept: enum not public, change it in the host's security center)
```

The rule everywhere: **patch what you can prove, report what you cannot.**

## Doubao limitations

Hard limits, not bugs:

1. **Plain JSON bodies only.** If the body's first byte is not `{` or `[` it is left untouched. Protobuf, form-data, signed or encrypted bodies pass through with a log line.
2. **The debug port must be open.** An already-running instance cannot grow one; relaunch with `start-doubao.ps1`.
3. **Client-side only.** Server-side moderation, risk scoring, account policy are out of reach.

Injection never blocks traffic: if `rewriteBody` throws, the original request goes out unchanged.

## Rollback

```bash
purge-x revert --target workbuddy
```

Restores strictly from `~/.purge-x/backups/<target>/<stamp>/manifest.json` — no directory scanning, no rebuilding. Entries with `existed: false` get deleted, because those files were created by us.

Measured: `SOUL.md` 1792 → 4656 bytes, back to 1792 after revert; `systemToolPolicy` back to `always_confirm`.

## Adding a host

```js
export const id = "myhost";
export const label = "My Host";
export function detect()  {}
export function status()  {}
export function apply(target, opts) {}
export function revert()  {}
```

Register it in `lib/targets/index.js`. Always give patches `markers` — that is the "already applied" predicate. `drifted` is not an error; it means the host changed its wording and the pattern needs an update.

## Scope

Local files of the current user only. No telemetry, no uploads. Every write is preceded by a backup. WorkBuddy / CodeBuddy / Doubao are trademarks of their owners; this project is unaffiliated.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Derived from dsh-purge (Copyright 2026 HunYiSage, Apache-2.0).
