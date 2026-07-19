# Fixtures

All fixtures use fake paths, fake identities, and public sample content. They
exist only to exercise documented discovery, matching, exclusion, and ambiguity
rules for each supported agent.

Tests pass an explicit `--root` (or the `root` option) pointing at the relevant
fixture directory so discovery never walks outside it, and inject a fake `HOME`
so a contributor's real instruction files are never read.

Layout:

- `codex/` — override replacement, nested order, current skill catalogs,
  invocation policy, and combined project-doc caps.
- `claude/` — imports (relative, missing, fenced, cyclic, over-depth), scoped
  rules, `claudeMdExcludes`, ambiguous same-scope memory.
- `cursor/` — four activation modes, ignored `.md`, nested rules and
  `AGENTS.md`, references.
- `copilot/` — standard and modular locations, supported imports, custom
  directories, agent files, and documented de-duplication.
- `home/` — opt-in user/home locations used only with `--include-user`.

Dynamic edge cases that do not commit cleanly (symlink loops, oversized files,
traversal via symlink) are created in temporary directories by the tests.
