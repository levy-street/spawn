# Installed outside the checkout on the persistent Windows release account.
$ErrorActionPreference = 'Stop'
$allowed = @(
    'levy-street/spawn/.github/workflows/prebuilt.yml@refs/heads/master',
    'levy-street/spawn/.github/workflows/desktop.yml@refs/heads/master'
)
if ($env:GITHUB_REPOSITORY -ne 'levy-street/spawn' -or
    $env:GITHUB_REF -ne 'refs/heads/master' -or
    $env:GITHUB_EVENT_NAME -notin @('push', 'workflow_dispatch') -or
    $env:GITHUB_WORKFLOW_REF -notin $allowed) {
    throw 'Release runner refuses an unapproved workflow/ref before checkout.'
}
