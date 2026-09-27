# Rasterize the existing favicon's timeline motif at standard installation sizes.
Add-Type -AssemblyName System.Drawing
$iconRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/icons'))
[System.IO.Directory]::CreateDirectory($iconRoot) | Out-Null
foreach ($asset in @(@{Name='icon-192.png';Size=192},@{Name='icon-512.png';Size=512},@{Name='icon-maskable-512.png';Size=512},@{Name='apple-touch-icon.png';Size=180})) {
  $size = $asset.Size
  $bitmap = [System.Drawing.Bitmap]::new($size,$size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#2f5d50'))
  $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#f4f1e9'),$size/16)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  foreach ($line in @(@(17,34,47,34),@(22,26,22,42),@(32,17,32,47),@(42,26,42,42))) {
    $graphics.DrawLine($pen,[single]($line[0]*$size/64),[single]($line[1]*$size/64),[single]($line[2]*$size/64),[single]($line[3]*$size/64))
  }
  $bitmap.Save((Join-Path $iconRoot $asset.Name),[System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose();$graphics.Dispose();$bitmap.Dispose()
}
