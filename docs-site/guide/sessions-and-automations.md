# Sessions and Automations

Sessions are the foundation of clean context management in Keygate.

## Session strategy

Use one session per problem space.

Examples:

- `infra-debug-staging`
- `docs-rewrite`
- `feature-auth-flow`

Benefits:

- cleaner prompt history
- lower context confusion
- easier post-incident review

## Session lifecycle

- Create
- Rename
- Switch
- Delete

Best practice: rename sessions early to keep your sidebar and history readable.

## Automations lifecycle

Scheduler jobs are linked to target sessions.

Required fields:

- cron expression
- target session
- prompt
- enabled state

## Cron design tips

- Start with disabled jobs, then dry-run manually
- Prefer explicit schedules over overly frequent intervals
- Use one-purpose prompts (single responsibility)

## Safe automation patterns

- Notification summaries
- Regular status snapshots
- Health checks with bounded scope

## Patterns to avoid

- very high-frequency jobs without backoff
- broad prompts that can trigger risky tools repeatedly
- shared session targets for unrelated automations

## Debugging automations

If a job appears idle:

1. verify it is enabled
2. verify cron expression validity
3. verify target session exists
4. run job manually with **Run now**
5. inspect tool/stream activity and logs
