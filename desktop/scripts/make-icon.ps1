# App icon source generator (ASCII-only: Windows PowerShell 5.1 reads UTF-8-no-BOM as GBK)
Add-Type -AssemblyName System.Drawing
$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::Transparent)

$bg = [System.Drawing.Color]::FromArgb(255, 43, 58, 66)
$brush = New-Object System.Drawing.SolidBrush($bg)
$r = 180
$x = 64; $y = 64; $w = $size - 128; $h = $size - 128
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($x, $y, $r, $r, 180, 90)
$path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
$path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
$path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)

$ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 239, 227, 200))
$fam = New-Object System.Drawing.FontFamily('Microsoft YaHei')
$font = New-Object System.Drawing.Font($fam, 540, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'
$mo = [string][char]0x58A8
$rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$g.DrawString($mo, $font, $ink, $rect, $fmt)

$out = Join-Path $PSScriptRoot 'app-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "wrote $out"
