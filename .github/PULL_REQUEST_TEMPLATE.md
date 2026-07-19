## What changed

Describe the user-visible policy-map behavior and the exact agent surface it models.

## Evidence

- [ ] Discovery, matching, activation, or ordering behavior links to current official documentation for the exact surface.
- [ ] Unspecified precedence and external state remain explicit instead of being inferred.
- [ ] Public fixtures cover matches, exclusions, ambiguity, and failure cases.

## Safety

- [ ] Inspection remains local, deterministic, and read-only.
- [ ] Discovered instruction text is never executed, evaluated as code, obeyed, or rewritten.
- [ ] All reads remain bounded and inside documented roots and explicit user scope.
- [ ] Output, diagnostics, fixtures, and snapshots contain only redacted or fake data.
- [ ] No account, telemetry, LLM, or runtime network dependency was added.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `npm run smoke:pack`
- [ ] README and architecture documentation match the real CLI behavior.
