# 生成应用图标 build/icon.png（1024x1024，紫青渐变圆角 + 双八分音符）
Add-Type -AssemblyName System.Drawing

$S = 1024
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角方块
$r = 226
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
$path.AddArc($S - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$path.AddArc($S - $r * 2, $S - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc(0, $S - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()

# 对角渐变：紫 -> 青
$rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
$c1 = [System.Drawing.Color]::FromArgb(255, 124, 92, 255)
$c2 = [System.Drawing.Color]::FromArgb(255, 34, 211, 238)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
$g.FillPath($brush, $path)

# 边缘细描边
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(40, 255, 255, 255), 4)
$g.DrawPath($pen, $path)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))

# 符头
$hw = 210; $hh = 156
$st = $g.Save(); $g.TranslateTransform(340, 726); $g.RotateTransform(-22)
$g.FillEllipse($white, -$hw / 2, -$hh / 2, $hw, $hh); $g.Restore($st)
$st = $g.Save(); $g.TranslateTransform(672, 640); $g.RotateTransform(-22)
$g.FillEllipse($white, -$hw / 2, -$hh / 2, $hw, $hh); $g.Restore($st)

# 竖杆
$g.FillRectangle($white, 400, 286, 32, 420)
$g.FillRectangle($white, 732, 200, 32, 420)

# 连梁
$beam = New-Object System.Drawing.Drawing2D.GraphicsPath
$pts = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(400, 282),
  [System.Drawing.Point]::new(764, 196),
  [System.Drawing.Point]::new(764, 282),
  [System.Drawing.Point]::new(400, 368)
)
$beam.AddPolygon($pts)
$g.FillPath($white, $beam)

if (-not (Test-Path build)) { New-Item -ItemType Directory build | Out-Null }
$bmp.Save((Join-Path $PWD 'build\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("icon.png -> " + [math]::Round((Get-Item 'build\icon.png').Length / 1KB, 1) + " KB")