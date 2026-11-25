# mabl change validation

Validate every pull request, merge queue entry and deployment with mabl, from GitHub Actions.

A policy file in your repository, `.mabl/policy.yaml`, lists the checks for each stage of your workflow: suites
of mabl tests you always run, such as a smoke suite, and the tests the change impacts, which mabl finds with
test impact analysis. When your workflow reaches a stage, this action asks mabl to validate it. mabl runs the
stage's checks against the environment you name and reports a status for each one, so your workflow can let
the change through or hold it back.

You decide which checks must pass. A check starts as a warning; set `must_pass: true` when you're ready for it to
block.

> Change validation is in early access for mabl accounts with generative AI features. Pricing and packaging are
> subject to change.

To analyze a change, the action sends mabl your policy file; the repository, branch and commits; the pull
request's title, description (the first 8,000 characters, unless you pass your own `change-description`) and
labels; the names of the changed files, grouped by application; and the diff totals. For a deployed commit it sends
the titles of the pull requests merged since the base commit, and a request typed in a comment is sent as typed
to the pull request's mabl agent. It never sends the contents of the files your change touches. Don't put secrets
in a pull request's description or in a comment's request.

## Before you start

- A mabl workspace with generative AI features.
- A mabl API key of the **Command Line Interface** or **Editor** type, stored as an encrypted secret, for example
  `MABL_API_KEY`. See [managing API keys](https://help.mabl.com/hc/en-us/articles/17776006239764). Make a key for this
  workflow, not a personal one. To have mabl merge mabl branches, it must be a Command Line Interface key.
- Your mabl workspace's ID, which every call names. Workspace IDs aren't secret.
- A `.mabl/policy.yaml` that names your mabl application, environment and plans, and the stages your workflow
  asks for. Start from [examples/policy.yaml](examples/policy.yaml). Every setting is in the
  [policy file reference](docs/policy-file.md).

## Quickstart

1. **Add the policy file.** Copy [examples/policy.yaml](examples/policy.yaml) to `.mabl/policy.yaml`, fill in
   the IDs from your workspace, and check it with the mabl CLI (`npm install -g @mablhq/mabl-cli`):

   ```sh
   mabl policy resolve --file .mabl/policy.yaml
   ```

   Merge it first: mabl reads the policy from the branch a pull request targets, so a pull request can't change
   the rules it's checked against.

2. **Validate each pull request.** Add [examples/pull-request.yml](examples/pull-request.yml) as a workflow:

   ```yaml
   on:
     pull_request:
       types: [opened, synchronize, reopened, edited]
   jobs:
     mabl:
       permissions:
         contents: read
         pull-requests: read
       uses: mablhq/change-validation-action/.github/workflows/pull-request.yml@v1
       with:
         stage: pull_request
         workspace-id: your-workspace-id
       secrets:
         mabl-api-key: ${{ secrets.MABL_API_KEY }}
   ```

3. **Gate the merge queue (optional).** Add [examples/merge-queue-after-preview.yml](examples/merge-queue-after-preview.yml)
   after the job that deploys the queue's commit, and require its status context in your branch rules. GitHub
   also wants a required status on the pull request before it enters the queue, so add
   [examples/merge-queue-placeholder.yml](examples/merge-queue-placeholder.yml) too.

For a stage that runs after a merge deploys, such as to a shared staging environment, see
[examples/revision-after-deploy.yml](examples/revision-after-deploy.yml). To check the policy file on the pull
requests that change it, see [examples/policy-check.yml](examples/policy-check.yml).

## The policy file

The [policy file reference](docs/policy-file.md) lists every setting, with its default, rules and limits. Example
policies to start from:

| Policy | For |
|---|---|
| [examples/policy.yaml](examples/policy.yaml) | A preview per pull request, and a merge queue that must pass |
| [examples/policy-shared-staging.yaml](examples/policy-shared-staging.yaml) | No previews: report on the pull request, run after the merge deploys |
| [examples/policy-monorepo.yaml](examples/policy-monorepo.yaml) | More than one application in a repository |
| [examples/policy-mabl-branches.yaml](examples/policy-mabl-branches.yaml) | Tests updated on a mabl branch alongside the code |

## Deployed commits

Most pipelines call the action from their deploy job, or from a `workflow_run` that follows it. These events send
a deployed commit, for the policy's `scope: revision` stages:

| Event | Commit validated | `base-sha` |
|---|---|---|
| `push` to a branch | The pushed commit | Defaults to the push's previous commit; required for a new branch |
| `push` of a tag | The tagged commit | Required, for example the previous tag's commit |
| `deployment_status` | The deployment's commit | Required |
| `workflow_run` | The commit the triggering run ran on | Required |
| `workflow_dispatch`, `release`, `schedule` | The run's commit | Required |

`head-sha` overrides the commit. Except for the commit a branch push just pushed, it must be on the default branch,
or the action refuses it. `base-sha` is the commit the environment ran before, which the change is measured from.

## What's here

| Use | For |
|---|---|
| `mablhq/change-validation-action@v1` | The action: send one stage request, and with `await`, wait for the stage's status and publish it as a commit status |
| `mablhq/change-validation-action/policy@v1` | Check a policy file at a commit and show what changes from another. See [policy/README.md](policy/README.md) |
| `.github/workflows/pull-request.yml` | Reusable: pull request stages, and [comment commands](#comment-commands) if you add the trigger |
| `.github/workflows/merge-queue.yml` | Reusable: a merge queue stage, awaited and published as a commit status |
| `.github/workflows/deployed-commit.yml` | Reusable: a stage for a deployed commit (`scope: revision` in the policy). `revision.yml`, its earlier name, still works |
| `.github/workflows/policy-check.yml` | Reusable: the policy check on pull requests |

## The action's inputs

| Input | Default | |
|---|---|---|
| `mabl-api-key` | required | A Command Line Interface or Editor key. The first stage request for a pull request decides which key mabl acts as for it |
| `stage` | | The policy stage to validate, by the name your policy gives it |
| `workspace-id` | required | The ID of the mabl workspace to validate in |
| `dry-run` | `false` | `true` reports what would run without starting a test run |
| `file` | `.mabl/policy.yaml` | The policy file's path |
| `await` | `false` | On `merge_group` and deployed commits: wait for the stage's status and publish it |
| `status-context` | | With `await`, the commit status context to publish |
| `deadline-minutes` | `40` | With `await`, how long to wait before publishing failure, 1 to 120. Set the job's `timeout-minutes` to at least this + 5 |
| `change-description` | built from the pull request | What the change does, in product terms, written by any earlier step. When empty, the action builds one from the pull request's title, body, changed paths per application and diff totals |
| `change-description-head-sha` | | The head `change-description` was written for; required with it |
| `expected-head-sha` | | On a pull request or a comment: send only if the pull request's head is still this commit; empty turns the check off. See [Sending only the head you checked](#sending-only-the-head-you-checked) |
| `require-expected-head` | `false` | `true` fails, sending nothing, when `expected-head-sha` is empty where it applies |
| `head-sha`, `base-sha` | the event's | For a deployed commit: the commit, and the one the environment ran before |
| `trigger-word` | | On `issue_comment`, the word a comment must start with, such as `/mabl`. See [Comment commands](#comment-commands) |
| `command` | | On `issue_comment` without `trigger-word`, the text after your own trigger word, sent with the stage request to the pull request's mabl agent |
| `comment` | `false` | `true` keeps one comment on the pull request with mabl's report. See [The pull request comment](#the-pull-request-comment) |
| `comment-wait-minutes` | `15` | With `comment`, how long after a pull request stage request to keep the comment current |
| `send` | `true` | `false` sends no stage request and only keeps the comment current; needs `comment: true`. See [Keeping the comment current without a request](#keeping-the-comment-current-without-a-request) |
| `api-url` | `https://api.mabl.com` | The mabl api; no other is accepted |
| `token` | `github.token` | Reads the pull request and the policy file; with `await`, needs `statuses: write`; with `comment`, `pull-requests: write` |

Outputs: `outcome`, `session-id`, `created`, `agent`, `description-source` (`built` or `provided`), and with
`await`, `status` (`success`, `failure` or `error`). When the request was sent, `outcome` is `accepted`,
`duplicate` or `superseded`, and with `send: false` it is `comment_only`. Otherwise it says why not: `skipped`,
`entry_gone` (a merge queue build the queue dropped), `refused`, `feature_disabled`, `change_agent_closed`
(validation was turned off for the pull request), another error code from mabl, `failed`, or with `await`,
`timed_out`. With `await`, `entry_gone` also follows a sent request: when a rebuild of the entry replaced the
commit being waited on and the queue no longer has that commit, the action publishes no conclusion, leaves the
comment alone and passes.

If change validation is off for the workspace, mabl answers `feature_disabled`: the step passes with a notice and
nothing is validated. With `await`, the commit status is `failure`, so a gate can't pass on a stage nobody judged.

If an awaited run stops before it gets that far, on an input it can't use or an error it didn't expect, it
publishes `error` on the status context and sets `status` to `error`, so a required status doesn't stay pending.
With no status context or commit to publish to, `status` stays empty. A run that is killed outright publishes
nothing, and an earlier status for the same commit stays in place; the reusable workflows add a last step that
publishes `error` for that case, and if you call the action yourself you can copy it.

## The pull request comment

With `comment: true`, the action keeps one comment on the pull request with mabl's report of the change: for
each application, the impacted tests (kept or left out, and why), the numbered coverage gaps, and how each
stage's checks are going. It posts the markdown mabl renders, as is.

- **On a pull request stage request** mabl took (`accepted` or `duplicate`), it keeps the comment current for up
  to `comment-wait-minutes`, reading the report every 20 seconds until each application the change reaches has its
  analysis. Give the job `pull-requests: write` and a `timeout-minutes` of at least `comment-wait-minutes` + 5.
- **On an awaited merge queue entry**, it updates the comment once, after the status is published.
- **With `send: false`**, on a pull request or comment event, it keeps the comment current the same way, without
  sending anything.
- **On a merged pull request** mabl took (`accepted` or `duplicate`), it updates the comment so it shows what
  became of the pull request's mabl branch, then reads and posts once more 20 seconds later, in case a merge queue
  run that read the report before the merge posted over it.
  When the pull request's mabl branch didn't merge (`diverged` or `failed`), it also posts a separate comment, once,
  that mentions the pull request's author and whoever merged it, names the branch, and says to merge it by hand in
  mabl. An edit to the report comment notifies nobody, and until the branch is merged master's tests lack the
  pull request's test changes, so other pull requests' checks can fail on them.
- **Never on** deployed commits or a request mabl didn't take, and on a comment event only with `send: false`.

The comment can't change the request's outcome, outputs or commit status: a failed report read or post is a log
line or one warning, never a failed step. It updates the oldest comment the same token wrote for the same mabl
agent, found by the marker on its first line, and never edits anyone else's. Nothing is deleted. Give
`pull_request` runs a concurrency group per pull request, as the reusable workflow does, so overlapping runs don't
leave a duplicate.

A tool that reads the comment should read its hidden data line (`<!-- mabl-change-validation-data {json} -->`), not
the prose.

### Keeping the comment current without a request

With `send: false` and `comment: true`, the action sends no stage request. It reads mabl's report of the pull
request and keeps the comment current for up to `comment-wait-minutes`, as it does after a request, and `outcome`
is `comment_only`. It creates the comment if there is none yet. It runs on `pull_request` (the same actions a
request is sent for) and `issue_comment` events, and makes the checks a request from the same event would: no
forks, and on a comment the trigger word and a commenter with write access.

Without a request of its own, it reads the report again just before each write, so it doesn't put back an older
report than a run that sent a request has just written. If that read fails or names another session, it writes
nothing and tries again on the next poll. A run that sends and a run with `send: false` for the
same pull request can still overlap for that one read, so give both a concurrency group per pull request where
you can.

Use it when your workflow decides not to send, but the comment should still catch up. For example, a workflow
that sends only a pull request's first commit can still keep the comment current on later pushes, so it
doesn't stop updating when a push cancelled an earlier run's wait. When mabl has no agent for the pull request
yet, it posts nothing and logs why.

### Before turning it on in a public repository

- **Anyone can read the comment**, including your mabl test names and the coverage gaps it lists.
- **A maintainer can edit any comment**, the data line included. Treat what the comment says as a summary, and
  read the status from mabl, as the action does, for anything that gates a merge.
- **Only people with write access should start a run that costs credits.** The reusable workflow takes comment
  commands only from owners, members and collaborators, and the action then checks the commenter has write access;
  keep the first check if you call the action yourself.

## When a pull request merges

mabl answers the merged event with what became of the pull request's mabl branch, and the action logs it:

| Branch outcome | Means | The step |
|---|---|---|
| `merged` | Merged into master | Passes, with a notice |
| `nothing_to_merge` | Open, with no edit to merge | Passes, with a notice |
| `not_open` | It doesn't exist, is already merged, or isn't a working branch | Passes, with a notice |
| `left` | The policy doesn't set `merge_mabl_branches`, so mabl left it open | Passes, with a notice |
| `diverged` | master changed after the branch for a test or flow, so mabl left it open | **Fails**, naming the branch and those tests and flows; with `comment`, posts a notice that mentions the author and merger |
| `failed` | The merge failed, and the branch may be partly merged | **Fails**, naming the branch; with `comment`, posts the same notice |

When no stage ran on a mabl branch there is nothing to merge, and the step passes with a notice saying so. An
outcome this version of the action doesn't know passes with a warning.

mabl merges fast-forward only and never forces a merge, so a failed step means a person has to finish it: open the
branch in mabl and merge it into master by hand. The pull request has already merged, so the failure can't block
anything; it's there so someone sees it. `outcome` is still the event's, such as `accepted`. The error names the
tests and flows master moved past, up to ten with each name cut short, and the log lists them in full. Running the
job again doesn't merge again: mabl answers `duplicate` with the outcome it recorded, so the step fails the same
way even after someone merged the branch by hand, and the error says it's the recorded outcome.

mabl merges the branch while it answers the merged event, so the action waits up to 5 minutes for that answer
and doesn't send the event again when it gets none, or any answer but a 429 or `agent_stopping`: mabl may still
be merging, and a second event sent meanwhile could find the merge half done. The step fails and says to re-run
the job a few minutes later, which reads the outcome mabl recorded. A 429 or `agent_stopping` is retried as
usual.

With `comment: true`, the pull request's comment shows the same outcome, and before the merge it names the mabl
branch each stage's tests run on.

## Comment commands

Optional, and off until you add the trigger. To let people with write access reach a pull request's mabl agent
from a comment, add `issue_comment` to the workflow that calls `pull-request.yml`:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  issue_comment:
    types: [created]
```

- A comment that is exactly `/mabl` sends the pull request's current head again. The workflow's `trigger-word`
  input changes the word.
- To ask for something, write `/mabl` and then your request in your own words, on the comment's first line, up to
  2,000 characters. For example:

  ```
  /mabl re-run this
  ```

  ```
  /mabl run it again, focusing on the checkout page
  ```

  The request goes, as typed, to the pull request's mabl agent with a fresh stage request for the current head.
  There is no fixed syntax to learn. The action reports that mabl took the request, not what the agent did with
  it. `duplicate` means mabl already had a request for that head at that moment, so the text wasn't applied
  again, and a request over 2,000 characters fails the step and sends nothing.
- Any other comment is skipped. GitHub still lists a skipped run for every comment on an issue or pull request,
  which is why the trigger isn't in the quickstart.
- Comments are taken only from owners, members and collaborators who have write access.
- The text goes to the pull request's mabl agent, which acts as the API key that started it, not as the
  commenter. Anyone who can comment with write access can steer it with that key's rights, so add the trigger only
  where you'd trust them with that. Whether a check passed still comes from fixed rules, never from what a comment
  says.
- If you call the action yourself, set its `trigger-word`, and keep an `if:` on the job, as the reusable workflow
  does, so other comments don't start a runner.

## Sending only the head you checked

Your workflow may check something about a pull request's head before it sends, such as that a preview
environment was deployed from that commit. The action fetches the head again when it sends, so a push in between
would send a commit your check never saw. Pass the commit you checked as `expected-head-sha`:

```yaml
- uses: mablhq/change-validation-action@v1
  with:
    mabl-api-key: ${{ secrets.MABL_API_KEY }}
    workspace-id: ${{ vars.MABL_WORKSPACE_ID }}
    stage: pull_request
    expected-head-sha: ${{ github.event.pull_request.head.sha }}
```

When the pull request's head is another commit as the request would go out, including after the action reads
the pull request again because it moved while its files were listed, nothing is sent and `outcome` is `skipped`,
with a notice. The push's own run sends the new head. It applies to a pull request's stage request and to a
comment's, with or without a request typed after the trigger word; a merged pull request, a merge queue entry, a
deployed commit and `send: false` ignore it. A value that isn't a full commit sha fails the run on any event.

An empty value turns the check off, and some expressions are empty on some events:
`github.event.pull_request.head.sha` is empty on `issue_comment`, so a comment workflow has to look the head up
itself, for example with the same API call its own check makes. Set `require-expected-head: true` to make an empty
value fail the run, sending nothing, instead of sending unchecked.

## Good to know

- **Each pull request gets one mabl agent**, started by its first stage request. It analyzes each head it's sent,
  runs the stage's checks in one deployment event per application, and reports. Fixed rules decide whether a
  check passed; the agent never does.
- **Nothing to run is a pass**, but only when the analysis succeeded. A stage mabl can't judge, such as one with
  a missing or invalid policy file, never passes.
- **Forks.** Pull requests from forks get no secrets, so the reusable workflows skip them. If you call the action
  yourself, skip them too. Dependabot pull requests aren't forks, but they get no repository secrets either: add
  the key as a Dependabot secret. Skipping them with `github.actor != 'dependabot[bot]'` works, but a skipped job
  passes a required check.
- **The policy is read at a commit the pull request's author can't change:** the pull request's base, or the
  merge group's base. Put `.mabl/policy.yaml` and the workflow files that call mabl under CODEOWNERS, and turn on
  "Require review from Code Owners" in your branch rules, or CODEOWNERS enforces nothing.
- **Outputs are untrusted.** Values from a pull request reach the outputs. Read them through `env:`, never inside
  a `run:` script.
- **A `Mabl branch: <name>` line** in the pull request's description names the mabl branch its tests live on. A
  stage that uses `mabl_branch: match-pr`, the default for a pull request stage, runs that branch's tests while it's
  open; a stage that sets `mabl_branch: master` ignores it.
  Review the branch's test changes along with the code. See [mabl branches](docs/policy-file.md#mabl-branches).
- **Merged pull requests.** Run the action on `pull_request` with `types: [closed]` to tell mabl a pull request
  merged, as [examples/pull-request-merged.yml](examples/pull-request-merged.yml) does; with
  `merge_mabl_branches: true` in the policy, mabl then merges the pull request's mabl branch into master. A pull
  request closed without merging sends nothing. See [When a pull request merges](#when-a-pull-request-merges).
- **Awaiting a deployed commit.** Two runs for the same commit and `status-context` can overlap, and the later
  write wins. The reusable `deployed-commit.yml` makes them take turns; if you call the action directly, give
  those runs a shared `concurrency` group with `cancel-in-progress: false`.
- **Pinning.** The reusable workflows call this action at `@v1`, so a workflow pinned to a commit still runs the
  action `v1` points to. To pin everything, call the action itself at a commit.

## Learn more

- [Policy file reference](docs/policy-file.md) and [policy check](policy/README.md)
- [Build your own client](docs/build-your-own-client.md), for pipelines that aren't on GitHub Actions
- [Change validation in the mabl API reference](https://api.help.mabl.com/reference/sendchangevalidationevent),
  for every status, reason and error code
- [How change validation works](https://help.mabl.com/hc/en-us/articles/55751436186260)
- [Run change validation from your own CI](https://help.mabl.com/hc/en-us/articles/55397902734740)
- [Set up a mabl policy file](https://help.mabl.com/hc/en-us/articles/55397934515348)

Questions: support@mabl.com

## License

[MIT](LICENSE)
