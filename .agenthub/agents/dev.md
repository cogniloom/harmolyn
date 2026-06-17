# dev agent — durable project notes

## Branch policy
- `main` is production.
- All agents push feature work, bug fixes, and docs to `development`, never directly to `main`.
- `development` → `main` promotion is owned exclusively by `@ops` and covers merge, deploy, and restart.
- Never force-push `main` or open PRs targeting `main` directly.

