# Contributing

1. Fork the repository and create a focused branch.
2. Run `npm ci && npm test` inside `manager/`.
3. Run `docker compose config` and the end-to-end offline test described in the README.
4. Never commit `.env`, registry data, manager state, tokens, or backup archives.
5. Keep API changes backwards-compatible or document the migration.

Security-sensitive changes (authentication, publishing, cleanup, remote binding) should include tests and an explicit threat-model note in the pull request.

