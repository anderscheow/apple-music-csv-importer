# Agent instructions

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it before text searches or reading files when you need to understand or locate code:

- Use the `codegraph_explore` MCP tool when available. It returns relevant source and call paths. Name a file or symbol to inspect its current line-numbered source.
- Otherwise, run `codegraph explore "<symbol names or question>"` in the shell.
- If `.codegraph/` does not exist, skip CodeGraph; indexing is the user's decision.

## Project

- This is a local React/Vite and Express app. `src/music.ts` handles CSV parsing and ranking, `src/matching.ts` searches the catalog, `src/matching-run.ts` coordinates passes, and `server/index.ts` proxies Apple Music requests.
- Keep private keys, tokens, personal playlist CSV files, and generated reports out of commits and logs. Use `.env.example` for configuration examples.
- Match selection is consequential: preserve the distinction between confirmed matches and unselected suggestions, respect the live filter, and avoid assuming catalog availability across storefronts.
- Preserve pause, resume, retry, ordering, and partial-import behavior when changing matching or playlist operations.
- Run `npm test` and `npm run build` for code changes. Use focused tests for matching decisions and nontrivial state transitions.
