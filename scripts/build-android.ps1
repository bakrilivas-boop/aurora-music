#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (!$env:JAVA_HOME) {
    $java = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools\java') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$java) { throw 'Install JDK 21 and set JAVA_HOME, or place it in .tools\java.' }
    $env:JAVA_HOME = $java.FullName
}
if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $projectRoot '.tools\android-sdk' }
if (!(Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat'))) { throw 'Android SDK platform 36 and build-tools 36.0.0 are required.' }
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:GRADLE_USER_HOME = Join-Path $projectRoot '.tools\gradle'

& npm run sync:android
if ($LASTEXITCODE -ne 0) { throw 'Mobile web build failed.' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination 'android\app\src\main\assets\THIRD_PARTY_NOTICES.md'
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination 'android\app\src\main\assets\LICENSE.txt'
$localGradle = Join-Path $projectRoot '.tools\gradle-runtime\gradle-8.14.3\bin\gradle.bat'
if (Test-Path -LiteralPath $localGradle) { & $localGradle -p android assembleRelease lintRelease --no-daemon --max-workers=2 --console=plain }
else { & .\android\gradlew.bat -p android assembleRelease lintRelease --no-daemon --max-workers=2 --console=plain }
if ($LASTEXITCODE -ne 0) { throw 'Android compile or lint failed.' }

$privateDir = Join-Path $projectRoot '.private'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
$passwordPath = Join-Path $privateDir 'android-signing-password.txt'
$keystore = Join-Path $privateDir 'aurora-android.jks'
if (!(Test-Path -LiteralPath $passwordPath)) {
    if (Test-Path -LiteralPath $keystore) { throw 'Keystore exists but its password is missing.' }
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText($passwordPath, $password)
}
$env:AURORA_ANDROID_STORE_PASS = [IO.File]::ReadAllText($passwordPath).Trim()
try {
    if (!(Test-Path -LiteralPath $keystore)) {
        & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $keystore -alias aurora-android -storepass:env AURORA_ANDROID_STORE_PASS -keypass:env AURORA_ANDROID_STORE_PASS -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Aurora Music, O=Aurora Music' -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Release signing key creation failed.' }
    }
    $outputDir = Join-Path $projectRoot 'release\android\1.0.0'
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    $apk = Join-Path $outputDir 'Aurora-Music-Android-1.0.0.apk'
    $aligned = Join-Path $projectRoot 'android\app\build\outputs\apk\release\app-release-aligned.apk'
    $buildTools = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0'
    & "$buildTools\zipalign.exe" -f -p 4 android\app\build\outputs\apk\release\app-release-unsigned.apk $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    & "$buildTools\apksigner.bat" sign --ks $keystore --ks-key-alias aurora-android --ks-pass env:AURORA_ANDROID_STORE_PASS --key-pass env:AURORA_ANDROID_STORE_PASS --out $apk $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & "$buildTools\apksigner.bat" verify --verbose $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    & node scripts/verify-android.mjs $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK contents or manifest verification failed.' }
    $hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLower()
    [IO.File]::WriteAllText((Join-Path $outputDir 'SHA256.txt'), "$hash  Aurora-Music-Android-1.0.0.apk`n")
    Copy-Item -LiteralPath $apk -Destination (Join-Path $projectRoot 'Aurora Music-Android-1.0.0-安装包.apk')
    Write-Output "Android release: $apk"
    Write-Output "SHA256: $hash"
} finally { $env:AURORA_ANDROID_STORE_PASS = $null }
