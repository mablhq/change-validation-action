# Build your own client

This action is one client of mabl's change validation API. If your pipeline isn't on GitHub Actions, or you want
your own steps, this page lists the rules a client has to follow, case by case. They are the rules this action
follows, and [src/stage-request.mjs](../src/stage-request.mjs) is a working example of each.

For the calls themselves, with every field, see the
[mabl API reference](https://api.help.mabl.com/reference/sendchangevalidationevent). For the settings a policy
file takes, see the [policy file reference](policy-file.md).

- [The calls](#the-calls)
- [Every stage request](#every-stage-request)
- [A pull request's own stage](#a-pull-requests-own-stage)
- [A merge queue entry](#a-merge-queue-entry)
- [A deployed commit](#a-deployed-commit)
- [A merged pull request](#a-merged-pull-request)
- [Ordering and retries](#ordering-and-retries)
- [Reading the status](#reading-the-status)
- [The pull request comment](#the-pull-request-comment)

## The calls

| Call | When | Route |
|---|---|---|
| Stage request | Each time a change reaches a stage of the policy | `POST /changeValidation/events`, kind `stage.requested` |
| Status | When the pipeline needs the result | `POST /changeValidation/status` |
| Report | To show results on the pull request | `POST /changeValidation/report` |
| Merged event | When a pull request merges | `POST /changeValidation/events`, kind `pull_request.merged` |
| Turn off, reset | To stop validating a change, or start over | `POST /changeValidation/close`, `/reset` |

The first stage request for a change starts a mabl agent for it. The agent handles every later request for the
change, and acts as the API key that sent the first one, for as long as the pull request is open. Every later
caller must also be able to do everything the agent does. If that first key is deleted or expires, requests fail
with `principal_gone` until the change is reset.

## Every stage request

- **Skip pull requests from forks**, and any pull request you can't tell is not from a fork. mabl can't tell for
  you.
- **`reference.id`** names the change, in lowercase. For a pull request: `{host}/{owner}/{repo}#{number}` on
  GitHub, such as `github.com/acme/shop#42`, or `{host}/{organization}/{project}/_git/{repo}#{number}` on Azure
  DevOps. Build it from the repository's name and the number, not from a URL, with no leading zero. A different ID
  is a different change, with its own agent.
- **`event.head_sha` and `event.base_sha`** are full 40-character SHAs in lowercase.
- **`event.occurred_at`** is when the event happened in your source control, in milliseconds since the Unix epoch:
  the time of the event that triggered the request, not the time the pull request was created. A retry keeps the
  same time. It can be at most 5 minutes ahead of mabl's clock.
- **The policy file** goes in one `validation_policy` artifact. Its `base_sha` is the commit you read the file at,
  `text` is the file's contents, and `sha256` is the hex SHA-256 of `text`. When that commit has no policy file,
  send `found: false` and leave out `text` and `sha256`.
- **If reading the policy file fails, send nothing** and retry the read. A failed read is not a missing file, and
  `found: false` fails the stage.
- **`change_description`** is all mabl knows about the change: it doesn't read your source code or the diff. Send
  the pull request's title and description and the files it changes, grouped by application when the repository
  holds more than one. Up to 20,000 characters.
- **`event.changed_paths`** are the files the change touches, with both names of a renamed file, up to 3,000
  paths. mabl runs the stage only for the applications whose `trigger_paths` match. Without the list, every
  application applies. If the list can't hold every changed file, set `event.changed_paths_truncated` to `true`.
- **`event.labels`** are the pull request's labels when you send, up to 100. mabl uses them for waivers.
- **`dry_run: true`** reports what the stage would run without running any test. A stage request without it
  follows the change's first request.

## A pull request's own stage

- `event.head_sha` is the pull request's current head, and `event.base_sha` its base. Fetch them when you send,
  not from an earlier webhook payload.
- `event.head_ref` is the pull request's branch.
- `event.pull_request_head_sha` is the same as `event.head_sha`.
- `event.changed_paths` are the files that differ between the base and the head.
- Read the policy file at the pull request's base commit, so its author can't change the rules it's checked
  against.
- `event.mabl_branch` names the mabl branch the pull request's tests live on, when it isn't named like the pull
  request's git branch. This action reads it from a `Mabl branch: <name>` line in the description.
- Send a new request when the pull request opens, gets a new commit, or changes its base branch. An edit to the
  title or description alone needs no request.

## A merge queue entry

Send the stage your policy defines for the merge queue, to the entry's own pull request.

- `event.head_sha` is the queue's commit for the entry, and `event.base_sha` is that commit's first parent.
- `event.head_ref` is still the pull request's branch.
- `event.pull_request_head_sha` is the pull request head the queue's commit contains. mabl uses it to reuse the
  analysis of that head, and to mark the stage's result as outdated after a new commit.
- `event.changed_paths` are the files that differ between the merge group's base and the queue's commit: the same
  files your pipeline uses to decide what to build and deploy for the entry. Don't send the pull request's own
  list. When the two differ, mabl can run tests against a deployment your pipeline never made, or skip one it did.
- Read the policy file at the merge group's base, so a pull request ahead in the queue can't change it. Put that
  commit in the artifact's `base_sha`.
- `event.labels` are the entry's own pull request's labels.
- **Send nothing for a build the queue has dropped.** When an entry is rebuilt, the dropped build's late request
  would replace the live one.

On GitHub, the merge queue branch names the entry's pull request: `gh-readonly-queue/{base-branch}/pr-{number}-{sha}`.

## A deployed commit

For a stage that runs after a merge deploys, send the request for the commit instead of a pull request. The stage
needs `scope: revision` in the policy. Each deployed commit gets its own agent, and no pull request's status
waits on its stages.

- `reference` is `{"type": "commit", "id": "{sha}"}`, with the commit's full SHA in lowercase.
- `event.head_sha` is the same commit. `event.base_sha` is the commit the environment ran before this deployment,
  so the analysis covers everything the deployment changes.
- `event.head_ref` is the branch or tag the commit was deployed from.
- `event.changed_paths` are the files that differ between `event.base_sha` and `event.head_sha`.
- `event.labels` are labels you vouch for, such as the labels of the pull request merged at the commit.
- Leave out `event.pull_request_head_sha` and `event.mabl_branch`. A deployed commit's tests run from master.
- Read the policy file at the deployed commit itself. In the artifact, set `revision` to the commit instead of
  `pull_request`, and use the commit as both `base_sha` and `head_sha`.
- **Send only merged commits.** The policy is read at the commit itself, so the commit must be on a branch nobody
  can change without review, such as your default branch.
- A deployed commit's agent keeps to the repository of its first request. A request that names another one is
  refused with `another_repository`.
- To run a stage again, for example after a redeploy of the same commit, send the request again with a later
  `occurred_at`. The new run replaces the earlier one as the stage's status.

## A merged pull request

Send a `pull_request.merged` event when a pull request merges. With `merge_mabl_branches: true` in the policy,
mabl then merges the pull request's mabl branch into master. Without it, the event only records the merge.

- `event.head_sha` is the merge commit, `event.head_ref` the pull request's branch, and `event.occurred_at` when it
  merged. The event takes none of a stage request's other fields.
- Read the policy file at the merge commit, and send it in the same artifact, with the merge commit as both
  `base_sha` and `head_sha`.
- The event needs an earlier stage request for the pull request. Without one, mabl answers `no_change_agent`, and
  there is nothing to do.
- mabl merges as the API key that sends the event, so it must be a Command Line Interface key. Another key gets
  `principal_too_narrow`.
- The merge is fast-forward only. A branch master has moved past is left open and reported as `diverged`.
- A pull request merges once. A repeat for the same merge commit is a `duplicate` and merges nothing, unless the
  first one's policy didn't merge branches and this one's does. An event for another merge commit is `superseded`.
- A pull request closed without merging sends nothing.

The answer to an `accepted` or `duplicate` merged event has a `landed` field with the merge commit and what
happened to the branch, and so does the status from then on. Each entry of `landed.branches` has the branch's
`name` and `outcome`, and a `diverged` one lists `diverged_entities`, the tests and flows master moved past.
`diverged` and `failed` need a person to finish the merge in mabl, so make them visible: this action fails its
step on them. An older api may answer without `landed`; read the status for it then.

## Ordering and retries

mabl orders the requests for one stage by `event.occurred_at`, and never against another stage's requests. The
response's `event` says what became of each one:

| `event` | Meaning |
|---|---|
| `accepted` | mabl stored the request and started on it. |
| `duplicate` | A request with the same time, head and base already arrived, so mabl didn't start on it again. |
| `superseded` | The stage already has a newer request, so mabl ignored this one. |

- A late or repeated delivery can't roll a stage back to an older commit, so any request is safe to retry.
- Two requests at the same time with different commits: the later arrival wins.
- Retry only a `429`, a `5xx` and `agent_stopping`. Every other error stays until the request changes.
- A merged event merges the mabl branch inside the call, so give it a long timeout, and don't send it again while
  the first call may still be running: after no answer, or a gateway's error rather than mabl's own, wait a few
  minutes before sending it again. A second event during the first one's merge can find the merge half done and
  record the branch as `diverged`.

## Reading the status

- Name the stage and the commit you sent in its stage request, and only after mabl accepted that request.
- Send `trusted_providers: caller` with the same API key that sent the stage request whenever the status gates a
  merge. mabl then judges only that key's requests and policies. `any` accepts every sender, which suits a
  report.
- Gate on the stage's `gate`, not on the overall `status`: let the change through on `ready`, fail on `fail`, and
  ask again on `wait`, about every 20 seconds, until your own deadline.
- A stage with no `must_pass` check is `ready` at once, even while its tests run.
- `head_replaced: true` means a newer request replaced the commit you named. The gate is `fail`: the result you
  were waiting for no longer applies.
- When nothing was published by your deadline, publish a failure, so a required status doesn't stay pending.
- When your own step stops without a result, on an input it can't use or an unexpected error, publish `error`
  instead. Otherwise the status stays pending, or an earlier one for the same commit stays in place.
- If change validation is off for the workspace (`feature_disabled`), fail the gate. A stage nobody judged
  shouldn't pass.

## The pull request comment

`POST /changeValidation/report` with `format: markdown` returns a ready-made comment in `markdown`.

- Keep one comment and update it in place. Its first line is `<!-- mabl-change-validation -->`; find your earlier
  comment by that line, and only among comments your own token wrote.
- Its second line is `<!-- mabl-change-validation-data {json} -->`. A tool that reads the comment should read that
  line, not the prose.
- The report is worked out on every call. Ask again when an analysis finishes or a stage's checks finish.
- A failed report read or post should never fail the step or change the status.
