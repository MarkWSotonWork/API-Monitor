param(
  [string]$BaseUrl = "http://127.0.0.1:7934",
  [string]$AdminKey = "change-me",
  [string]$ApiKey = "demo-key",
  [string[]]$Paths = @("/"),
  [int]$Repeat = 1,
  [int]$TimeoutSeconds = 30,
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

function Invoke-SmokeRequest {
  param(
    [string]$Name,
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = $null
  )

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $parameters = @{
      Uri = $Url
      Method = $Method
      Headers = $Headers
      TimeoutSec = $TimeoutSeconds
      UseBasicParsing = $true
    }

    if ($null -ne $Body) {
      $parameters.Body = $Body
      $parameters.ContentType = "application/json"
    }

    $response = Invoke-WebRequest @parameters
    $timer.Stop()

    return [pscustomobject]@{
      Name = $Name
      Method = $Method
      Url = $Url
      Status = [int]$response.StatusCode
      Ms = $timer.ElapsedMilliseconds
      Bytes = $response.RawContentLength
      Ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
      Error = ""
    }
  } catch {
    $timer.Stop()
    $status = 0
    $bytes = 0

    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      if ($_.Exception.Response.ContentLength -gt 0) {
        $bytes = $_.Exception.Response.ContentLength
      }
    }

    return [pscustomobject]@{
      Name = $Name
      Method = $Method
      Url = $Url
      Status = $status
      Ms = $timer.ElapsedMilliseconds
      Bytes = $bytes
      Ok = $false
      Error = $_.Exception.Message
    }
  }
}

$base = $BaseUrl.TrimEnd("/")
$results = New-Object System.Collections.Generic.List[object]

Write-Host "Smoke testing $base"
Write-Host ""

$adminHeaders = @{ "x-admin-key" = $AdminKey }
$apiHeaders = @{ "x-api-key" = $ApiKey }

$results.Add((Invoke-SmokeRequest -Name "monitor health" -Method "GET" -Url "$base/_monitor/health" -Headers $adminHeaders))

for ($i = 1; $i -le $Repeat; $i++) {
  foreach ($path in $Paths) {
    $normalPath = if ($path.StartsWith("/")) { $path } else { "/$path" }
    $results.Add((Invoke-SmokeRequest -Name "api $i $normalPath" -Method "GET" -Url "$base$normalPath" -Headers $apiHeaders))
  }
}

$results.Add((Invoke-SmokeRequest -Name "monitor usage" -Method "GET" -Url "$base/_monitor/usage" -Headers $adminHeaders))

$results |
  Select-Object Name, Method, Status, Ms, Bytes, Ok, Error |
  Format-Table -AutoSize

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ""
Write-Host "Total calls: $($results.Count)"
Write-Host "Failures:    $($failed.Count)"

if ($OutFile) {
  $results | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding UTF8
  Write-Host "Saved results to $OutFile"
}

if ($failed.Count -gt 0) {
  exit 1
}
