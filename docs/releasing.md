# CI and releases

## How it works

`dev` is the default branch: all work branches from it and is merged back into it. `main` only moves when you promote `dev` to it, and only `main` produces releases.

1. **Every PR to `dev`** runs two workflows:
   - `PR title` (`.github/workflows/pr-title.yml`) checks the title is a [conventional commit](https://www.conventionalcommits.org/), e.g. `feat: add Kick follow events` or `fix(sammi): parse empty badge list`.
   - `CI` (`.github/workflows/ci.yml`) runs `pnpm typecheck`, `pnpm test` and `pnpm build:exe` on Windows, macOS (arm64 and x64) and Linux (x64 and arm64), then reports a single `CI passed` check. If it passes, the `merge` job re-checks the PR's current title and squash-merges the PR using the title as the commit subject and the description as the commit body. It only merges the exact commit CI tested. PRs from forks are never merged automatically.
2. **Promote `dev` to `main`** (you do this yourself) by opening a PR from `dev` into `main`. CI runs on it, but it isn't merged automatically. Merge it with **Create a merge commit**, never squash or rebase: release-please needs the individual conventional commits, and a squash would also leave `main` with history `dev` doesn't have.
3. **The `Release` workflow** (`.github/workflows/release.yml`) runs after every push to `main`. release-please reads the conventional commits since the last release and opens or updates a PR titled `chore(main): release X.Y.Z` that bumps `package.json` and `CHANGELOG.md`.
4. **Merging the release PR** (you do this yourself, whenever you want to ship) creates the `vX.Y.Z` tag and GitHub release, then builds all five executables and attaches them to it along with `integrations/firebot/sb-bridge.js` and `sb-bridge.config.example.json`. CI doesn't run on the release PR, because it only changes the version and changelog from commits that already passed CI. The workflow then merges `main` back into `dev`, so `dev` gets the new version and changelog.

No secrets are needed; everything uses the built-in `GITHUB_TOKEN`.

### Version bumps

| PR title | Before 1.0.0 | From 1.0.0 |
|---|---|---|
| `fix: …` | patch | patch |
| `feat: …` | minor | minor |
| `feat!: …`, or `BREAKING CHANGE: …` on its own line in the PR description | minor | major |
| `docs:`, `chore:`, `test:`, `refactor:`, `ci:` … | no release | no release |

To release 1.0.0, put `Release-As: 1.0.0` on its own line at the end of a PR description.

## One-time GitHub setup

1. **Settings → Actions → General → Workflow permissions:** tick **Allow GitHub Actions to create and approve pull requests**. release-please needs it to open the release PR.
2. **Settings → General → Default branch:** `dev`.
3. **Optional: protect the branches** (Settings → Rules → Rulesets). For `main`: require a pull request and the `CI passed` check, block force pushes, and add **Repository admin** to the bypass list. The release PR has no CI checks, so you'll need to tick "merge without waiting for requirements" when you merge it. Protecting `dev` the same way would block the post-release merge from `main` (it pushes directly with `GITHUB_TOKEN`); if you do, merge `main` into `dev` yourself after each release.
