# Issue Snapshot

An Angular 22 site showing the GitHub repository's open issues **as they were at the last deployment**. The published site is static: visitors do not need a GitHub account or token, and the page does not call the GitHub API.

## Deploy in any public repository

1. Put this project at the root of a public GitHub repository and push it to that repository's default branch.
2. In the repository, open **Settings → Pages** and choose **GitHub Actions** under **Build and deployment → Source**. The workflow is already in `.github/workflows/deploy.yml`; you do not need a Pages template.
3. Open **Actions → Deploy issue snapshot → Run workflow**, choose the default branch, and run it.
4. Wait for the deployment to finish. Open the site using the URL shown in the deployment or in **Settings → Pages**.
5. To refresh the list after opening or closing issues, run the same workflow again. Pushes to the default branch also refresh it automatically.

The first workflow run triggered by a push may fail if Pages has not been enabled yet. Run it manually after completing step 2. No personal access token, repository secret, code edit, or extra repository setting is required.

## How it works

The [deployment workflow](.github/workflows/deploy.yml) accepts pushes and manual runs. It compares the current branch with GitHub's `repository.default_branch`, so a repository with a default branch named something other than `main` works without editing the workflow.

During the build, [the snapshot generator](scripts/fetch-issues.mjs) gets the repository identity from `GITHUB_REPOSITORY` and uses the workflow's automatic `GITHUB_TOKEN` to query GitHub's GraphQL API. It requests up to 100 open issues at a time and follows `pageInfo.endCursor` until `hasNextPage` is false. It also paginates labels when one issue has more than 100. It checks counts, duplicate issues, and repeated cursors. If a count or duplicate check detects a change during pagination, it retries once instead of publishing an incomplete list. GitHub does not provide an atomic snapshot across multiple queries, so concurrent edits may not always be detectable.

The generator writes only repository name and URL, capture time, and each issue's number, title, URL, labels, author, and opening time to `public/issues.json`. Angular copies this file into the built site. [The app](src/app/app.ts) reads it relative to the page's base URL and requests it without browser caching, so a normal reload can show the latest deployment. It shows a clear empty state when the snapshot contains zero open issues. The checked-in `public/issues.json` is only a placeholder for local development; deployment replaces it with a real snapshot.

The workflow gets the site's base path from `actions/configure-pages`, then builds Angular with the matching `--base-href`. This works for a project site under a repository path or a site at the domain root, including after a repository transfer or rename. It uploads only `dist/site/browser` to Pages.

## Credentials and permissions

The build job has `contents: read` for checkout, `issues: read` for the GraphQL query, and `pages: read` for Pages configuration. The separate deployment job has only `pages: write` and `id-token: write`, which Pages deployment needs. Other `GITHUB_TOKEN` permissions are not granted.

The token is passed to the snapshot generator during the workflow. It is not supplied to the Angular build or browser code. The generator builds `issues.json` from an explicit list of public fields, and [the site check](scripts/verify-site.mjs) scans every published file for the exact workflow token before upload. The workflow stops if the token is found or if the generated snapshot or Pages base path is invalid.

## Run locally

Use the Node.js version in `.nvmrc`, then run:

```bash
npm ci
npm start
```

Open the local URL printed by Angular. The checked-in placeholder makes the local app display **Awaiting the first snapshot**; an Actions deployment generates the real snapshot in its build output, not in your local checkout. Local development does not require a token.

To run the automated checks:

```bash
npm run test:snapshot
npm run test:site
npm test -- --watch=false
```

The snapshot tests cover empty and multi-page issue lists, label pagination, changing results, and cursor failures. The site checks cover Pages paths, placeholder rejection, and token detection. Angular tests cover empty and populated views.

## Candidate note — personalize before submission

The assessment asks for a short note **in your own words**. This draft records what happened in this build; please rewrite it to reflect your own review before submitting:

> I used AI to help build the Angular page, GraphQL snapshot script, tests, and Pages workflow in stages. I asked specifically about pagination beyond 100 issues, keeping the token out of the site, the Pages path after a transfer, default branch names, and token permissions. The AI initially left the generated Angular README in place. I caught that by checking the assessment requirements and asking about the README before deployment. With more time, I would test the full transfer and deployment flow in a second public repository and check the finished page on several phone sizes.
