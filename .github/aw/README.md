# Agent reviewer setup

Configure these before merging: **missing `CODE_REVIEW_TOKEN` blocks all reviews**.

1. Use a dedicated machine-user account, not a GitHub App bot or the PR author.
   Enable 2FA, invite it as a repository collaborator, and accept the invitation.
2. As that account, create an expiring classic PAT with **`public_repo`** scope.
   Fine-grained PATs currently [do not support repository collaborators](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).
   This token is not review-only: keep the account's access limited to this
   repository and rotate the token before expiry.
3. As the repository owner, set the Actions secret and variable:

   ```sh
   gh secret set CODE_REVIEW_TOKEN
   gh variable set CODE_REVIEW_REVIEWER --body 'YOUR-MACHINE-USER-LOGIN'
   ```

   Paste the token at the secret prompt; use its owner's login without `@`.
   Never put this write token in `GH_AW_GITHUB_TOKEN` or the agent environment.

After the account submits its first review, use **Reviewers → Re-request review**
on the PR. Before merging this integration, confirm that clicking it produces a
new workflow run and a new review without changing the PR head SHA.

Identity investigation and verification evidence: [#63](https://github.com/ibara1454/pi-coding-agent-config/issues/63).
