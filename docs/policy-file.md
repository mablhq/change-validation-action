# mabl policy file reference

The mabl policy file, `.mabl/policy.yaml`, decides which tests mabl runs when a code change reaches each stage of
your workflow, and which failures block the change. This page lists every setting the file accepts, with its type,
default and rules.

mabl checks the file, not this action. The same file works from any CI system, and
[`mabl policy resolve`](#check-a-policy-file) tells you what mabl accepts today.

- **Start from an example:** [the example policies](../README.md#the-policy-file).
- **Choose what runs:** [Suites](#suites), [Impacted test rules](#impacted-test-rules), [Checks](#checks).
- **Choose where it runs:** [Applications](#applications), [Targets](#targets), [Stages](#stages).
- **Let a change through:** [Waivers](#waivers).
- **Keep tests on mabl branches:** [mabl branches](#mabl-branches),
  [Merge mabl branches when a pull request merges](#merge-mabl-branches-when-a-pull-request-merges).
- **Check your file:** [Check a policy file](#check-a-policy-file), [File rules](#file-rules),
  [Names, IDs and labels](#names-ids-and-labels), [Limits when a stage runs](#limits-when-a-stage-runs).

## Shape of the file

```yaml
version: 1

suites:                      # named sets of plans
  smoke:
    plan_labels: [smoke]

impacted:                    # rules for impacted tests, as defaults for every impacted check
  exclude:
    test_labels: [quarantine]

applications:
  web:                       # a name you choose
    mabl_application: '[application-id]'
    target:                  # where tests run
      environment: '[environment-id]'
    stages:
      pull_request:          # a name you choose; your workflow asks for it by name
        checks:
          - kind: impacted
          - kind: suite
            suite: smoke
            must_pass: true
```

Replace each value in square brackets with the ID from your workspace. See
[mabl resource IDs](https://help.mabl.com/hc/en-us/articles/17782745983636). Use real IDs: `mabl policy resolve`
doesn't check that they exist, so a wrong one fails only when the stage runs.

## Top-level settings

| Key | Required | Default | Description |
|---|---|---|---|
| `version` | Yes | | Must be `1`. |
| `suites` | No | None | Named sets of plans, by suite name. See [Suites](#suites). |
| `impacted` | No | See [Impacted test rules](#impacted-test-rules) | The rules that decide which impacted tests run, as defaults for every impacted check. |
| `applications` | Yes | | The mabl applications your repository's changes are tested against, by a name you choose. At least one. See [Applications](#applications). |
| `merge_mabl_branches` | No | `false` | Whether mabl merges a pull request's mabl branch into master when the pull request merges. See [Merge mabl branches when a pull request merges](#merge-mabl-branches-when-a-pull-request-merges). |

## Suites

Each entry under `suites` is a suite name with these settings:

| Key | Required | Default | Description |
|---|---|---|---|
| `plan_labels` | Yes | | A list of at least one [plan label](https://help.mabl.com/hc/en-us/articles/17783271182484). The suite runs every enabled plan that carries one of these labels. |

A suite runs only when a stage has a [suite check](#suite-checks) for it. The `include.suites` and `logins_from`
rules can also name suites, to pick tests and logins from their plans.

## Impacted test rules

For each change, mabl works out which tests it is likely to affect (test impact analysis). The impacted test rules
decide which of those tests run. Only enabled browser tests run as impacted tests, and a test runs only if it passes
every rule.

Set the rules under the top-level `impacted` key, as defaults for every [impacted check](#impacted-checks), or on
one impacted check, for that check only. A check replaces only the fields it sets. For example, a check that sets
`exclude.test_labels` keeps the `exclude.median_minutes_over` from the top-level `impacted` key.

A dotted key in the table is nested YAML: `exclude.test_labels` is `test_labels` under `exclude`.

| Key | Type | Default | Description |
|---|---|---|---|
| `include.suites` | List of suite names | No restriction | Only tests in these suites' plans run as impacted tests. |
| `include.test_labels` | List of labels | No restriction | Only tests that carry one of these labels run as impacted tests, within `include.suites`. |
| `exclude.median_minutes_over` | Whole number, 0 to 120 | `10` | A test whose median passing run takes longer than this many minutes doesn't run. `0` turns the rule off. |
| `exclude.test_labels` | List of labels | None | Tests that carry one of these labels never run as impacted tests, even with a trusted label. A label here can't also appear in `include.test_labels` or `trusted.test_labels`. |
| `trusted.test_labels` | List of labels | None | Tests that carry one of these labels run without mabl reading their steps first, including tests that write data. See [Trusted labels](#trusted-labels). |
| `logins_from` | List of suite names | None | An impacted test logs in with the credentials of its plan in one of these suites. A test with no such plan uses the stage's `credentials`. |
| `others` | `write-free` | `write-free` | How mabl treats a test without a trusted label. `write-free`, the only value, runs the test only when mabl reads its steps and finds none that write data. |
| `run_mabl_branch_tests` | `true` or `false` | `true` | Also run the tests created or edited on the pull request's mabl branch that the analysis didn't pick, up to 25 per check. See [Tests on the pull request's mabl branch](#tests-on-the-pull-requests-mabl-branch). |

The rules apply only to impacted tests. A suite check still runs all of its suite's plans, including tests the
rules leave out. If a suite check in the same stage already runs an impacted test, the test runs once, as part of
the suite.

### Trusted labels

By default, mabl reads the steps of each impacted test before running it, including its flows and JavaScript
snippets, and runs only the tests with no step that writes data. With no trusted labels in your policy, an analysis
can find impacted tests and run only some of them, or none.

The analysis is best effort and can miss a test your change affects, and the read of a test's steps is a screen,
not a guarantee. To keep a test from ever running as an impacted test, give it a label under
`exclude.test_labels`. For a test that must always run, use a suite check.

- A test that creates a record and deletes it again counts as writing data.
- A test mabl can't read in full counts as writing data, for example a test with a JavaScript step longer than
  4,000 characters.
- A test that carries a label under `trusted.test_labels` runs without being read. Trust the tests you're
  comfortable running on any pull request without a review: tests that only read data, and tests that reliably
  clean up everything they create. Leave the label off tests that change data other tests or teammates depend on.
- A trusted label vouches for a test as it is on master. When a stage runs tests from a
  [mabl branch](#mabl-branches), a trusted label still clears a test the branch hasn't changed, because that test
  runs its master version. A test with its own version on the branch is read like any other test, because the
  branch may have changed what it does. To have trusted labels apply to every test, set the stage's `mabl_branch`
  to `master`.
- mabl doesn't read the flows a cleared test calls, so a flow the branch changes runs without being read.

### Tests on the pull request's mabl branch

When a stage runs on a pull request's [mabl branch](#mabl-branches), its impacted check also takes each test created
or edited on that branch for the stage's application, whether or not the analysis picked it. Those tests reach
master when the branch merges, so the check runs them before it merges.

- They pass through the same rules as the analysis's tests: mabl reads their steps, and `include` and `exclude`
  labels apply. A trusted label doesn't clear them, because each has its own version on the branch.
  `exclude.median_minutes_over` doesn't apply, since mabl has no run history to judge them by.
- A stage run takes up to 25 of them, in the branch's order. The report says how many more the branch has.
- The analysis's tests come first in the limit of 50 impacted tests per stage run.
- A test the analysis also picked is listed once, as the analysis's, and noted as on the branch.
- A test whose only change is a flow edited on the branch isn't taken, and neither is a test with no application.
- A stage that runs on master takes nothing extra.

The report lists these tests apart from the analysis's, and its next steps say how many of the branch's tests won't
run before the pull request merges, whether a rule dropped them or the limit left them out. To turn this off, set
`run_mabl_branch_tests: false` under the top-level `impacted` key, or on one impacted check.

## Applications

Each entry under `applications` is an application name with these settings:

| Key | Required | Default | Description |
|---|---|---|---|
| `mabl_application` | Yes | | The ID of the mabl application. |
| `trigger_paths` | No | The whole repository | Patterns for the files whose change makes this application's checks apply to a pull request. See [Trigger path patterns](#trigger-path-patterns). |
| `analysis_roots` | No | The whole repository | Git pathspecs of the files that belong to this application, used to describe the change to the analysis. A pathspec can't contain `{` or `}`, or start with `:`. |
| `target` | No | None | Where the application's tests run. See [Targets](#targets). |
| `stages` | No | None | The application's stages, by stage name. See [Stages](#stages). |

To mean the whole repository, leave `trigger_paths` or `analysis_roots` out. An empty list is refused.

`trigger_paths` applies when the stage request lists the files the change touches, which this action sends.
A check for an application the change doesn't reach reads `not_applicable`.

### Trigger path patterns

`trigger_paths` patterns follow the rules of the `paths` filter in a GitHub Actions workflow, so the two can share
the same list:

- `*` matches any characters within one folder or file name.
- `**` matches any characters, across folders.
- `?` makes the character before it optional.
- A leading `!` takes back files an earlier pattern matched. The list needs at least one pattern without `!`.
- When several patterns match a file, the last one decides.
- The characters `[`, `]`, `{`, `}`, `+`, and `\` aren't supported.

For example, this application's checks apply to a pull request that changes any file under `apps/web`, except its
docs:

```yaml
trigger_paths:
  - 'apps/web/**'
  - '!apps/web/docs/**'
```

## Targets

A `target` can be set on an application and on any of its stages. A stage's `target` replaces the application's one
field at a time.

| Key | Type | Description |
|---|---|---|
| `url` | URL | The address tests run against. Without one, tests run at the environment's own URL, such as a shared QA or staging environment. |
| `api_url` | URL | The address API tests run against. Without one, API tests run at the environment's own API URL. It applies to every plan the stage runs. |
| `environment` | ID | The mabl environment the tests run in. A stage that runs any test must have one, and the application must have a URL in that environment. |
| `credentials` | ID | The mabl credentials tests log in with, unless `logins_from` gives a test its plan's credentials. |

A `url` or `api_url` must:

- Start with `https://` and name a host.
- Use only printable ASCII characters, with no spaces and none of these characters: `` ` `` `<` `>` `(` `)` `[`
  `]` `|` `\`. Percent-encode them instead.
- Carry no user name or password. Logins belong in `credentials`.
- Use `{sha7}` as its only placeholder. mabl replaces it with the first seven characters of the commit being
  tested, such as `https://pr-{sha7}.preview.example.com` for a preview deployment per commit.

`mabl policy resolve` doesn't check that a stage has an environment, but mabl refuses to run a stage without one.

## Stages

Each entry under an application's `stages` is a stage name with these settings. Stage names are your own: mabl
gives no name a special meaning, and runs a stage when your workflow asks for it by name, in the action's `stage`
input. A stage you leave out has no checks.

| Key | Type | Default | Description |
|---|---|---|---|
| `scope` | `pull_request` or `revision` | `pull_request` | What a run of the stage belongs to: one pull request (`pull_request`), or a deployed commit that can hold many pull requests, such as a merge deployed to staging or a release tag (`revision`). |
| `mabl_branch` | `match-pr` or `master` | `match-pr`, or `master` on a `revision` stage | The [mabl branch](https://help.mabl.com/hc/en-us/articles/17783159608468) tests run from. `match-pr` uses the pull request's mabl branch, or master when it has none. See [mabl branches](#mabl-branches). A `revision` stage has no pull request to match, so it must use `master`. |
| `target` | Target | None | Replaces the application's `target`, one field at a time. |
| `checks` | List of checks | None | What the stage runs. Each suite can appear once, and a stage takes at most one impacted check. See [Checks](#checks). |

Set `scope: revision` on any stage your workflow never asks for on a pull request, such as a stage that runs after
a merge deploys. A pull request's status waits on every `pull_request` stage in the policy, so a stage that's never
requested keeps the status pending. mabl doesn't run a `revision` stage for a pull request, and it isn't part of
any pull request's status.

Which workflow sends which scope:

| Scope | Sent by | Policy read at |
|---|---|---|
| `pull_request` | `pull_request` and `merge_group` events, and comment commands | The pull request's base commit, or the merge group's base commit |
| `revision` | `push`, `deployment_status`, `workflow_run`, `workflow_dispatch`, `release` and `schedule` events | The deployed commit itself, which must be merged |

### mabl branches

With `mabl_branch: match-pr`, mabl picks a stage's mabl branch once, when it accepts the stage request. It uses the
first of these that applies:

1. **The mabl branch the pull request names.** The action reads the name from the first `Mabl branch: <name>` line
   in the pull request's description, outside code blocks and HTML comments. If that branch is already merged into
   master, the tests run on master.
2. **An open mabl branch with the same name as the pull request's git branch.**
3. **master.**

If the branch the pull request names doesn't exist, was merged somewhere other than master, or isn't a branch you
can work on, mabl doesn't fall back to master. The stage's checks can't be judged, with the reason
`mabl_branch_not_open`, until you create the branch or fix the name and send the stage request again, with a new
commit or a `/mabl` comment. Editing the description alone sends nothing. The stage's status names the mabl branch
its tests ran on.

Use `match-pr` on the stages that gate a change too. A change that needs its tests updated can only pass when the
gate runs the updated tests, and those live on the branch until the pull request merges. A stage on the branch also
runs the tests the branch created or edited, as
[Tests on the pull request's mabl branch](#tests-on-the-pull-requests-mabl-branch) describes.

> **The pull request's description names the branch.** The next stage request, such as the merge queue entry, runs
> the branch the description names at that moment, and with `merge_mabl_branches` that branch merges into master.
> Review the branch's test changes along with the code. To run a stage on master whatever the description says,
> set `mabl_branch: master`.

## Checks

Each item in a stage's `checks` list is a check, of `kind: suite` or `kind: impacted`. Each check runs and reports
on its own. By default a check that fails is a warning. Set `must_pass: true` on the checks that should hold a
change back.

### Suite checks

| Key | Required | Default | Description |
|---|---|---|---|
| `kind` | Yes | | `suite`. |
| `suite` | Yes | | The name of a suite under `suites`. The check runs the suite's plans. |
| `must_pass` | No | `false` | Whether the change is blocked when the check fails. |
| `budget_minutes` | No | `30` | Minutes the check may take, from 10 to 120. |
| `waiver` | No | None | A mapping with one key, `label`: the pull request label that waives the check, as in `waiver: {label: skip-smoke}`. See [Waivers](#waivers). |

### Impacted checks

| Key | Required | Default | Description |
|---|---|---|---|
| `kind` | Yes | | `impacted`. |
| `must_pass` | No | `false` | Whether the change is blocked when the check fails. Can't be `true` when `run` is `false`. |
| `run` | No | `true` | Whether the impacted tests run. With `false`, the check reports the impacted tests without running them. |
| `retry_failed` | No | The value of `must_pass` | Whether a failed test runs once more. |
| `budget_minutes` | No | `50` | Minutes the check may take, from 30 to 120. |
| `when_nothing_ran` | No | `clear` | The outcome when the analysis succeeds and leaves no test to run. `clear`, the only value, counts the check as passed. |
| `waiver` | No | None | A mapping with one key, `label`: the pull request label that waives the check, as in `waiver: {label: skip-smoke}`. See [Waivers](#waivers). |
| `include`, `exclude`, `trusted`, `logins_from`, `others`, `run_mabl_branch_tests` | No | The top-level `impacted` rules | [Impacted test rules](#impacted-test-rules) for this check only. |

### How mabl counts a check

- **`must_pass`** decides whether a check can hold the change back. A check without it that fails, or that mabl
  can't judge, is listed as a warning. A stage with no `must_pass` check never blocks, and a workflow that waits on
  it gets `success` at once, even while its tests run.
- **Retries:** automatic retries count, and the check reads each test's final run. With `retry_failed`, a failed
  impacted test runs once more. A suite's plans retry as their own settings say. A rerun that someone starts by
  hand doesn't change the check. To recover from a flaky failure, push a new commit, queue the pull request again,
  or for a deployed commit, run the workflow again.
- **`budget_minutes`** runs from when mabl starts the check's tests. A check still running after its budget can't
  be judged, and its reason is `over_budget`. A check that must pass then fails the stage.
- **`when_nothing_ran: clear`** counts an impacted check as passed when the analysis succeeded and left no test to
  run, including when the rules left out every test it found. A `must_pass` impacted check can therefore pass with
  no test run. The check's status says how many tests the analysis found and why none ran. An analysis that failed never
  counts as a pass.
- **A stage mabl can't judge never passes:** the policy file is missing or invalid, doesn't define the stage, or
  gives the stage a `scope` that doesn't match the change.

### Waivers

```yaml
- kind: suite
  suite: smoke
  must_pass: true
  waiver:
    label: skip-smoke
```

A waiver takes one setting, `label`, which is required: a pull request label. When the pull request carries it,
spelled exactly the same, including case, the check is waived: it counts as passed, whatever its tests did.

A waiver counts only for the pull request that carries the label. In a merge queue, each entry is judged by its own
pull request's labels, so a label on one pull request doesn't waive a check for the pull requests queued ahead of
it. The merge queue must keep its default setting, **Require all queue entries to pass required checks**. With the
setting off, only the last entry in a group has to pass, and a waiver on that entry would let the whole group
through.

For a deployed commit, the action sends the labels of the pull request merged at that commit.
## Merge mabl branches when a pull request merges

When a pull request's tests live on a [mabl branch](#mabl-branches), the branch needs to reach master once the code
does. With `merge_mabl_branches: true`, mabl merges it for you when your workflow tells mabl the pull request
merged. See [examples/pull-request-merged.yml](../examples/pull-request-merged.yml).

```yaml
version: 1
merge_mabl_branches: true
```

- mabl reads the setting from the policy file at the merge commit.
- mabl merges the branch of the latest stage request that ran on the pull request's mabl branch, with
  `mabl_branch: match-pr`. A pull request whose tests ran on master has nothing to merge.
- The merge is fast-forward only. If master has moved past the branch for a test or flow it changed, mabl leaves
  the branch open and reports it as diverged, for someone to merge by hand. mabl never forces a merge.
- mabl merges as the API key that tells it the pull request merged. That key must be able to merge mabl branches:
  a **Command Line Interface** key made for this workflow, on an account with mabl branching. An **Editor** key can't, and gets
  `principal_too_narrow`.
- The pull request's status reports what happened to the branch: `merged`, `left` (the policy doesn't merge
  branches), `nothing_to_merge`, `diverged`, `not_open`, or `failed`. The action logs it on the merged pull
  request's run, and the pull request comment shows it. `diverged` and `failed` fail that run, so someone finishes
  the merge by hand. See [When a pull request merges](../README.md#when-a-pull-request-merges).

## Check a policy file

Before you commit a policy file, check it with the latest version of the mabl CLI
(`npm install -g @mablhq/mabl-cli`). From the repository root, run:

```sh
mabl policy resolve
```

The command reads `.mabl/policy.yaml`, or the file you pass with `--file`, and prints the result as JSON. It uses
the activated API key, or the key you pass with `--api-key`, which isn't saved.

- **Exit code 0:** the file is valid.
- **Exit code 1:** the file is invalid, or the command got no answer. An invalid file still prints its JSON, with
  the errors. When the command got no answer, for example because the file can't be read or the API key isn't
  valid, nothing is printed on standard output.

| Field | Description |
|---|---|
| `valid` | Whether the file is valid. |
| `errors` | Up to 100 errors, in file order. Each has a `path`, such as `applications.web.stages.merge_queue.checks[1].must_pass`, a `message`, and the `line` and `column` where the error is. |
| `policy` | The file with every default filled in. Only when the file is valid. |
| `stages` | The settings each application uses at each of its stages: the stage's target applied over the application's, its suite checks, its impacted check with the impacted test rules filled in, and the plan labels of the suites it uses. Only when the file is valid. |

For example, `must_pass: required` on a check prints:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "applications.web.stages.merge_queue.checks[1].must_pass",
      "message": "must be true or false, got \"required\"",
      "line": 35,
      "column": 13
    }
  ]
}
```

The command checks the file's shape and values. It doesn't check that the applications, environments, credentials
or plan labels the file names exist in your workspace, or the
[limits that apply when a stage runs](#limits-when-a-stage-runs).

To run the same check on every pull request that changes the file, and see which settings change, use the
[policy check](../policy/README.md).

### File rules

| Rule | Detail |
|---|---|
| Location | `.mabl/policy.yaml` in the repository, or the path in the action's `file` input. A change to the file applies once the pull request that makes it merges. Put the file, and the workflow files that call mabl, under CODEOWNERS, and turn on "Require review from Code Owners" in your branch rules, or CODEOWNERS enforces nothing. |
| Format | YAML 1.1, a single document. Aliases, `!` tags, and duplicate keys are refused. |
| Size | Up to 64 KiB. |
| Unknown keys | Refused anywhere in the file. The error lists the keys allowed at that point. |
| Quoting | Quote a string that YAML would otherwise read as a number or a boolean, such as an ID made only of digits, or `yes`, `no`, `on`, `off`, `true`, or `false`. |
| Placeholders | A value written entirely as `<...>` is refused as a placeholder that was never filled in. An unreplaced `[...]` value, as in the examples here, fails the rules for IDs below. |

### Names, IDs and labels

| Value | Rule | Used for |
|---|---|---|
| Name | A letter or digit, then letters, digits, `-`, and `_`, up to 64 characters | Suite names, application names, stage names |
| ID | Letters, digits, `-`, and `_`, 1 to 64 characters | `mabl_application`, `environment`, `credentials` |
| Label | 1 to 100 characters, with no space at either end and no line break, tab, or other hidden character. Plan and test labels are matched regardless of case. A waiver label must match the pull request's label exactly, including case. | Plan labels, test labels, waiver labels |

Inside one list of test labels, each label can appear only once.

## Limits when a stage runs

`mabl policy resolve` can't check these limits, because they depend on your workspace and the analysis. mabl
applies them when it runs a stage.

| Limit | What happens |
|---|---|
| 50 impacted tests per stage run | Tests past the 50th don't run: the analysis's tests in its order, then the mabl branch's. |
| 25 tests from a pull request's mabl branch per impacted check | The rest aren't taken. The report counts them. |
| 50 plans across a stage's suite checks | The stage doesn't run. |
| 200 plans carrying the plan labels a stage uses, in its suite checks, `include.suites`, and `logins_from` | The stage doesn't run. |
| An analysis more than 24 hours old | The stage doesn't run until the change is analyzed again. |
| 6 analyses for each pull request head and mabl branch, and 50 for each pull request | No more analyses start. After 50, none start until the pull request is [reset](https://api.help.mabl.com/reference/resetchangeagent). |
| 10 stages per pull request or deployed commit | A request for an eleventh stage is refused. |

## Learn more

- [The action's README](../README.md)
- [Change validation in the mabl API reference](https://api.help.mabl.com/reference/sendchangevalidationevent),
  for every status, reason and error code
