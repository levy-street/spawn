# Windows code signing for SPAWN D

**Status: done.** The identity described here was provisioned on 2026-08-28 and
is in use. This document is now two things — the record of what exists, and the
runbook for rebuilding it if the certificate rotates, the tenant changes, or
someone has to re-establish it from nothing. It is not a to-do list.

**Audience:** whoever holds Azure account access. You do not need to know
anything about SPAWN D's code.

**If you are Claude Code reading this on that person's machine:** work through
it in order, run the commands with them, and stop at anything that needs a
human decision (naming, region, spending). One warning that matters more than
usual: do not invent a fallback. If something fails, say so and stop. Never
substitute a self-signed certificate, a downloaded PFX, or a certificate from
an unrelated vendor. Nothing here produces a private key file, and any
instruction that seems to want one is a sign you have gone wrong.

## What SPAWN D needs

An Authenticode certificate that CI can sign with, without CI ever holding the
private key. Four Windows binaries are signed on every release: the daemon pair
(`spawnd.exe`, `spawn-worker.exe`) in `.github/workflows/prebuilt.yml`, and the
desktop app plus its NSIS installer in `.github/workflows/desktop.yml`. Each is
SHA-256 signed, RFC 3161 timestamped, checked against the exact expected
certificate subject, and verified with `signtool verify /pa /all /v`.

Unsigned Windows binaries are not merely untidy: SmartScreen treats an unsigned
installer from an unknown publisher as a threat, and the daemon installs a
service, so the warning is the loud kind.

## The route taken, and the one not taken

SPAWN D reuses **Dreamhome AI Limited's existing non-exportable RSA-HSM
certificate in Azure Key Vault**, driven by
[AzureSignTool](https://github.com/vcsjones/AzureSignTool) after a GitHub OIDC
login.

Microsoft Artifact Signing (formerly Azure Trusted Signing) was the earlier
plan and was dropped. It would have meant a new signing account, a new monthly
charge, and a portal-only identity validation that Microsoft performs out of
band on its own schedule — all to obtain a *second* certificate for a company
that already holds one that Windows already trusts. If you are re-provisioning
and someone suggests Artifact Signing, this is the argument against it; it is
not a rule, and it may be the right answer for a company with no certificate.

## What exists now

Every value below is an identifier, not a credential. They are safe to paste
into a ticket. The one secret involved — the private key — cannot be exported
from the HSM by anyone, including the account owner.

```text
Vault                kv-dreamhome-prod
Resource group       rg-dreamhome-codesign-prod
Certificate          dreamhomeai-code-signing
Key type             RSA-HSM, 4096-bit, non-exportable
EKU                  1.3.6.1.5.5.7.3.3 (code signing)
Thumbprint           982B6765F17F6EDF4395E96AE5ED6F89345AC101
Expires              2027-07-16
Subject              E=hello@levystreet.com, CN=Dreamhome AI Limited, O=Dreamhome AI Limited, L=Wellington, S=Wellington, C=NZ

Entra app            spawn-windows-signing
Client (app) ID      cb2a7373-57b7-4b84-98e2-8105dfe754fc
App object ID        712fb016-3b3b-4547-a376-890110dbff73
SP object ID         5a0822d1-d765-4e5b-8e9a-f550293d8a0a
Tenant ID            29b9b53f-1c82-4c3c-a886-93c0c7633770
Subscription ID      6a8b1eac-489e-4fc5-9e0d-85f13844501e

Federated issuer     https://token.actions.githubusercontent.com
Federated subject    repo:levy-street/spawn:environment:windows-code-signing
Federated audience   api://AzureADTokenExchange
```

The service principal holds exactly two data-plane assignments — `Key Vault
Certificate User` on the certificate and `Key Vault Crypto User` on its key —
and nothing else. No subscription, resource-group or vault-wide scope, and no
access to any other repository's signing. Keep it that way: the blast radius of
a compromised CI run is "can request signatures until the credential is
revoked", and widening the scope is what would turn that into something worse.

The same certificate signed the World of ClaudeCraft 0.40.1 Windows installers
on 2026-08-26, and Windows reported both signatures `Valid`.

## Rebuilding it from nothing

Only if the certificate rotates or the tenant changes. Resource names are the
ones in use; substitute your own if you are building a parallel setup.

### 1. The certificate

If a code-signing certificate already exists in a Key Vault the company
controls, use it — that is the whole point of this route. Otherwise create or
import one into Key Vault with a **non-exportable** RSA-HSM key and the code
signing EKU, from a CA whose roots Windows already trusts. A certificate whose
private key can be exported is a certificate that will eventually be copied
onto a laptop.

```bash
az keyvault certificate show \
  --vault-name kv-dreamhome-prod \
  --name dreamhomeai-code-signing \
  --query "{subject:policy.x509CertificateProperties.subject, exportable:policy.keyProperties.exportable, kty:policy.keyProperties.keyType, expires:attributes.expires}"
```

### 2. The federated identity

CI authenticates as a federated identity, so no stored secret works outside a
permitted run. The subject must name the GitHub environment, which is why both
Windows jobs declare `environment: windows-code-signing`.

```bash
app_id="$(az ad app create --display-name spawn-windows-signing --query appId -o tsv)"
az ad sp create --id "$app_id"
az ad app federated-credential create --id "$app_id" --parameters '{
  "name": "spawn-windows-code-signing",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:levy-street/spawn:environment:windows-code-signing",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

### 3. The two role assignments

Scope each to the individual object, never to the vault.

```bash
cert_id="$(az keyvault certificate show --vault-name kv-dreamhome-prod \
  --name dreamhomeai-code-signing --query id -o tsv)"
key_id="$(az keyvault key show --vault-name kv-dreamhome-prod \
  --name dreamhomeai-code-signing --query key.kid -o tsv)"

az role assignment create --assignee "$app_id" \
  --role "Key Vault Certificate User" --scope "$cert_id"
az role assignment create --assignee "$app_id" \
  --role "Key Vault Crypto User" --scope "$key_id"
```

### 4. The GitHub side

`master` carries no branch protection rule, so an environment restricted to
`protected_branches` matches nothing and blocks every Windows job. The
equivalent that actually works is a custom branch policy naming `master`.
Revisit the day `master` gains a protection rule.

```bash
gh api -X PUT repos/levy-street/spawn/environments/windows-code-signing --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X POST repos/levy-street/spawn/environments/windows-code-signing/deployment-branch-policies \
  -f name=master -f type=branch

env=(--env windows-code-signing -R levy-street/spawn)
gh secret   set AZURE_CLIENT_ID              "${env[@]}"   # the app registration's appId
gh secret   set AZURE_TENANT_ID              "${env[@]}"
gh secret   set AZURE_SUBSCRIPTION_ID        "${env[@]}"
gh variable set AZURE_KEY_VAULT_URL          "${env[@]}"   # https://kv-dreamhome-prod.vault.azure.net/
gh variable set AZURE_KEY_VAULT_CERTIFICATE  "${env[@]}"   # dreamhomeai-code-signing
gh variable set CODE_SIGN_TIMESTAMP_URL      "${env[@]}"   # http://timestamp.digicert.com
gh variable set WINDOWS_SIGNING_SUBJECT      "${env[@]}"   # the complete DN, copied from a real signature
```

The first three are secrets only to match the existing workflow convention;
none of them is a credential.

`WINDOWS_SIGNING_SUBJECT` is compared for **exact equality** by both workflows,
so take it from a signature rather than typing it: sign anything once, read
`(Get-AuthenticodeSignature <file>).SignerCertificate.Subject`, and store that
string verbatim. A subject that merely looks right will fail the release, which
is the intended behaviour.

## Proving it

The signing path cannot be exercised from a branch — the environment permits
only `master`, so a Windows job on any other ref never reaches `azure/login`.
The first run on `master` is the first real proof. Watch it rather than assume
it, and check the run signs, timestamps, matches the subject, and passes
`signtool verify /pa /all /v` for all four binaries.
