## What and why

<!-- What does this change and which problem does it solve? Link the issue: Closes #123 -->

## How it was tested

<!-- Commands you ran and what they showed. A bug fix comes with a test that fails without it. -->

## Checklist

- [ ] Commits follow Conventional Commits and are signed off (`git commit -s`)
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass (and the Python checks, if touched)
- [ ] Docs, `README.md` or `.env.example` updated for user-facing changes
- [ ] `packages/plugin-api` changed? The api-extractor report is updated
- [ ] No real credentials, hostnames, IP addresses or personal data in code, config, tests or screenshots
