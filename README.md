# Jesus is the way — claw machine Web Lens

A Snapchat Web Lens game: a dark, mysterious claw machine standing alone in a
foggy arcade hall. When a prize physically drops through `PRIZE OUT`, it flies
to center screen, splits open, and a **sealed letter** emerges — the wax seal
breaks, the letter unfolds, and it carries a Bible verse. `KEEP READING` opens
the full chapter; `COMPÁRTELO` shares it.

**The machine is the vehicle. The Word is the prize.** The game is honest fun —
real physics, real claw, real win condition — with a Christian payload at the
moment of reward. The audience is people who would never open a Bible.

## Live

- Game: <https://voftec.github.io/jesus-is-the-way/>
- Instant reveal preview: `https://voftec.github.io/jesus-is-the-way/?reveal=carta`
- No post-processing (comparison only): `https://voftec.github.io/jesus-is-the-way/?nofx`
- Local dev preview: serve `dist/` statically (e.g. `npx serve dist`), open the URL.

## Constraints (hard)

- Deliverable is `claw-machine.zip` — **must stay ≤ 8 MB**, `index.html` at zip
  root, every asset local, **zero runtime network**. Currently **7.47 MB**.
- Snapchat Web Lens runtime: portrait 9:16, one-thumb input, audio unlocks on
  first gesture (the TAP TO ENTER flag screen provides it), `--snap-top/bot`
  CSS vars + `snap-ui-sync.js`/`snap-api.js` for safe areas.
- No publish/submit to Snapchat or anywhere without Diego's explicit approval.

## Repo layout

```
src/index.html        all markup+CSS (enter screen, verse card, chapter sheet)
src/main.js           scene, env, controls, reveal system, i18n, deck wiring
src/claw-rig.js       ClawRig: gantry/rails/cable/claw physics + prize physics
src/arcade-audio.js   procedural WebAudio (music modes, sfx, verseChime, paper)
vendor/               three.module.js + loaders (vendored, no network)
public/assets/        cabinet.min.glb, arcade-env-360.jpg, verses-*.json, bible-*.txt
tools/build-verses.mjs  regenerates verse pools + full-Bible files
assets-src/           source GLBs + unused-variants/ (excluded from package)
dist/                 build output (gitignored; deployed via gh-pages branch)
```

## Build & deploy

```bash
bash build.sh        # esbuild bundle → dist/ → claw-machine.zip
node tools/build-verses.mjs [poolSize]   # default 3000/lang; needs the data repo
```

Data regeneration requires `../bible-cross-references` (sibling folder, NOT in
this repo): run `npm install && npm run data:build` there once to produce
`public/data/translations/*.json` + `public/data/cross-references/openbible.json`.
The generated game data itself IS committed (`public/assets/verses-*.json`,
`bible-*.txt`) — you only need the data repo to *re-generate* it.

**Deploy to GitHub Pages** (what the live URL serves — the `gh-pages` branch,
not `main`):

```bash
bash build.sh
TMP=$(mktemp -d); cp -R dist/. "$TMP/"; cd "$TMP"
git init -b gh-pages; git remote add origin <repo-url>
git add -A; git commit -m "Pages build"; git push -f origin gh-pages
```

Bump the `bundle.js?v=N` cache-buster in `src/index.html` on every deploy —
iPhone Safari otherwise keeps the old bundle.

## Performance (keep these when editing)

Rule: optimizations only ship if a deterministic frame is pixel-identical to the
previous build (same clock + seeded `Math.random`, compared with pixelmatch).

| | GL draws/frame | frame ms (4× CPU throttle, 390×844 @2x) |
|---|---|---|
| before | 1841 (`?nofx` 1111) | ~36 |
| now | 745 (`?nofx` 546) | ~25 |

Pixel diff vs. before: 63 px of 1.3 M (claw edges), `?nofx` 4 px.

- **Lighter cabinet GLB**: `cabinet.min.glb` simplified with gltf-transform +
  meshopt (673k → 253k tris, 4.9 → 2.5 MB, tiny normal/MR maps dropped). Only
  visible loss: a bit less relief on the CLAW letters. Original is in git
  history (before commit `4386541`). It is `<link rel=preload>`ed in `index.html`.
- **Load doesn't wait on verses**: the machine builds as soon as the GLB
  arrives; `verses-<lang>.json` fills the deck when it lands (stale-language
  responses are ignored).
- **Instanced ball pit** (`claw-rig.js`): each ball keeps an invisible `Mesh`
  for physics/prize logic; one `InstancedMesh` per material draws them.
  `claw.syncBallInstances()` copies transforms every frame — call it after
  any code that moves balls, or they freeze visually.
- **Merged plush parts**: `mergeByMaterial()` bakes each plush's parts into one
  mesh per material (9 → 3-4 meshes). Add new plush parts *before* that call.
- **One shadow pass per frame**: `shadowMap.autoUpdate = false`, and the loop
  sets `needsUpdate = true` right before the beauty pass (the bloom mask pass
  reuses it instead of re-rendering shadows).
- **No canvas MSAA with post-FX**: the composer target already has 4× MSAA;
  `antialias` is only on for `?nofx`.
- **`updateDemo(dt)` ignores `dt <= 0`**: physics divides by `dt`; two frames
  with the same timestamp used to NaN every prize.
- Tried and dropped: `renderer.compileAsync` before hiding the loader (no gain).
- Not done because they'd change the look: bloom pass with bloom objects only
  (claw would stop occluding neon glow), lower pixel ratio on phones.

## How the reveal works (read this first)

1. **Deck**: `ClawRig.setVerseDeck(shuffledDeck(n))` assigns every spawned prize a
   `verseIdx` — same verse index in every language (pools share the ranking).
   When a prize is won and respawns, it draws the next card. There is no RNG at
   reveal time — the ball carries its verse from birth.
2. **Win**: physics only. A prize must enter the chute from above the rim and
   cross the kill region → `onPrizeWon(count, pr)` → `revealQueue.push(pr)`.
3. **Sequence** (`updateVerseReveal` in main.js): ball capsule lerps to screen
   center (~0.95s, spins, scales) → `splitVerseBall` (two hemispheres rotate
   away, fall, fade) → `openVerseCard` fires `sfx.paper()` → `#verse-paper`
   animates its closed→open transform → scene dims via `#verse-reveal.on`.
4. **Card**: `#verse-reveal` overlay, `#verse-paper` material variant, verse
   text+ref, `SEGUIR LEYENDO / COMPÁRTELO / ×`. Queued wins reveal one at a time.
5. **Chapter**: `openChapter(v)` fetches `bible-{en|es}.txt` once, slices the
   chapter around `v.i` (the global verse index), shows won verse + next 3;
   everything else starts `.veiled` (blurred) and `unveilVisible()` un-blurs
   verses as they scroll into the reading window (both directions, one-way).

## i18n

- 5 languages: pools `verses-{en,es,pt,de,it}.json` (3,000 verses each, ranked by
  OpenBible cross-ref "substance" — identical indices across languages).
- Full Bible bundled for EN (BSB) + ES (VBL) only; pt/de/it `KEEP READING`
  falls back to English (`FULL_BIBLE_LANGS` set).
- `#enter-screen`: welcome + "choose your language" (i18n) + lang chips + TAP TO ENTER, auto-detects
  `navigator.language`. Strings live in the `I18N` map in main.js.
- Lang can switch pre-entry; pools load lazily per language.

## Reveal material variants

`#verse-paper` takes a `reveal-*` class; **default is `carta`** (sealed letter).
Variants: `pergamino`(base, no class needed via `?reveal=pergamino`), `carta`,
`tabla`, `papiro`, `codice`, `ostracon`, `invitacion` — CSS in index.html.
`?reveal=X` in the URL applies the class AND auto-runs the sequence (skips flag,
fires `__verse.test(8)` ~2s after load). Note: `ostracon`'s clip-path clips
text/buttons — needs layout work if ever promoted.

## Dev hooks

- `?reveal=X` — preview variant + auto-run sequence
- `?nofx` — render without bloom/composer (perf comparison)
- `?dev` — FX/skybox panel (hidden otherwise)
- `?hq` / `?low` — load alt GLB (files moved to `assets-src/unused-variants/`, will 404 — dev-only)
- `window.__verse.test(i)` — queue a reveal with pool index `i` (8 = Jer 29:11)
- `window.__verse.pool()`, `window.claw`, `window.__cam`, `window.__ctrl`

## Known state & open decisions

- Verse queue fires for ANY physical win — including auto-demo wins. Open call:
  gate reveals to human-pressed drops only? (revealQueue is populated in
  `claw.onPrizeWon`; the rig knows if a human triggered the drop.)
- Cabinet is still the bright red CLAW cabinet — intentional camouflage vs.
  reskin dark/gold? Undecided.
- Skybox is the current dark-blurred `arcade-env-360.jpg`; a 4K moodier skybox
  was drafted (see chat notes) but never generated — ~+0.5 MB headroom exists.
- `PRIZES:`/`CLAW MACHINE` HUD was deliberately removed — keep UI wordless.
- `claw.onPrizeWon` still writes `scoreEl.textContent` — element is gone,
  guarded by `if (scoreEl)`, harmless.

## Gotchas learned the hard way

- **Quantized GLB**: `cabinet.min.glb` is draco/quantized — measure world-space
  cable units, never write `scale.y` directly on the cable (stretch bug).
- **Chute physics**: prizes only count entering from above `CHUTE_BOX` rim;
  side walls are closed to stop leak-through double-wins.
- **File literals**: main.js verse strings use `\u201C` escape sequences — when
  editing via exact-match tools, escape them as `\\u201C`.
- **Git remote rewrite**: this machine rewrites `github.com` →
  `git-manager.devin.ai` proxy. Push with token URL to bypass:
  `https://x-access-token:$(gh auth token)@github.com/voftec/jesus-is-the-way.git`
- **Pool indices are language-independent** — `verseIdx` resolves to the same
  verse in every language. Never regenerate one language's pool alone.
- **Bible license**: BSB (en) public domain; VBL (es), BLIVRE (pt),
  Luther 1912 (de), Riveduta 1927 (it) — see `attribution` in each verses file.

## The why (don't refactor this away)

Diego: "Soy un instrumento de Dios y esta es una forma de él llegar a una
audiencia que normalmente no puede llegar." The pool is curated by
cross-reference substance so every ball carries weight; who/what/when each
verse lands is left to the moment, not to a random function pretending to be
fate. Keep the experience quiet, mysterious, and worthy of the moment.
