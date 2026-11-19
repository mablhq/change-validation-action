# mabl policy check

Checks `.mabl/policy.yaml` at a commit, and shows which settings change from another commit. Run it on the pull
requests that change the policy file, so a reviewer sees an error at its line and the effect of the change before
it merges.

For the settings themselves, see the [policy file reference](../docs/policy-file.md).

## Use the reusable workflow

[examples/policy-check.yml](../examples/policy-check.yml) runs the check on every pull request that touches
`.mabl/`. Copy it as it is.

It reads the file at the pull request's head, compares it with the pull request's base, and skips pull requests
from forks, which get no secrets. Its one input is `file`, the policy file's path.

## Use the action

```yaml
- uses: mablhq/change-validation-action/policy@v1
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    compare-ref: ${{ github.event.pull_request.base.sha }}
    mabl-api-key: ${{ secrets.MABL_API_KEY }}
```

| Input | Default | Description |
|---|---|---|
| `ref` | required | The full 40-character commit SHA to read the policy at |
| `compare-ref` | | The full 40-character commit SHA to compare with, such as the pull request's base. Empty compares nothing |
| `file` | `.mabl/policy.yaml` | The policy file's path |
| `repository` | the current repository | `owner/name` of the repository to read |
| `token` | `github.token` | Reads the repository's contents |
| `mabl-api-key` | required | A Command Line Interface or Editor key |

| Output | Description |
|---|---|
| `found` | `true` when the file exists at `ref`, `false` when it doesn't. Empty when it couldn't be read or resolved |
| `digest` | The SHA-256 of the resolved stages. Two commits with the same digest validate changes the same way. Empty unless the file is valid |
| `policy` | The file with every default filled in, as JSON. `{}` unless the file is valid |
| `stages` | The settings each application uses at each stage, as JSON. `{}` unless the file is valid |

The outputs come from a file a pull request's author may control. Read them through `env:`, never inside a `run:`
script.

## What it reports

mabl checks the file, so you don't install the mabl CLI. The action sends mabl the policy file's text at `ref`, and
at `compare-ref` when you set one, and nothing else from your repository.

| At `ref` | Result |
|---|---|
| A valid file | The step passes. The job summary gives the digest and what changed |
| An invalid file | The step fails, with one error annotation per error at its line and column |
| No file | The step passes with a notice, or a warning when `compare-ref` has a file, since removing the policy removes every check |
| A file that can't be read or checked | The step fails |

A `compare-ref` that can't be read, or holds an invalid file, only warns.

The job summary lists each setting that changes, by application and stage, after defaults are filled in. A pull
request that moves a setting without changing what a stage does shows no change.

The job summary looks like this:

> ### mabl policy
>
> `.mabl/policy.yaml` at `1a2b3c4` is valid (digest `9f8e7d6c5b4a`). Resolved settings changed from `5d6e7f8`:
>
> #### `web` `pull_request`
>
> | setting | before | after |
> | --- | --- | --- |
> | `impacted.exclude.median_minutes_over` | `10` | `20` |
