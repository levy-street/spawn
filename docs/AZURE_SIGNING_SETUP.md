# Setting up Windows code signing for SPAWN D

**Audience:** whoever holds Azure account access. You do not need to know
anything about SPAWN D, and you will not touch its code. Everything here
happens in an Azure subscription plus one Entra ID app registration.

**If you are Claude Code reading this on that person's machine:** work through
it in order, run the commands with them, and stop at anything that needs a
human decision (naming, region, spending, the portal step). Two warnings that
matter more than usual here. First, this service was renamed from **Azure
Trusted Signing** to **Microsoft Artifact Signing**, and the rename has not
reached every identifier at the same pace — the CLI extension, the resource
provider and the RBAC role may each still use either name. Resolve every one of
those from live `az` output rather than from this document or from memory, and
check Microsoft Learn when output disagrees with what is written here. Second,
do not invent a fallback: if something fails, say so and stop. Never substitute
a self-signed certificate, a downloaded PFX, or a certificate from an unrelated
vendor. There is no scenario in which this setup produces a private key file.

## What this is for

SPAWN D ships a Windows daemon and a desktop installer. Windows has no
equivalent of Apple notarization; the publisher proof is Authenticode. Our CI
signs four Windows binaries — `spawnd.exe`, `spawn-worker.exe`, the desktop
`spawn-desktop.exe` and the NSIS setup EXE — and RFC 3161 timestamps each one.

The signing key lives in Microsoft's HSM and never leaves it. GitHub Actions
authenticates to Azure with short-lived OIDC tokens, so **no credential, key or
certificate is ever stored in GitHub, in the repo, or on anyone's laptop.** What
you hand back at the end is a set of identifiers, not secrets.

## Before you start

You need, in the Azure tenant:

- An Azure subscription you can create resources in, with billing attached.
- Rights to register a resource provider on that subscription.
- Rights to create an **Entra ID app registration** and add a **federated
  credential** to it. This is frequently restricted by tenant policy — check it
  early, because if you cannot do it, an admin has to, and that is a scheduling
  problem, not a technical one.
- Rights to create a **role assignment** (Owner, or User Access Administrator).
- Portal access, for the identity validation step, which has no CLI.

You also need the **exact legal entity details** for the business that will
appear as the publisher on every Windows install prompt — registered legal
name, address, and whatever registration or incorporation number applies. This
must match public records; it is verified by a human at Microsoft.

Local tooling: the Azure CLI (`az`), signed in with `az login`.

## The long pole: identity validation

Do this first and do everything else while it is pending.

Microsoft verifies out of band that you are the organization you claim to be.
It is portal-only, it takes days to weeks, and **the certificate profile cannot
be created until it reports `Completed`.** Nothing else in this document is
slow. This step alone decides when SPAWN D can launch on Windows.

There has historically been a business-history requirement on organization
validation — a legal entity younger than about three years could not use the
standard path and needed an alternative. Confirm the current rule before
promising a date, and if the entity is young, find out immediately what the
alternative requires, because that answer changes the schedule.

## Step 1 — Prepare the subscription

```bash
az login
az account set --subscription "<subscription-id>"
az account show --output table

# The resource provider. If this name errors, list providers and find the
# current one rather than guessing.
az provider register --namespace Microsoft.CodeSigning
az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv

# The CLI extension. If `trustedsigning` is not found, search for the
# artifact-signing equivalent instead.
az extension add --name trustedsigning
az extension list --query "[].name" -o tsv
```

Wait for the provider to report `Registered` before continuing.

## Step 2 — Create the signing account

Pick a region from the ones the service actually supports — list them rather
than assuming, since the supported set is smaller than Azure's full region
list. **Whatever region you choose determines the signing endpoint URL**, which
is one of the values you hand back, so write it down now.

```bash
az group create -n spawn-signing -l <region>

az trustedsigning create \
  -g spawn-signing \
  -n spawn-signing-account \
  -l <region> \
  --sku Basic

az trustedsigning show -g spawn-signing -n spawn-signing-account -o json
```

`Basic` is the right tier for our volume — we sign a handful of binaries per
release, not per commit. Note the account's endpoint URI from the `show`
output; it looks like `https://<region>.codesigning.azure.net/`.

## Step 3 — Identity validation (portal)

In the Azure portal, open the signing account, find **Identity validation**,
and create a new one for the legal entity. Supply the details exactly as they
appear in public records. Submit, then wait.

You can continue with steps 4 and 5 only after it reports `Completed`. Note the
**identity validation ID** — step 4 needs it.

## Step 4 — Create the certificate profile

```bash
az trustedsigning certificate-profile create \
  -g spawn-signing \
  --account-name spawn-signing-account \
  -n spawn-desktop \
  --profile-type PublicTrust \
  --identity-validation-id "<validation-id>"
```

`PublicTrust` is what chains to the Microsoft root that ordinary Windows
machines already trust — that is the whole point. Do not use a private-trust or
test profile; they will validate in CI and fail on users' machines.

## Step 5 — The identity GitHub will use

GitHub authenticates as a federated identity. The `subject` below must match
**exactly** — it names our repository and the GitHub environment the signing
jobs run in, and a mismatch is the single most common reason this setup fails
on first use.

```bash
app_id="$(az ad app create --display-name spawn-windows-signing --query appId -o tsv)"
echo "$app_id"

az ad sp create --id "$app_id"

az ad app federated-credential create --id "$app_id" --parameters '{
  "name": "spawn-windows-code-signing",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:levy-street/spawn:environment:windows-code-signing",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Then grant that identity the **one** permission it needs — the ability to
request signatures from that one certificate profile, and nothing else. Resolve
the role name from live output; do not type it from memory:

```bash
az role definition list \
  --query "[?contains(roleName, 'Certificate Profile Signer')].roleName" -o tsv
```

Use whichever name that returns:

```bash
profile_id="$(az trustedsigning certificate-profile show \
  -g spawn-signing --account-name spawn-signing-account -n spawn-desktop \
  --query id -o tsv)"

az role assignment create \
  --assignee "$app_id" \
  --role "<the role name resolved above>" \
  --scope "$profile_id"

az role assignment list --scope "$profile_id" -o table
```

Scope it to the profile, never to the resource group or subscription.

## Step 6 — Hand these seven values back

```bash
echo "AZURE_CLIENT_ID=$app_id"
echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
echo "AZURE_ARTIFACT_SIGNING_ENDPOINT=https://<region>.codesigning.azure.net/"
echo "AZURE_ARTIFACT_SIGNING_ACCOUNT=spawn-signing-account"
echo "AZURE_ARTIFACT_SIGNING_PROFILE=spawn-desktop"
```

The seventh is `WINDOWS_SIGNING_SUBJECT`: the **complete** distinguished name of
the certificate, which both our workflows compare for exact equality. Do not
type it out — a single character of difference fails every release. Get it from
a real signature. If you have a Windows machine, sign any throwaway file
through the profile and read it back:

```powershell
(Get-AuthenticodeSignature .\anything.exe).SignerCertificate.Subject
```

If you do not, say so and hand back the other six: our first CI run will print
the actual subject in its failure message, and we will set it from that.

**None of these seven values is a secret.** They are identifiers. Only a
GitHub Actions run in our repository, in the `windows-code-signing`
environment, can exchange them for anything, and only for signatures from that
one profile. Send them over any normal channel.

## Step 7 — The GitHub side (needs repo admin on `levy-street/spawn`)

Whoever holds repo admin runs this. The branch policy matters: `master` has no
branch protection rule, so an environment restricted to `protected_branches`
would match nothing and block every Windows job.

```bash
gh api -X PUT repos/levy-street/spawn/environments/windows-code-signing --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON

gh api -X POST \
  repos/levy-street/spawn/environments/windows-code-signing/deployment-branch-policies \
  -f name=master -f type=branch

env=(--env windows-code-signing -R levy-street/spawn)
gh secret   set AZURE_CLIENT_ID                  "${env[@]}"
gh secret   set AZURE_TENANT_ID                  "${env[@]}"
gh secret   set AZURE_SUBSCRIPTION_ID            "${env[@]}"
gh variable set AZURE_ARTIFACT_SIGNING_ENDPOINT  "${env[@]}"
gh variable set AZURE_ARTIFACT_SIGNING_ACCOUNT   "${env[@]}"
gh variable set AZURE_ARTIFACT_SIGNING_PROFILE   "${env[@]}"
gh variable set WINDOWS_SIGNING_SUBJECT          "${env[@]}"
```

## Proving it works

`.github/workflows/desktop.yml` must be on `master` first — `workflow_dispatch`
only lists workflows that exist on the default branch. Then dispatch it and
watch the Windows job. It signs the inner executable, verifies the signature is
`Valid`, carries an RFC 3161 timestamp and matches `WINDOWS_SIGNING_SUBJECT`
exactly, bundles that signed binary into the installer, signs the installer,
and re-verifies both with `signtool verify /pa /all /v`. Every one of those is a
hard failure, so a green run is real evidence.

Expect the subject comparison to be what fails first. That is the intended
behaviour, and its error message prints the actual subject — paste that into
the variable and re-run.

## Things that will trip you up

- **The rename.** Trusted Signing and Artifact Signing are the same service.
  Extension, provider and role names may use either. Resolve each from live
  output.
- **App registration rights.** Often restricted by tenant policy. Check on day
  one, not on the day you need it.
- **The federated subject string.** `repo:levy-street/spawn:environment:windows-code-signing`,
  exactly. Not the branch form, not a different environment name.
- **Region.** Determines the endpoint URL. Changing it later means a new
  account, a new profile, and re-running identity validation.
- **Certificate lifetime.** Artifact Signing issues very short-lived
  certificates and relies on timestamping for signatures to stay valid after
  expiry. This is normal and needs no renewal process — but it does mean the
  RFC 3161 timestamp is not optional, which is why our workflows fail without
  one.
- **SmartScreen reputation is separate from signing.** A correctly signed
  installer from a new publisher still shows warnings until download reputation
  accrues. Signing starts that clock; it does not skip it.

## What this deliberately does not do

No PFX or PVK file. No certificate download. No private key on any laptop, in
any repo, or in any CI secret. No long-lived Azure client secret — the
federated credential replaces it, which is why there is no password anywhere in
this document.

If a vendor, a tutorial, or an error message suggests producing a `.pfx` and a
password, that is a different signing model than ours and our workflows cannot
consume it. Stop and ask before going down that path.
