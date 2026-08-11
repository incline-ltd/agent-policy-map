# Security policy

## Supported version

Until the first tagged release, only the latest commit on `main` is supported.
After releases begin, this section will list supported release lines.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/incline-ltd/agent-policy-map/security/advisories/new).
This is the required reporting route. Repository maintainers must enable it
before the first public release and keep it available for supported versions.

Do not open a public issue, discussion, or pull request for a security problem.
If private vulnerability reporting is unavailable, contact the maintainer
through GitHub only to report that the private route is unavailable. Do not
include vulnerability details. Wait until private vulnerability reporting is
enabled before sharing a reproduction, paths, instruction content, or
credentials.

Useful reports include:

- path traversal, symlink escape, or any unintended file read;
- import or directory cycles that escape documented limits;
- private instruction content, path, excerpt, or credential leakage;
- execution of discovered instruction or configuration content;
- a containment, redaction, read-budget, or recursion bypass;
- an incorrect active, excluded, or precedence result with security impact.

Include the affected version or commit, platform, command options, expected
behavior, and a minimal reproduction using temporary files and public sample
content.

Do not attach real instruction files, private paths, tokens, keys, credentials,
browser data, customer data, or internal operational content.

## Security model

Inspection is intended to be local, read-only, deterministic, and bounded.
Project reads must remain inside the resolved containment root. Supported user
and managed locations are opt-in through `--include-user`. Discovered content
is treated as untrusted text and is never executed.

Credential redaction is best-effort defense in depth, not a complete secret
scanner. Review any output created with `--show-content` before storing or
sharing it.
