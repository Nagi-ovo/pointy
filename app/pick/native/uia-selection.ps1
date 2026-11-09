# 坐标都是物理像素，所以先把自己设成按显示器感知 DPI
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type 'using System; using System.Runtime.InteropServices; public static class DshPetDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }'
[DshPetDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
# 类型要在程序集加载之后按名字取；直接写 [System.Windows.Automation.X] 会在脚本解析时就报找不到
$AutomationElement = 'System.Windows.Automation.AutomationElement' -as [type]
$TextPattern = 'System.Windows.Automation.TextPattern' -as [type]
$ValuePattern = 'System.Windows.Automation.ValuePattern' -as [type]
$TreeWalker = 'System.Windows.Automation.TreeWalker' -as [type]
$MAX_TEXT = 4000

function Rect($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { return $null }
  return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

# 顶层窗口里点到的就是窗口本身（Windows Terminal 这类 XAML 宿主窗口常这样）：找它里面盖住这个点、带文字接口的控件
function TextChildAt($win, $x, $y) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AutomationElement::IsTextPatternAvailableProperty, $true)
  $best = $null
  $bestArea = [double]::MaxValue
  foreach ($e in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $r = $e.Current.BoundingRectangle
    if ($r.IsEmpty -or -not $r.Contains($x, $y)) { continue }
    $area = $r.Width * $r.Height
    if ($area -lt $bestArea) { $best = $e; $bestArea = $area }
  }
  return $best
}

function Chain($x, $y, $depth) {
  $el = $AutomationElement::FromPoint((New-Object System.Windows.Point $x, $y))
  if ($null -ne $el -and $el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and -not (Readable $el)) {
    $inner = TextChildAt $el $x $y
    if ($null -ne $inner) { $el = $inner }
  }
  $out = @()
  $walker = $TreeWalker::ControlViewWalker
  while ($null -ne $el -and $out.Count -lt $depth) {
    $out += $el
    $parent = $walker.GetParent($el)
    if ($null -eq $parent -or $parent -eq $AutomationElement::RootElement) { break }
    $el = $parent
  }
  return $out
}

function HasKids($el) { return $null -ne $TreeWalker::ControlViewWalker.GetFirstChild($el) }
function Readable($el) {
  $p = $null
  return $el.TryGetCurrentPattern($TextPattern::Pattern, [ref]$p) -or $el.TryGetCurrentPattern($ValuePattern::Pattern, [ref]$p)
}
function WindowRect($el) {
  $walker = $TreeWalker::ControlViewWalker
  $top = $el
  while ($true) {
    $parent = $walker.GetParent($top)
    if ($null -eq $parent -or $parent -eq $AutomationElement::RootElement) { break }
    $top = $parent
  }
  return Rect $top
}

function TextOf($el) {
  $p = $null
  if ($el.TryGetCurrentPattern($TextPattern::Pattern, [ref]$p)) {
    # 终端这类缓冲区很长的：整段从头取只会拿到很久以前的输出，改取屏幕上看得见的那部分
    $doc = $p.DocumentRange.GetText($MAX_TEXT + 1)
    if ($doc.Length -le $MAX_TEXT) { return $doc }
    $visible = ($p.GetVisibleRanges() | ForEach-Object { $_.GetText($MAX_TEXT) }) -join "`n"
    if ($visible.Trim()) { return $visible }
    return $doc.Substring(0, $MAX_TEXT)
  }
  # 链接的 Value 是网址，要的是链接上的字（网址另外放进 href）
  if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and $el.Current.Name) { return $el.Current.Name }
  if ($el.TryGetCurrentPattern($ValuePattern::Pattern, [ref]$p) -and $p.Current.Value) { return $p.Current.Value }
  $sb = New-Object System.Text.StringBuilder
  $walker = $TreeWalker::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push($el)
  $seen = 0
  while ($stack.Count -gt 0 -and $seen -lt 300 -and $sb.Length -lt $MAX_TEXT) {
    $n = $stack.Pop()
    $seen++
    $name = $n.Current.Name
    if ($name) { [void]$sb.AppendLine($name) }
    $kids = @()
    $c = $walker.GetFirstChild($n)
    while ($null -ne $c) { $kids += $c; $c = $walker.GetNextSibling($c) }
    for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push($kids[$i]) }
  }
  return $sb.ToString()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split '\s+'
  $result = @{ ok = $false }
  try {
    switch ($parts[0]) {
      'grab' {
        $el = $AutomationElement::FocusedElement
        if ($null -ne $el) {
          $result.isPassword = $el.Current.IsPassword
          $result.control = $el.Current.ControlType.ProgrammaticName
          $pattern = $null
          if (-not $result.isPassword -and $el.TryGetCurrentPattern($TextPattern::Pattern, [ref]$pattern)) {
            $ranges = $pattern.GetSelection()
            $result.ok = $true
            $result.text = ($ranges | ForEach-Object { $_.GetText(20000) }) -join "`n"
          }
        }
      }
      'point' {
        $chain = @(Chain ([double]$parts[1]) ([double]$parts[2]) 8)
        $result.chain = @($chain | ForEach-Object {
          @{ rect = (Rect $_); control = $_.Current.ControlType.ProgrammaticName; cls = $_.Current.ClassName; name = ($_.Current.Name -replace '\s+', ' ').Substring(0, [Math]::Min(60, ($_.Current.Name -replace '\s+', ' ').Length)) }
        })
        if ($chain.Count) {
          $result.leafKids = HasKids $chain[0]
          $result.leafReadable = Readable $chain[0]
          $result.win = WindowRect $chain[0]
        }
        $result.ok = $true
      }
      'element' {
        $chain = @(Chain ([double]$parts[1]) ([double]$parts[2]) 8)
        $el = $chain[[Math]::Min([int]$parts[3], $chain.Count - 1)]
        $result.isPassword = $el.Current.IsPassword
        if (-not $result.isPassword) {
          $result.name = $el.Current.Name
          $result.control = $el.Current.ControlType.ProgrammaticName
          $result.className = $el.Current.ClassName
          $result.rect = Rect $el
          $result.kids = HasKids $el
          $result.readable = Readable $el
          $result.win = WindowRect $el
          $result.text = (TextOf $el).Trim()
          $vp = $null
          if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and $el.TryGetCurrentPattern($ValuePattern::Pattern, [ref]$vp) -and $vp.Current.Value -match '^https?://') { $result.href = $vp.Current.Value }
          if ($result.text.Length -gt $MAX_TEXT) { $result.text = $result.text.Substring(0, $MAX_TEXT) }
          $result.ok = $true
        }
      }
    }
  } catch {
    $result.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
