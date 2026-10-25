# Native agent re-review

Configure the reviewer **before merging the workflow change**. Every review now
requires `CODE_REVIEW_TOKEN`; there is deliberately no fallback that silently
posts as the unrequestable `github-actions[bot]` identity.

## Requestable identity

Use a dedicated GitHub **machine-user account**, not an App installation token.
The live GraphQL API cannot resolve `github-actions[bot]` as a `User`. Installing
a custom GitHub App does not make its bot a requestable reviewer either; see the
[GitHub App reviewer limitation](https://github.com/orgs/community/discussions/193037).
Copilot's special reviewer integration is not a replacement for this Codex workflow.
No GitHub App registration, webhook server, or App private key is required.

## Owner setup

1. Create or choose a dedicated machine-user account, distinct from the PR author.
   Enable 2FA. The owner must invite it at
   [repository collaborators](https://github.com/ibara1454/pi-coding-agent-config/settings/access);
   accept the invitation while signed in as that account. Keep its repository
   access limited to this repository. GitHub cannot approve an author's own PR.
2. As the machine user, open [Tokens (classic)](https://github.com/settings/tokens),
   generate an expiring token with **`public_repo` only**, and record its rotation
   date. This is a public, personal-account repository: fine-grained PATs currently
   [do not support repository collaborators](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).
   A classic token grants more than review access; do not reuse a human's token
   or give this account unrelated repository access.
3. As the repository owner, save that token as Actions secret `CODE_REVIEW_TOKEN`
   and the account's exact login (without `@`) as Actions variable
   `CODE_REVIEW_REVIEWER` in
   [Secrets and variables → Actions](https://github.com/ibara1454/pi-coding-agent-config/settings/secrets/actions).
   CLI equivalents, run from this repository with the owner's `gh` login:

   ```sh
   gh secret set CODE_REVIEW_TOKEN
   gh variable set CODE_REVIEW_REVIEWER --body 'YOUR-MACHINE-USER-LOGIN'
   ```

   Paste the token only at the secret prompt, never into chat, a command argument,
   or a tracked file. Do not put it in `GH_AW_GITHUB_TOKEN`, the engine environment,
   or GitHub tool configuration: those credentials can reach the agent.

## Prove the native button

1. Use a non-draft, same-repository PR targeting the configured base (`main` here),
   authored by someone other than the machine user. Let an ordinary PR trigger
   submit its first review as the configured account, or select that account in
   **Reviewers** to request the first review.
2. Record the PR head SHA, workflow run URL, and submitted review URL. Without
   pushing or rerunning CI, click **Re-request review** beside that account in the
   PR sidebar. [GitHub's native review instructions](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review)
   show the button. Old `github-actions[bot]` reviews do not acquire this capability.
3. Confirm a **new** Code review run for `pull_request` / `review_requested`, then a
   **new** review by the same account with `commit_id` equal to the unchanged PR
   head SHA. Check both the submitted review and run; a successful review-request
   API response alone is not proof. Requesting an unrelated reviewer may create a
   skipped workflow run, but must not execute the agent.

Draft, fork, and unauthorized-actor guards remain in force. Codex, provider/model
variables, the read-only agent/proxy credentials, and the APPROVE/REQUEST_CHANGES
safe-output policy are unchanged; there is no merge output. The compiler uses the
review token in trusted checkout/output/reporting steps, not the Codex execution
or CLI proxy. Do not merge until account setup and the live button check pass.

Regenerate and validate with the pinned compiler:

```sh
gh aw compile code-review --validate
```
