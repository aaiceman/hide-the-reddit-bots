# Hide the Reddit Bots

A Firefox extension for the old Reddit layout that shows a color-coded account-age
label next to every username and hides posts/comments from accounts younger than a
configurable threshold (default: 30 days). Young accounts are disproportionately
bots, spammers, and ban evaders — this makes them visible or gone.

## Features

- **Age labels** next to every post and comment author: `[8 years]`, `[3 months]`,
  `[12 days]` — color-coded from red (new) to gray (established)
- **Auto-hide** posts and comments from accounts under the threshold
- **Persistent cache** — account creation dates never change, so each username is
  fetched once, ever; after that, lookups are instant and offline
- **Fail-visible** — accounts whose age can't be determined (suspended, rate-limited)
  show `[?]` and are never hidden
- **Live settings** — threshold and toggles apply immediately to open tabs
- **Hide-rate stats** — a small collapsible badge (bottom-right) shows how many
  accounts have been hidden versus seen for the current subreddit (or, on the
  front page / `r/all` / multireddits, the summed totals of the subreddits shown).
  The options page has a sortable per-subreddit table with copy-as-markdown and a
  reset button. Counts are cumulative since the last reset and stay on your
  machine. Because only *verified*-young accounts are hidden (estimated ages never
  hide), the rate is deliberately conservative.
- Coexists with Reddit Enhancement Suite (labels also appear on content loaded by
  RES never-ending scroll)

## Scope

Old Reddit layout only (`old.reddit.com` and legacy-mode `www.reddit.com`). The
modern React UI is not supported.

## Settings

`about:addons` → Hide the Reddit Bots → Preferences:

| Setting | Default |
|---|---|
| Show account-age labels | on |
| Hide posts/comments from young accounts | on |
| Threshold (days) | 30 |

## Install

Download the `.xpi` from Releases and install via `about:addons` → gear icon →
*Install Add-on From File…*. Unsigned builds require Firefox Developer Edition,
Nightly, or ESR with `xpinstall.signatures.required = false`.

## How it works

A content script scans `a.author` links, resolves each account's creation date via
Reddit's public `/user/<name>/about.json` endpoint (same-origin, serial requests
with backoff on rate limits), caches results in `browser.storage.local`, and
toggles a `display: none` class on the enclosing `.thing` element. No background
script, no external services, no analytics.

**Hiding is dynamic, not refresh-based.** While a username is being looked up, it
shows a `[…]` placeholder. The moment the lookup completes, every occurrence of
that user on the page gets its age label and — if the account is under the
threshold — its post/comment is hidden in the same instant. This means an
uncached young account's content can appear briefly and then vanish once its age
resolves. Cached usernames (anyone you've encountered before) are labeled and
hidden immediately on page load, with no flash. Settings changes work the same
way: toggling hiding or changing the threshold re-applies to all open tabs
instantly, unhiding or hiding content without a reload.

## Credits

The age color scale was adapted from a Reddit Enhancement Suite patch by
[u/razzraziel](https://www.reddit.com/r/Enhancement/comments/1t2ikrp/). RES is
GPL-3.0, as is this project.

## License

[GPL-3.0](LICENSE)
