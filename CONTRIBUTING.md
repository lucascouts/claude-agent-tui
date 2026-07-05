# Contributing

Thanks for your interest in `@lucascouts/claude-agent-tui` — the published npm
mirror of an ACP bridge that drives the Claude Code subscription TUI over a PTY.

## Ways to contribute

- **Report a bug or request a feature** via
  [GitHub Issues](https://github.com/lucascouts/claude-agent-tui/issues).
  Include your OS, Node version, Zed (or other ACP client) version, and a
  minimal reproduction.
- **Report a vulnerability** privately — do **not** open a public issue. See
  [SECURITY.md](SECURITY.md).
- **Open a pull request** for fixes and improvements.

## Development

```sh
npm install
npm run build
npm test        # build + node:test suite
npm run check   # eslint src + prettier --check
```

- Source lives in `src/` and is type-checked with TypeScript in `strict` mode.
- The enforced style gate is `eslint src` plus `prettier --check .`; run
  `npm run format` before pushing.
- Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/) — releases and the
  changelog are automated by release-please, so the prefix (`feat:`, `fix:`,
  `chore:`, …) determines the next version.

## Licensing of contributions

This project does **not** require a Contributor License Agreement (CLA).
Contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be
> licensed under the [Apache License, Version 2.0](LICENSE). You affirm that you
> have the legal right to submit your work, that you are not including code you
> do not have rights to, and that you understand contributions are made without
> requiring a Contributor License Agreement (CLA).

This is a derivative work; original copyright belongs to Zed Industries and the
Agent Client Protocol authors.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
