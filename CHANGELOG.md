# Changelog

## Unreleased

- Docs: the full policy file reference (`docs/policy-file.md`), a README for the policy check, and example policies
  for a shared staging environment, a repository with more than one application, and mabl branches. The README
  lists every `outcome` the action can return.
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
