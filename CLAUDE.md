# Project notes

- The local development server uses port 17173; Playwright uses port 17174.
- Run `pnpm check` for build, typecheck, lint, unit tests, and Worker tests.
- Run `pnpm test:e2e` for the Playwright smoke test.
- See `docs/designs/chat-overlay-studio.md` for the product and implementation design.
- Commit messages are English: `<icon> <type>(<module>): summary`, imperative, at most 50 characters, body as grouped bullets, no attribution trailers. Example: `✨ feat(renderer): parse USERNOTICE tags`.
