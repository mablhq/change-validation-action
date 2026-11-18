# Changelog

## 1.0.0

First release.

- `mablhq/change-validation-action`: ask mabl to validate a stage of your policy for a pull request, a merge queue
  entry or a deployed commit, and optionally wait for the stage's status and publish it as a commit status.
- `comment` and `comment-wait-minutes`: keep one comment on the pull request with mabl's change validation report,
  off by default.
- `mablhq/change-validation-action/policy`: check `.mabl/policy.yaml` and show what changed from the base.
- Reusable workflows for the pull request, merge queue and deployed-commit stages, and for the policy check.
