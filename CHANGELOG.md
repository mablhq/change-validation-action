# Changelog

## Unreleased

- **A comment with text after the trigger word now sends something different.** It sends one `stage.requested`
  event for the pull request's current head, the same request the trigger word alone sends, with the text in
  `event.command`, timed at the comment's creation. The action no
  longer sends `event.kind: command`. As a stage request it now needs `stage`, as the reusable workflow already
  passes, follows `expected-head-sha` and `require-expected-head`, and is up to 2,000 characters. A re-run of
  the job sends the same time, so mabl takes the comment once. The trigger word alone is unchanged.
- With `await` on a merge queue entry, when mabl answers that a newer request replaced the commit being waited on
  and the queue no longer has that commit, the action publishes no conclusion on it, leaves the pull request's
  comment alone and passes, with `outcome` `entry_gone`, as when the queue drops an entry before sending.
  Previously it published `failure` on the dropped commit and could leave a failed comment over a rebuild's
  result. When the queue still has the commit, or the entry can't be read, the failure is published as before.

## 1.0.3

- Policy: `run_mabl_branch_tests`, an impacted test rule, on by default. Also run the tests created or edited on
  the pull request's mabl branch that the analysis didn't pick, up to 25 per check. The report lists them apart
  from the analysis's tests.

## 1.0.2

- `expected-head-sha`: on a pull request's stage request or the trigger word alone, send only if the pull
  request's head is still the commit the caller checked; otherwise nothing is sent and `outcome` is `skipped`.
  Closes the gap between a workflow's own check of a head, such as a deployed preview, and the request. Empty
  turns the check off; `require-expected-head: true` makes an empty value fail instead. A malformed value fails
  the run on any event.
- `send: false`, with `comment: true`: send no stage request and keep the pull request's comment current from
  mabl's report, on `pull_request` and `issue_comment`, for up to `comment-wait-minutes`. `outcome` is
  `comment_only`. It reads the report again just before each write, and writes nothing that poll when that read
  fails or names another session. Every existing input combination behaves as before.
- On a merged pull request, the action logs what became of its mabl branch, from `landed` in mabl's answer to the
  merged event: `merged`, `nothing_to_merge`, `not_open` and `left` as notices, and an outcome it doesn't know, or
  no outcome at all, as a warning. **The step now fails on `diverged` and `failed`**, naming the branch and, for
  `diverged`, the tests and flows master moved past. The pull request has already merged, so this blocks nothing;
  it tells someone to finish the merge by hand in mabl. A re-run reports the recorded outcome again and says so.
- The merged event waits up to 5 minutes for mabl's answer, since mabl merges the branch inside that call, and is
  no longer sent again after no answer or any error but a 429 or `agent_stopping`, which could find the first
  call's merge half done. The step fails and says to re-run the job. A 429 and `agent_stopping` are still retried.
- With `comment: true`, a merged pull request mabl took updates the comment, then reads and posts once more
  20 seconds later. The comment mabl renders now also names the mabl branch each stage's tests run on.
- Docs: a policy `target` takes `api_url`, the address API tests run against, with `{sha7}` like `url`. Use it
  when API tests should reach a preview deployment per commit instead of the environment's own API URL.
- Docs: the README's "Learn more" links point at the change validation help articles.

## 1.0.1

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
  the status context, and `status` is `error`. The reusable workflows keep their own step for a run that died
  before it could.
- The reusable workflow for deployed commits is now `deployed-commit.yml`. `revision.yml` still works and calls it.
- Examples: `examples/merge-queue-placeholder.yml`, which publishes the merge queue's status as a success on each
  pull request. GitHub needs a required status on the pull request before it can enter the queue, and the README's
  merge queue step now says so.
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
