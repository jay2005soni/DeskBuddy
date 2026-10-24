param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Email,
    [switch]$AllowLocalHttp,
    [switch]$TestEmails
)
$ErrorActionPreference = 'Stop'
$apiOrigin = [Uri]$BaseUrl
if ($apiOrigin.Scheme -ne 'https' -and -not ($AllowLocalHttp -and $apiOrigin.Scheme -eq 'http' -and $apiOrigin.Host -in @('localhost', '127.0.0.1'))) { throw 'Use staging HTTPS or explicitly allow local HTTP.' }
if ($apiOrigin.AbsolutePath -ne '/' -or $apiOrigin.Query -or $apiOrigin.Fragment -or $apiOrigin.UserInfo) { throw 'BaseUrl must be an origin without path/query/credentials.' }
$apiRoot = $BaseUrl.TrimEnd('/')
$accountToken = $null; $accountRefresh = $null; $plainPassword = $null
function Send-Api([string]$Method, [string]$Path, $Body = $null, [bool]$Authenticated = $true) {
    $headers = @{ Accept = 'application/json' }
    if ($Authenticated) { $headers.Authorization = "Bearer $script:accountToken" }
    $parameters = @{ Method = $Method; Uri = "$apiRoot$Path"; Headers = $headers; TimeoutSec = 20; MaximumRedirection = 0 }
    if ($null -ne $Body) { $parameters.ContentType = 'application/json'; $parameters.Body = ConvertTo-Json -InputObject $Body -Depth 12 -Compress }
    $reply = Invoke-RestMethod @parameters
    if ($null -eq $reply.data -or -not $reply.requestId) { throw "Invalid envelope: $Method $Path" }
    return $reply.data
}
function Assert-Rejected([string]$Method, [string]$Path, $Body, [int]$Status, [bool]$Authenticated = $true) {
    try { $null = Send-Api $Method $Path $Body $Authenticated }
    catch {
        if ($null -ne $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq $Status) { return }
        throw "Expected HTTP $Status for $Method $Path (different failure)."
    }
    throw "Expected HTTP $Status for $Method $Path, but it succeeded."
}
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
try {
    $securePassword = Read-Host 'Password for a NEW staging test account (8-128 characters)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    Assert-True ($plainPassword.Length -ge 8 -and $plainPassword.Length -le 128) 'Use an 8-128 character password.'
    $signup = Send-Api 'POST' '/v1/auth/signup' @{ displayName = 'API Test'; email = $Email; password = $plainPassword } $false
    Assert-True ($signup.expiresIn -is [int] -or $signup.expiresIn -is [long]) 'expiresIn must be an integer.'
    Assert-True (-not [string]::IsNullOrEmpty($signup.user.uid)) 'Signup must return user.uid.'
    $login = Send-Api 'POST' '/v1/auth/login' @{ email = $Email; password = $plainPassword } $false
    Assert-True ($login.user.uid -eq $signup.user.uid) 'Signup/login UID mismatch.'
    $accountToken = $login.accessToken; $accountRefresh = $login.refreshToken
    Assert-True (-not [string]::IsNullOrEmpty($accountToken) -and -not [string]::IsNullOrEmpty($accountRefresh)) 'Missing tokens.'
    Write-Output 'PASS signup/login envelopes'
    Assert-Rejected 'GET' '/v1/me' $null 401 $false
    Assert-Rejected 'PATCH' '/v1/me' @{ uid = 'another-user'; displayName = 'Forbidden' } 400
    $profile = Send-Api 'GET' '/v1/me'
    Assert-True ($profile.profile.uid -eq $signup.user.uid) 'GET profile UID mismatch.'
    $changed = Send-Api 'PATCH' '/v1/me' @{ displayName = 'API Contract Test'; timezone = 'Asia/Kolkata' }
    Assert-True ($changed.profile.displayName -eq 'API Contract Test') 'Profile update failed.'
    Write-Output 'PASS profile GET/PATCH and authorization/validation'
    $before = Send-Api 'GET' '/v1/me/preferences'
    $after = Send-Api 'PATCH' '/v1/me/preferences' @{ focusMinutes = 26 }
    Assert-True ($after.preferences.focusMinutes -eq 26 -and $after.preferences.breakMinutes -eq $before.preferences.breakMinutes) 'Preference merge failed.'
    Assert-Rejected 'PATCH' '/v1/me/preferences' @{ notificationForwardingEnabled = 1 } 400
    Assert-Rejected 'PATCH' '/v1/me/preferences' @{ focusMinutes = 91 } 400
    Write-Output 'PASS preferences merge/types/bounds'
    $deviceId = 'SMOKE-' + [Guid]::NewGuid().ToString('N')
    $deviceBody = @{ deviceId = $deviceId; label = 'API test unit'; firmware = '1.0.1-rc2'; settings = @{ audio = $false; volume = 30 } }
    $device = Send-Api 'PUT' '/v1/me/devices' $deviceBody
    $again = Send-Api 'PUT' '/v1/me/devices' $deviceBody
    Assert-True ($device.device.recordId -eq $again.device.recordId) 'Device upsert duplicated.'
    $list = Send-Api 'GET' '/v1/me/devices'
    Assert-True (@($list.devices | Where-Object { $_.deviceId -eq $deviceId }).Count -eq 1) 'Device missing/duplicated.'
    Assert-Rejected 'PUT' '/v1/me/devices' @{ deviceId = $deviceId; label = 'Bad'; firmware = '1'; settings = @{ audio = 1 } } 400
    Write-Output 'PASS device metadata only, upsert and validation'
    $eventId = [Guid]::NewGuid().ToString('N')
    $sessionBody = @{ clientEventId = $eventId; deviceId = $deviceId; kind = 'focus'; focusMinutes = 25; breakMinutes = 5; startedAt = [DateTime]::UtcNow.ToString('o') }
    $first = Send-Api 'POST' '/v1/me/sessions' $sessionBody
    $duplicate = Send-Api 'POST' '/v1/me/sessions' $sessionBody
    Assert-True ($first.session.id -eq $duplicate.session.id -and $first.session.state -eq 'start_accepted') 'History idempotency/state mismatch.'
    $sessionBody.focusMinutes = 24
    Assert-Rejected 'POST' '/v1/me/sessions' $sessionBody 409
    $history = Send-Api 'GET' '/v1/me/sessions?limit=20'
    Assert-True (@($history.sessions | Where-Object { $_.id -eq $eventId }).Count -eq 1) 'Session missing/duplicated.'
    Write-Output 'PASS accepted-start history and idempotency conflict'
    $refreshed = Send-Api 'POST' '/v1/auth/refresh' @{ refreshToken = $accountRefresh } $false
    $accountToken = $refreshed.accessToken; $accountRefresh = $refreshed.refreshToken
    $null = Send-Api 'GET' '/v1/me'
    Write-Output 'PASS token refresh and renewed access'
    if ($TestEmails) {
        $null = Send-Api 'POST' '/v1/auth/send-verification' @{}
        $null = Send-Api 'POST' '/v1/auth/forgot-password' @{ email = $Email } $false
        Write-Output 'PASS email request endpoints; check actual inbox delivery separately'
    }
    $null = Send-Api 'DELETE' "/v1/me/devices/$($device.device.recordId)"
    Write-Output 'Contract smoke test passed. Test account/session remain; remove them in staging after review.'
    Write-Output 'Two-user access, revocation and Firebase partial-failure tests are still required.'
} finally {
    $accountToken = $null; $accountRefresh = $null; $plainPassword = $null
    Remove-Variable signup,login,refreshed,securePassword -ErrorAction SilentlyContinue
}
