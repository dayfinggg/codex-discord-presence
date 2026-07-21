# Security policy

Please report vulnerabilities through the repository's private
[security advisory form](https://github.com/dayfinggg/codex-discord-presence/security/advisories/new).
Do not include credentials, tokens, private rollout data, or SSH configuration in a public issue.

Only the latest release receives security fixes. The service binds no network listener, starts SSH
only for validated aliases, never invokes a shell for SSH, and stores bounded local diagnostic logs.
