# App icon set — PLACEHOLDER lettermark (real Havesay icon still open)

These files are referenced by `public/manifest.webmanifest` and `src/app/layout.tsx`.

**Status (2026-07-04):** generated as PLACEHOLDERS by `scripts/_gen-pwa-icons.ts` from
the interim "H" lettermark (`icon-source.svg` / `icon-maskable-source.svg`). PWA install now
shows a branded civic tile instead of a browser default. The real Havesay brand icon
remains OPEN per DEFINITION-OF-WORKING item 6 ("Havesay branding throughout: real icon,
no BB logo"). Replace the two source SVGs and re-run the generator before launch.

| File | Size | Purpose |
|---|---:|---|
| `icon-192.png` | 192 × 192 | Android home-screen, generic |
| `icon-512.png` | 512 × 512 | High-res, PWA splash |
| `icon-maskable-512.png` | 512 × 512 | Android adaptive icon (glyph inside safe zone) |
| `icon-512.svg` | scalable | Vector source (copied from `icon-source.svg`) |
| `apple-touch-icon.png` | 180 × 180 | iOS home-screen |
| `icon-source.svg` | scalable | Placeholder "any" source art |
| `icon-maskable-source.svg` | scalable | Placeholder maskable source art (full-bleed) |

Design constraints (from global CLAUDE.md):
- OKLCH / civic tokens only — placeholder uses `--civic-primary` #1a2f5c on app bg #fafaf7
- No #000 or #fff (placeholder honors this: bg is #fafaf7, mark is #1a2f5c)

## Regenerate

```bash
# from app/
npx tsx scripts/_gen-pwa-icons.ts
```

Edit `icon-source.svg` (rounded-tile, "any" purpose) and `icon-maskable-source.svg`
(full-bleed, keep the glyph inside the center ~80% safe zone) first, then re-run.
For maskable safe-zone verification use the Maskable.app web tool before shipping the real icon.
