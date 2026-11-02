# Jesus is the way — claw-machine STATUS

## What this is
Snapchat Web Lens: dark, mysterious claw machine. When a prize physically drops
through PRIZE OUT, the ball lerps to screen center, splits in half, falls away,
and a folded paper unfolds with a Bible verse. KEEP READING opens the full
chapter; COMPÁRTELO shares it. The machine is the vehicle; the Word is the prize.

## Hard gates
- Package zip must stay **≤ 8 MB**, `index.html` at root, all assets local,
  zero runtime network. Current: **7.47 MB** ✅
- **No publish/submit to Snapchat or anywhere without Diego's explicit approval.**

## State (2026-11-02)
- 5 languages: pools `verses-{en,es,pt,de,it}.json` — 3,000 verses each, ranked
  by OpenBible cross-reference "substance" (same indices across languages, so a
  dealt `verseIdx` resolves to the same verse in every language).
- Full Bible text bundled for EN (BSB) + ES (VBL) → `bible-{en,es}.txt`;
  pt/de/it KEEP READING falls back to English.
- Flag/language screen (`#enter-screen`) shows a verse + EN/ES/PT/DE/IT chips
  before entry; auto-detects `navigator.language`; TAP TO ENTER unlocks audio
  and reveals the machine. GLB loads in parallel behind it.
- Unused GLB variants moved to `assets-src/unused-variants/` (~2.08 MB freed).
- Verified: enter screen → ES chip → reveal in Spanish (Jeremías 29:11) →
  SEGUIR LEYENDO opens full chapter in VBL. 0 console errors.

## Build / data
- `bash build.sh` → bundle + dist + claw-machine.zip
- `node tools/build-verses.mjs [poolSize]` → regenerates verse pools + Bibles
  from `../bible-cross-references/public/data/` (run `npm run data:build` there
  first if data is missing).

## Open questions for Diego
- Auto-demo wins: queue reveals (current) vs only human-pressed drops?
- Cabinet reskin (dark/gold) or keep the classic red as camouflage?
- New 4K dark skybox still pending (prompt drafted in chat history).
