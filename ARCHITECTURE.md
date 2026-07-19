# Architecture

## Purpose

`agent-policy-map` is a local inspection engine for coding-agent instructions.
It resolves one explicit context into a versioned `PolicyMap` that explains
which sources are active, conditional, manual, excluded, or unavailable
locally.

The project is deliberately one Node.js and TypeScript package. It has no
server, database, browser application, telemetry, remote account, or LLM.

## Design goals

1. **Evidence before certainty.** Every activation, match, exclusion, order,
   and warning should point back to a source path and documented rule.
2. **One normalized contract.** Agent-specific discovery stays behind the same
   `AgentAdapter` interface and `PolicyMap` output.
3. **Local and read-only.** Inspection reads bounded text files and never
   rewrites or executes discovered content.
4. **Explicit uncertainty.** Remote, managed, account, approval, and session
   state is represented as `unknown-external` when it cannot be inspected.
5. **Small dependency surface.** Prefer Node.js built-ins plus focused YAML and
   glob libraries.
6. **Deterministic output.** The same files, paths, options, environment, and
   supported platform should produce the same ordered result.

## Inspection flow

```text
CLI or library input
        |
        v
resolve target, cwd, root, environment, and read budget
        |
        v
select the agent adapter
        |
        v
discover sources and agent-specific diagnostics
        |
        v
run shared duplicate and possible-conflict diagnostics
        |
        v
estimate context bytes, lines, and approximate tokens
        |
        v
redact every public path, reason, diagnostic, and assumption
        |
        v
assign stable source IDs from redacted paths
        |
        v
versioned PolicyMap
        |
        +--> human renderer
        +--> JSON renderer
```

`src/core/inspect.ts` owns this orchestration. Adapters do not render output or
define a second result format.

## Context model

Every inspection is resolved from these inputs:

- `agent`: the supported agent adapter;
- `target`: the file whose path is being evaluated;
- `cwd`: the simulated launch working directory;
- `root`: the project containment root;
- `includeUser`: whether documented user, home, managed, and configured custom
  locations are also in scope;
- `mode`: target-specific `inspect` or target-independent `discover`;
- `env`: injectable environment state, primarily for user locations and tests;
- `budget`: aggregate file and byte limits for one inspection.

Target, cwd, and root are separate on purpose. Codex project-document discovery
depends on launch cwd, while path-scoped rules depend on the target. Root defines
the project read boundary.

`inspect` evaluates one concrete target. `discover` lists sources visible from
the launch context and marks target-dependent sources as conditional rather
than pretending they are universally active.

## Normalized contract

The public `PolicyMap` type lives in `src/types.ts`. Its top-level fields are:

- `version`;
- `agent` and concrete `surface`;
- resolved `target` and `cwd` display paths;
- explicit `assumptions`;
- normalized `sources`;
- structured `diagnostics`;
- a `context` estimate.

Every `PolicySource` has an ID, path, kind, state, and evidence-backed match
reason. File metadata is optional because synthetic and unavailable external
sources do not have readable local content.

Stable IDs are derived from the agent, source kind, and display path. They are
identifiers for a matching inspection context, not permanent database keys.

## Agent adapters

Adapters live in `src/adapters/` and implement one `AgentAdapter` interface.
Each adapter owns only behavior specific to its documented surface:

- `codex.ts`: Codex project documents, same-directory overrides, configured
  fallbacks, and supported skill catalogs;
- `claude.ts` and `claude-imports.ts`: Claude memory layers, lazy nested
  sources, imports, exclusions, and scoped rules;
- `cursor.ts`: Cursor IDE `.mdc` activation modes, nested `AGENTS.md`, and
  references;
- `copilot.ts`: GitHub Copilot CLI repository, path-specific, user, agent, and
  imported instructions;
- `registry.ts`: the supported adapter registry and agent names;
- `shared.ts`: adapter helpers that preserve the normalized contract.

Official documentation does not always define precedence. An adapter must
report ambiguity or omit `order` instead of choosing a convenient winner.

## Shared modules

```text
src/
  adapters/     agent-specific discovery behind one interface
  context/      byte, line, and labelled token estimates
  core/         context resolution, inspection orchestration, stable IDs
  diagnostics/  duplicates and evidence-backed possible conflicts
  frontmatter/  YAML parsing and documented-field validation
  fs/           contained, bounded reads and directory traversal
  match/        glob, brace, applyTo, and paths matching
  render/       human and JSON output
  security/     best-effort credential redaction and bounded excerpts
  cli.ts        command parsing and process exit behavior
  constants.ts  safety bounds and documented limits
  index.ts      public library exports
  types.ts      versioned public contract
fixtures/       fake public examples grouped by supported agent
tests/          adapter, core, state, safety, and built-CLI tests
scripts/        standalone release-facing smoke checks
```

The split follows product responsibilities rather than framework conventions.
Do not turn the project into a monorepo or introduce a framework for simple CLI
work.

## Safety boundary

All instruction content is untrusted data. It must never control program
execution or the coding agent implementing this repository.

The filesystem layer is responsible for:

- canonical path containment before reads;
- explicit allowed roots for opt-in user and managed locations;
- bounded file size, total files, total bytes, recursion, and directory depth;
- aggregate file, directory, and entry limits across all walks in one inspection;
- symlink and import-cycle handling;
- deterministic directory ordering;
- plain text reads only, with no JavaScript configuration execution.

Adapters should call shared read and walk helpers rather than implement weaker
containment checks independently.

Full content is hidden by default. Redaction protects common credential shapes
in excerpts and explicitly requested content, but it is a heuristic and must
not be described as a complete secret scanner.

## Diagnostics

Deterministic diagnostics cover facts such as malformed frontmatter, missing
imports, cycles, path escapes, duplicate hashes, and documented exclusions.

Natural-language contradiction detection is deliberately narrow. Heuristic
findings use the `possible-conflict` code, short redacted evidence, and source
paths. They never claim complete semantic understanding.

Diagnostic levels do not control CLI exit status. Invalid CLI usage exits
non-zero; completed inspection commands exit zero and expose policy findings in
the structured result.

## Determinism

Determinism means the same explicit context produces the same output. Relevant
context includes files, paths, CLI/library options, environment values used by
an adapter, platform-specific managed locations, and tool version.

To preserve deterministic output:

- directory entries and diagnostics are sorted, while each adapter emits
  sources in its documented deterministic discovery order;
- IDs are path-derived rather than random;
- tests inject an isolated environment;
- no runtime network state is consulted;
- token counts are clearly labelled estimates based on bytes.

## Tests and fixtures

Fixtures contain only fake paths, fake identities, and public sample content.
Tests set a fixture-specific root and inject an isolated environment so they do
not read a contributor's real home instructions.

Committed fixtures cover documented discovery, activation, matching,
exclusion, ambiguity, imports, and frontmatter. Temporary directories cover
edge cases that do not belong in Git, including oversized files and symlink
layouts.

The required local gate is:

```bash
npm run check
```

It runs typecheck, lint, build, the Vitest suite, and the built-CLI smoke test.
CI runs the same gate on supported Node.js versions, then packs the npm package,
installs it in a temporary consumer project, and verifies both the executable
and library export. CI does not publish the package.

## Adding or changing an agent surface

1. Link the behavior to current official documentation.
2. Keep discovery inside one adapter and return the normalized contract.
3. Represent remote or session-only state explicitly.
4. Add public fixtures for matches, exclusions, ambiguity, and failures.
5. Add safety tests for every new path or import mechanism.
6. Update README support and examples when public behavior changes.
7. Run `npm run check` and `npm pack --dry-run`.

Do not infer rules from one agent or surface and apply them to another. Copilot
CLI, for example, must not silently inherit GitHub.com or IDE precedence.
