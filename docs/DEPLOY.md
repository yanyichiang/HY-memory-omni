# Deploy to your own Cloudflare account

This installs one isolated memory service in the caller's Cloudflare account. The account pays for Workers, Durable Objects, R2, and any model calls. The source repository does not host a shared service. Review the generated plan before activating resources. Source development and local tests do not grant deployment permission.

The gateway authenticates a fixed owner with `HY_API_TOKEN`. It binds the private store's `MemoryAPI`; the store owns a SQLite Durable Object and an R2 bucket. The private Python engine calls only the store's `MemoryReadAPI`. Neither the engine nor store has workers.dev or preview URLs. Callers cannot choose an owner or access `/read-store` through the gateway.

## Prepare

Use Node 22.22.0 or later, `npm ci`, and the existing `npm run setup` on the machine doing deployment. The Python project enables `[tool.pywrangler] allow-build = true`, matching setup's explicit build allowance for pinned pure-Python source distributions; this also covers Pywrangler's implicit sync during deploy/dev. `uv` must be available to its subprocesses; the deploy controller includes an absolute `UV` executable's directory in PATH. The project pins Wrangler `4.151.0` and uses `uv tool run --from workers-py==1.17.9 pywrangler`. Do not replace the Python deploy with plain `wrangler deploy`: Python dependencies require Pywrangler packaging. Set up your own Cloudflare account (including the Workers plan needed for Python Workers and SQLite Durable Objects), enable R2, and configure the account's workers.dev subdomain. The deploy does not change DNS, existing routes, another account, or an AI Gateway.

Run the normal initialization and edit the private local config using the README. Supply your own account ID, existing AI Gateway ID, model configuration and model credentials. `HY_API_TOKEN` protects this installation's public API. Keep it distinct from both the model token and the deployment token. `CLOUDFLARE_API_TOKEN` is used only by deployment, never stored in rendered configs or receipts. Load it from your secret manager or protected environment; do not put credentials in command arguments, terminal history or screenshots.

The deployment token needs access to Workers scripts (including service bindings, secrets and DO migrations), Durable Objects metadata, R2 bucket creation/read and native Resource Tagging read/write in this account. Model credentials require their own model/Gateway permissions. Account authentication and required product availability remain account-specific and must be checked on the target account.

## Plan without cloud writes

```sh
node scripts/cloud.mjs init --name my-memory --account YOUR_32_CHARACTER_ACCOUNT_ID --ownership personal
node scripts/cloud.mjs plan
node scripts/cloud.mjs render
```

`init` writes `HY_HOME/cloud/installation.json` (default `.hy-memory-omni/cloud`). It refuses to overwrite an installation. The unique name prefixes all three Workers and the R2 bucket; existing resources are never adopted. `plan` reads local installation metadata only. `render` reads the local app config and writes separate Wrangler JSON files with public configuration, never secret values. It does not provision resources or make model calls. Generated files contain machine-specific absolute source paths; render and deploy on the same checkout/machine.

Personal resources require the native key-only `Private` tag. For a company installation use `--ownership company --tags '{"project":"your-project","purpose":"company"}'`. Confirm ownership for the Worker, DO namespace and R2 bucket together. Tags do not provide billing or access isolation. For multiple installations use a separate `--directory PATH` on every cloud command, and separate app config/HY_HOME when the account or owner differs.

Before activation, inspect the plan and optionally validate packaging with the generated configs:

```sh
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config .hy-memory-omni/cloud/store.json
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config .hy-memory-omni/cloud/gateway-private.json
# From engine/ (use an absolute config path):
uv tool run --from workers-py==1.17.9 pywrangler deploy --dry-run --config /ABSOLUTE/PATH/TO/.hy-memory-omni/cloud/engine.json
```

Dry runs validate packaging; they do not establish target-account permissions, service-binding activation, resource tags or model behavior. They can prepare local build artifacts and Python packages. They must not be substituted for a real installation test.

## Activate and verify

After the installation owner has authorized resource creation, load the deployment token and run:

```sh
node scripts/cloud.mjs deploy
node scripts/cloud.mjs status
node scripts/cloud.mjs smoke --url https://my-memory-gateway.YOUR-SUBDOMAIN.workers.dev
```

The ordered deploy rejects resource name collisions, creates the private R2 bucket, bootstraps the engine without its return binding, installs its secrets, deploys the store and its model secret, then redeploys the engine with `MemoryReadAPI`. Next it deploys a private gateway and installs its bearer secret. All resource tags are merged with existing native tags and read back for the three Workers, DO namespace and bucket. The gateway's workers.dev URL is enabled only after those steps finish. Preview URLs remain disabled. No model request is sent by deployment.

Worker names are resolved to their immutable script IDs for native tags. The tag reader uses the exact-ID tagged-resource list, avoiding the beta's ambiguous `GET /tags` 500 for never-tagged resources. A successful empty list is accepted only for resources created by this installation. A failed list or tag readback stops activation. Script tags are not used as ownership evidence.

`smoke` sends three requests: unauthenticated `/revision` must return 401, authenticated `/read-store` must return 404, and authenticated `/revision` must return a positive integer revision. This proves the gateway → named `MemoryAPI` → Durable Object path and checks that the internal callback is blocked. It may initialize the owner's empty DO. It does not call models or validate the engine, media processing or R2 content path. Use normal explicitly authorized ingestion/search after smoke to validate those capabilities, accounting for model charges and actual data handling.

The deploy suppresses CLI subprocess output to prevent accidental secret disclosure; failure messages identify the step through `status`. For diagnosis use the Cloudflare Dashboard and metadata-only API/CLI inspection, keeping credentials and source/media content private.

## Interrupted or failed installation

`receipt.json` records a pending step before each external write and syncs it to disk. A completed step is skipped on the next deploy. A pending step stops subsequent deployment; it is never blindly repeated after a lost response. `deploy.lock` prevents concurrent deployment on this machine. A crash leaves the lock: confirm the old process and its children have stopped before manually removing it. Do not run this installation from two machines simultaneously.

Inspect the exact resource or deployment in Cloudflare, then reconcile the pending step using a short metadata-only evidence note:

```sh
node scripts/cloud.mjs reconcile --step r2 --outcome done --evidence 'Bucket exists with expected name and account; verified in dashboard'
# Use absent only after verifying that the entire step had no effect:
node scripts/cloud.mjs reconcile --step r2 --outcome absent --evidence 'Exact bucket does not exist; verified in dashboard'
node scripts/cloud.mjs deploy
```

`done` means every effect of the step was verified; `absent` authorizes that whole step to run again. Do not mark a partially completed tag/secret step absent. Reconcile `tags` as done only after all five resources' merged tags have been read back; otherwise finish and verify the missing tags manually before continuing. Reconcile Worker deploys using script/version/binding/route metadata, secrets by required secret names and the existing trusted credential source, and public activation by workers.dev/preview configuration. Secret values cannot be retrieved from Cloudflare. If preflight itself fails, no external write has been attempted and it can simply be retried after fixing the cause.

Keep the app configuration, credentials, checkout and installation metadata fixed throughout an installation. Public configuration is compared against the receipt on resume; secret values are deliberately not recorded. Changing credentials mid-install requires explicitly updating the appropriate cloud secrets and verifying their source before reconciliation. `deploy` is a first-install/resume tool, not a rolling upgrade command: a fully completed receipt is a no-op. This tooling performs no automatic rollback, deletion, migration from another memory service, or replay of uncertain business operations. A partial installation may retain paid resources; inspect the receipt and explicitly authorize cleanup separately.

## Evidence and references

The deployment controller's local tests use synthetic API/CLI adapters. The repository's real workerd/Python installation smoke and model tests have separate evidence. No cloud deployment, target-account permission check, real tag update or live-model acceptance is implied by these controller tests.

Official references used to implement this path:

- [Python package deployment with Pywrangler](https://developers.cloudflare.com/workers/languages/python/packages/)
- [Wrangler configuration, named service entrypoints and private URLs](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [R2 bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/)
- [Durable Object namespace metadata](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/)
- [Native Resource Tagging merge and readback](https://developers.cloudflare.com/resource-tagging/how-to/manage-tags/)
- [Tagged-resource lookup and cursor pagination](https://developers.cloudflare.com/api/resources/resource_tagging/methods/list/)
- [Resource types, including Workers, R2 and DO namespaces](https://developers.cloudflare.com/resource-tagging/reference/resource-types/)

### Packaging checks in this change

On 2026-10-24 the authorized home-machine checkout completed actual offline-credential dry runs using Wrangler 4.151.0 and workers-py 1.17.9 with synthetic account/model settings: Store, private/public Gateway, and bootstrap/final Python Engine. The final Python binding table contained `MEMORY_READ → store#MemoryReadAPI`; the gateway table contained `MEMORY → store#MemoryAPI`. No deployment credentials were loaded and no remote resources were provisioned. The first Python attempt exposed implicit-sync source-build refusal; enabling the existing intended build policy in pyproject.toml resolved it.
