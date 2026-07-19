# Project memory

Use npm for installs.

Relative import that exists:
@./docs/rel.md

Relative import that is missing:
@./docs/missing.md

Start of the deep import chain (exceeds the 5-hop limit):
@./docs/chain1.md

Start of an import cycle:
@./docs/cycle-a.md

The following imports live inside code and must be ignored:

```
@./docs/should-not-import.md
```

Inline code `@./docs/also-ignored.md` is ignored too.
