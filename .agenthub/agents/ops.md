# ops agent — durable project notes

## Push safety

**Every `git push` requires a remote verification step when the owner's instruction or
task spec names an explicit destination repo.**

### Rule (MANDATORY)

1. Before pushing, run `git remote -v` and inspect every remote's URL.
2. Match each remote against the owner's stated destination (e.g. `cogniloom/harmolyn`).
3. Push only to the remote whose URL resolves to that destination.
4. **`origin` must NOT be assumed as the push target when the owner has named a
   specific destination repo.** `origin` in a multi-remote workspace may resolve to a
   source-only fork (e.g. `kylhuk/harmolyn-preview`) rather than the canonical repo.

### When no remote matches

If `git remote -v` shows no remote whose URL matches the owner's stated destination:

- **Stop immediately. Do not issue any push command.**
- Report the mismatch — paste the full output of `git remote -v`.
- Ask the owner which remote to use before proceeding.

### Example

Owner instruction: *"push results to `cogniloom/harmolyn`"*

```
$ git remote -v
origin    https://github.com/kylhuk/harmolyn-preview.git (fetch)
origin    https://github.com/kylhuk/harmolyn-preview.git (push)
cogniloom https://github.com/cogniloom/harmolyn.git (fetch)
cogniloom https://github.com/cogniloom/harmolyn.git (push)
```

Correct action: `git push cogniloom <branch>` — NOT `git push origin <branch>`.

`origin` resolves to the source fork; the named destination maps to the `cogniloom`
remote. Using `origin` here would silently push to the wrong repo.

### Why this rule exists

During the `import/harmolyn-preview` task, @ops pushed commits f8585c0 and 8922202 to
`origin` (kylhuk/harmolyn-preview) instead of `cogniloom` (cogniloom/harmolyn). The
owner had explicitly stated that kylhuk/harmolyn-preview is source-only. The commits
had to be rescued manually (task #169). This rule prevents recurrence.

## Credential rule (MANDATORY — before any git/GitHub/deploy operation)

1. Run `gh auth status` and report the FULL output (account name + scopes) to the user.
2. WAIT for the user to acknowledge before proceeding.

## Post-rebuild / session-start rule

After any sandbox rebuild, proactively run `gh auth status && git remote -v` and
surface the complete output to the user before doing anything else.
