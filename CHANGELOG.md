# Changelog

## Unreleased

- Docs: the full policy file reference (`docs/policy-file.md`), a README for the policy check, and example policies
  for a shared staging environment, a repository with more than one application, and mabl branches. The README
  lists every `outcome` the action can return.
- Docs: `docs/build-your-own-client.md`, the rules a client of the change validation API follows for pull requests,
  merge queue entries, deployed commits and merged pull requests.
- `trigger-word`: on `issue_comment`, the action reads the command from the comment itself and skips a comment
  that doesn't start with the word. The reusable pull request workflow passes its `trigger-word` through.
- The quickstart and `examples/pull-request.yml` no longer subscribe to `issue_comment`. Comment commands are
  optional, with their own README section.
- With `await`, a run that stops on an input it can't use, or on an error it didn't expect, publishes `error` on
  the status context, and `status` is `error`. The reusable workflows no longer carry their own step for this.
- The reusable workflow for deployed commits is now `deployed-commit.yml`. `revision.yml` still works and calls it.
- Examples: a workflow that tells mabl a pull request merged. The deployed commit example now says its stage's
  checks need `must_pass`; without it the status reads success before the tests finish.

## 1.0.0

First release.

- `mablhq/change-validation-action`: ask mabl to validate a stage of your policy for a pull request, a merge queue
  entry or a deployed commit, and optionally wait for the stage's status and publish it as a commit status.
- `comment` and `comment-wait-minutes`: keep one comment on the pull request with mabl's change validation report,
  off by default.
- `mablhq/change-validation-action/policy`: check `.mabl/policy.yaml` and show what changed from the base.
- Reusable workflows for the pull request, merge queue and deployed-commit stages, and for the policy check.
