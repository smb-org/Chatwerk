# Chatwerk Studio design system

## Typography

- Studio UI: Schibsted Grotesk, self-hosted Latin-1 WOFF2 subset. The subset includes Basic Latin, Latin-1 Supplement (including German umlauts and ß), general punctuation, Euro, trademark, and arrows. The regular face is used; the browser synthesizes other UI weights.
- Links, numbers, revisions, values, and code: Commit Mono, self-hosted Latin-1 WOFF2 subset.
- Overlay fonts remain separate and are defined by `src/shared/theme.ts`.
- Source files: [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) and [Commit Mono](https://github.com/eigilnikolajsen/commit-mono). Both are licensed under SIL Open Font License 1.1. Their license notices are kept in `public/fonts/`.
- Hosted subsets: `public/fonts/schibsted-grotesk-latin.woff2` and `public/fonts/commit-mono-latin.woff2`.

## Type scale

| Use | Size / line height |
|---|---:|
| Group label | 12 / 16 px |
| Controls | 13 / 18 px |
| Body | 14 / 20 px |
| Dialog title | 16 / 24 px |
| Page title | 20 / 28 px |
| Login title | 28 / 32 px |

## Spacing, shape, and motion

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px.
- Control rows: 32 px. Primary buttons: 44 px.
- Radius: 4 px for controls, 8 px for dialogs and toasts, 999 px for chips.
- Motion: opacity only; 120 ms control transitions, 150 ms toast transition, 200 ms dialog transition; `cubic-bezier(0.2, 0, 0, 1)`.
- `prefers-reduced-motion: reduce` disables Studio motion.

## Dark UI palette and contrast

Contrast is calculated with the WCAG relative-luminance formula. Text contrast is measured against `--ui-bg`; accent ink is measured against `--ui-accent`. The unit test recomputes the listed ratios.

| Token | Hex | Contrast |
|---|---|---:|
| `--ui-bg` | #17181B | — |
| `--ui-surface` | #1F2125 | — |
| `--ui-surface-2` | #292C31 | — |
| `--ui-line` | #3B3F46 | Never for text |
| `--ui-fg` | #ECE9E2 | 14.6:1 |
| `--ui-muted` | #A6A39B | 7.0:1 |
| `--ui-accent` | #E9A23B | 8.2:1 |
| `--ui-accent-ink` | #17181B | 8.2:1 on accent |
| `--ui-ok` | #6FCF97 | 9.3:1 |
| `--ui-danger` | #F28B7D | 7.4:1 |

## Browser surfaces

- `color-scheme: dark`; browser theme color `#17181B`.
- `:focus-visible`: 2 px accent outline with 2 px offset.
- Selection, caret, and native `accent-color`: accent.
- Scrollbar thumb: line token.
- Color controls use native `<input type="color">` and a hex field.
- Studio chrome uses `--ui-*` only. Renderer themes use `--t-*` only inside the overlay document. The preview stage background belongs to Studio chrome.
