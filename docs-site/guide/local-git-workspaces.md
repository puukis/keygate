# Local Git Workspaces

Keygate now bootstraps local Git repositories for the workspaces it manages so the Git panel works immediately without requiring GitHub or any remote hosting.

## What gets created

When Keygate creates a managed workspace repo, it does all of the following locally on disk:

- creates `.git/` if the workspace is not already a repo
- uses `main` as the default branch
- writes a repo-local Git author identity when the repo was created by Keygate:
  - `user.name = Keygate Local`
  - `user.email = keygate@local`
- adds a minimal managed `.gitignore` block
- creates one initial local commit so Git history exists from the start

Keygate does **not**:

- add a Git remote
- talk to GitHub
- push anywhere
- rewrite an existing user repo

If you want a remote later, add it yourself with normal Git commands.

## Which folders become repos

There are two repo layers to know about:

### Root workspace repo

The configured workspace root is initialized as a local repo at startup.

That root repo ignores:

- `.keygate-browser-runs/`
- `.keygate-uploads/`
- `agents/`

Ignoring `agents/` keeps nested agent repos from showing up as noise in the root repo.

### Routed agent workspace repos

When Keygate routes a session into `agents/<agentKey>/`, that agent workspace is initialized as its own local repo the first time it is used.

Agent repos ignore:

- `.keygate-browser-runs/`
- `.keygate-uploads/`

In practice, browser artifacts and upload storage usually live in the root workspace, but Keygate still writes the ignore block consistently for managed repos.

## What gets committed automatically

Keygate only auto-creates an initial commit for repos that **it created itself**.

For that first commit, Keygate stages only its own bootstrap files:

- the managed `.gitignore` changes
- continuity files created or migrated in that same startup run, when the repo is also the continuity workspace

If a custom workspace already contains unrelated files, Keygate leaves them alone. They stay untracked until you decide what to do with them.

## How this looks in the web app

The Git tab follows the active session workspace.

- before a routed session is established, the web session can still point at the root workspace repo
- after routing, the Git tab reflects that session's agent workspace repo
- opening the Git tab automatically refreshes Git status

The Git panel lets you:

- review staged, unstaged, and untracked changes
- stage or unstage files
- discard unstaged changes
- create commits from staged changes
- inspect recent commit history

## Safe Mode confirmation behavior

There are two different Git control paths:

- **Git tab actions** are direct operator actions in the UI
- **assistant Git tool actions** are agent-triggered tool calls

When the assistant uses native Git tools in Safe Mode, mutation actions still keep confirmation protection:

- `git_stage`
- `git_unstage`
- `git_discard`
- `git_commit`

That means Keygate gains native Git support for the assistant without silently lowering the existing guardrails.

## Changing the local author identity

If you want commits in a Keygate-created repo to use your own author details instead of the default local identity, set repo-local config yourself:

```bash
git -C /path/to/workspace config user.name "Your Name"
git -C /path/to/workspace config user.email "you@example.com"
```

Keygate only sets the default identity when it creates a brand-new repo. Existing repos are preserved as-is.

## Working with remotes later

If you later decide you want GitHub, GitLab, or another remote, add it manually:

```bash
git -C /path/to/workspace remote add origin <remote-url>
git -C /path/to/workspace push -u origin main
```

Keygate will continue to treat the repo as local Git state unless you explicitly manage remotes yourself.
