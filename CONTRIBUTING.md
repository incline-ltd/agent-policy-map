# Contributing

Thanks for helping improve `agent-policy-map`.

## Set up locally

Requires Node.js 20 or newer. CI covers Node.js 20 and 22.

```bash
git clone https://github.com/incline-ltd/agent-policy-map.git
cd agent-policy-map
npm ci
npm run check
```

Run the built CLI with:

```bash
npm run cli -- --help
```

## Before opening a pull request

1. Link every new discovery, matching, or precedence rule to current official
   documentation for the exact agent and surface.
2. Keep the change focused on one agent, surface, safety boundary, or
   diagnostic.
3. Add public fixtures for matches, exclusions, ambiguity, and failures.
4. Use temporary roots for symlinks, oversized files, traversal, and other
   filesystem edge cases.
5. Never commit personal instruction files, private paths, credentials,
   customer data, or internal operational content.
6. Update README and architecture documentation when public behavior or module
   boundaries change.
7. Run the full local gate and packed-install smoke test:

```bash
npm run check
npm run smoke:pack
```

Do not invent precedence to make output look simpler. When behavior depends on
model selection, later file access, session state, approval, or remote account
settings, represent that uncertainty directly.

## Architecture rules

- Keep one Node.js and TypeScript package.
- Keep agent-specific discovery behind the normalized adapter contract.
- Use shared containment-aware filesystem helpers for every read.
- Treat discovered instruction content as untrusted data.
- Label heuristic prose contradictions as possible conflicts.
- Preserve deterministic output and bounded inspection.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing discovery, filesystem,
diagnostic, or output contracts.

## Security reports

Do not open a public pull request or issue containing an exploitable path,
private instruction content, or credentials. Follow [SECURITY.md](SECURITY.md)
instead.
