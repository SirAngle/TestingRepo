---
name: giga-release
description: Ship the next versioned revision of the SimTLV giga calculator — new vX.Y HTML, paired docs, smoke-harness differential, commit and push. Use when asked to add a feature to, change, fix, or release a new version of the calculator (the simtlv_giga_calculator_*.html single-file app).
---

# Shipping a calculator revision

The app is ONE self-contained Hebrew/RTL HTML file, distributed by hand and run
from `file://`. No build step, no bundler, no framework. Every change ships as a
**new numbered revision** plus a **paired docs file**, proven behavior-safe by a
differential smoke harness.

## The cycle

1. **Probe first** (only if an API is involved). Hit it **read-only** with
   `curl` and save the response to the scratchpad — you will replay it later.
   Never send writes to a live customer system.
2. **Roll the version:** `.claude/skills/giga-release/roll-version.sh <app-ver>`
   (see below). This creates the new HTML + docs pair. Never hand-copy.
3. **Implement** in the new HTML only. Reuse the house idioms already in the
   file — grep for a similar feature before inventing one.
4. **Extend `tests/smoke.js`**: a fetch-stub branch for any new endpoint, plus
   `fix_*` keys for the new behavior (see *The differential contract*).
5. **Run the differential:** `node tests/smoke.js <new.html> <previous.html>`.
   Must be green. (`cd tests && npm i` once — jsdom is not vendored.)
6. **Verify in a real browser** with the replay recipe below. Screenshot it.
7. **Write the docs:** append the next `## NN. What changed in vX.Y` section to
   the new `.md`. Say what changed, why, and **what you did not verify**.
8. **Commit and push** to the branch you were told to use — never another one.
9. **Deliver** the HTML file to the user.

## roll-version.sh

```
roll-version.sh <app-version> [docs-version] [--date YYYY-MM-DD]

roll-version.sh 5.8        # 5.7 -> 5.8, docs auto-bumped 1.1 -> 1.2
roll-version.sh 5.8 1.2    # both explicit
roll-version.sh 6.0 2.0 --date 2026-09-16   # deliberately restart the date prefix
```

Finds the newest HTML + docs, copies them to the next version, and bumps all
four version strings (HTML header, HTML `MAIN SCRIPT` banner, docs header line,
docs companion filename). It **refuses to overwrite** an existing revision and
**fails loudly** if a replacement did not match — if it reports `FAIL`, fix that
before writing any code. `warn` is fine on pre-convention builds that never had
the banner.

Versioning rules it enforces or assumes:

- **Never overwrite** a previous revision — every change is a new file.
- **Minor change = decimal** (7.33 → 7.34). **Major redesign = integer** (7.x → 8.0).
- **Never** `final`, `fixed`, `new`, `v2` or any vague suffix. Numbers only.
- The **date prefix is inherited** so a chain stays consistent. Only pass
  `--date` when deliberately starting a new chain.

## The differential contract

`node tests/smoke.js <primary> <baseline>` boots both builds in jsdom, asserts
business rules, and diffs an observable-results object `R`.

**As written today it treats ANY differing key as a failure** — it is a
refactor safety net. So:

- A refactor or pure cleanup must produce **zero** differences.
- A deliberate behavior change is declared by naming its key `fix_*` and
  asserting it with an `okFix`-style assertion: the `fix_` key is *expected* to
  differ, and to fail on the baseline — that expected-fail is what proves the
  change actually landed. Every non-`fix_` key must stay byte-identical.
- If you add `fix_*`/`okFix` support to the harness, keep the rule that
  unmarked keys diffing is still a hard failure.

**Never weaken a test to make code pass.** Updating a test because the user
*requested* a behavior change is correct and expected; loosening one because
your code is wrong is not. If an assertion hard-codes something your change
legitimately alters (a tab count, a label), update it and say so.

## Verifying in a real browser

The container **cannot reach external hosts** — Chromium's proxy CONNECT is
reset. So never point the app at a live API in the browser. Instead:

1. Capture the real response once with `curl` into the scratchpad.
2. Replay it via `page.addInitScript()` overriding `window.fetch`, branching on
   the URL (and on the POST body when one endpoint serves several shapes).

```js
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('pageerror', e => errors.push(e.message));   // always assert zero page errors
await p.addInitScript(`window.fetch = function (input, init) { /* replay captured JSON */ };`);
await p.goto('file:///abs/path/to/the-new.html');
```

Reuse the harness's own stub by slicing it out of `tests/smoke.js` so the
browser and jsdom see identical fixtures.

## Gotchas that have already bitten

- **Never write code containing `\n` or other backslash escapes through a shell
  heredoc that expands, or through a generator's template literal** — the escape
  becomes a real newline and silently breaks a string mid-script. Use the Edit
  tool, or a quoted (`<<'EOF'`) heredoc.
- Single-quoted `node -e '...'` containing inner single quotes gets mangled by
  the shell; the replacement then matches nothing and reports success. Prefer a
  script file.
- After writing a file with a shell command, **re-read it before using an
  editing tool** on it, or the edit is rejected as stale.
- In jsdom, `root.querySelector('#id')` can return `null` when a duplicate id
  exists earlier in the document. Query by class or `[id="..."]` instead.
- An `oninput` handler must never trigger a full re-render — it recreates the
  input mid-keystroke and drops focus.

## Security and delivery

- API keys/secrets **never** appear in the client HTML. It is handed to staff.
- Live requests to production stay **read-only**.
- Push only to the branch you were given. Do not open a PR unless asked — and
  note that if the working branch is the repo's only/default branch there is no
  base to open one against.
- End the commit with the `Co-Authored-By:` / `Claude-Session:` footer given in
  your session's own attribution reminder, verbatim. **Do not write a model name
  into any file, commit message, or comment in this repo** — that footer is the
  single sanctioned exception, and it changes between sessions.
