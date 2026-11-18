# Security policy

## Reporting a vulnerability

If you find a security vulnerability in this action or in mabl, please report it privately. **Do not** open a
public GitHub issue for security matters.

- Email: <security@mabl.com>

Please include enough detail to reproduce the issue and its impact. We will acknowledge your report and keep you
updated as we investigate.

## Handling of credentials

The action sends your mabl API key only to `https://api.mabl.com`, never follows a redirect from it, and masks
the key and the GitHub token in everything it prints. Store the key as an encrypted secret and pass it with
`secrets.`, never in a workflow file. If you think a key was exposed, delete it in mabl and create a new one.
