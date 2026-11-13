# Live Sight overlay: an always-on-top card that shows the conversation while the agent watches.
# Talks to the plugin through JSON lines: commands arrive on stdin, user actions leave on stdout.
#   in : {type:"state",status,detail} {type:"say",role,text} {type:"busy",value} {type:"close"}
#   out: {type:"ready"} {type:"send",text} {type:"pause"} {type:"resume"} {type:"stop"} {type:"closed"}
param(
  [string]$StatePath = '',
  [string]$Title = 'Live Sight',
  # Without this switch the card is left out of every screen capture (the agent's own view included),
  # so the agent never reads its own words back as part of the screen.
  [switch]$Capturable
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False"
        ResizeMode="CanResizeWithGrip" Width="380" Height="460" MinWidth="280" MinHeight="56"
        FontFamily="Microsoft JhengHei UI, Segoe UI" TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <Style x:Key="Icon" TargetType="Button">
      <Setter Property="Foreground" Value="#A7AFBC"/>
      <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Width" Value="30"/>
      <Setter Property="Height" Value="28"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Bg" CornerRadius="8" Background="Transparent">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bg" Property="Background" Value="#1FFFFFFF"/>
                <Setter Property="Foreground" Value="#F2F4F7"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- Thin scroll bars that belong on a dark card: no arrows, a rounded thumb that brightens on hover. -->
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="6"/>
      <Setter Property="MinWidth" Value="6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Track x:Name="PART_Track" IsDirectionReversed="True">
              <Track.Thumb>
                <Thumb>
                  <Thumb.Template>
                    <ControlTemplate TargetType="Thumb">
                      <Border x:Name="T" CornerRadius="3" Background="#33FFFFFF"/>
                      <ControlTemplate.Triggers>
                        <Trigger Property="IsMouseOver" Value="True">
                          <Setter TargetName="T" Property="Background" Value="#66FFFFFF"/>
                        </Trigger>
                      </ControlTemplate.Triggers>
                    </ControlTemplate>
                  </Thumb.Template>
                </Thumb>
              </Track.Thumb>
            </Track>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Card" CornerRadius="16" Background="#FA121419" BorderBrush="#26FFFFFF" BorderThickness="1" Margin="10">
    <Border.Effect>
      <DropShadowEffect BlurRadius="22" ShadowDepth="0" Opacity="0.5" Color="#000000"/>
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="44"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Grid x:Name="Header" Grid.Row="0" Background="Transparent" Margin="14,0,8,0">
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,100,0">
          <Ellipse x:Name="Dot" Width="8" Height="8" Fill="#3DDC97" Margin="0,1,10,0"/>
          <TextBlock x:Name="TitleText" Foreground="#F2F4F7" FontSize="14" FontWeight="SemiBold"/>
          <TextBlock x:Name="Detail" Foreground="#8B93A1" FontSize="12" Margin="10,2,0,0" TextTrimming="CharacterEllipsis"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <Button x:Name="PauseBtn" Style="{StaticResource Icon}" Content="&#xE769;" ToolTip="暫停觀看"/>
          <Button x:Name="CollapseBtn" Style="{StaticResource Icon}" Content="&#xE921;" ToolTip="收合"/>
          <Button x:Name="CloseBtn" Style="{StaticResource Icon}" Content="&#xE8BB;" ToolTip="停止陪伴"/>
        </StackPanel>
      </Grid>
      <ScrollViewer x:Name="Scroll" Grid.Row="1" VerticalScrollBarVisibility="Auto" Margin="10,2,6,0">
        <StackPanel x:Name="Messages" Margin="0,0,4,4"/>
      </ScrollViewer>
      <TextBlock x:Name="Thinking" Grid.Row="2" Text="思考中…" Foreground="#8B93A1" FontSize="12"
                 HorizontalAlignment="Left" Margin="18,4,0,0" Visibility="Collapsed"/>
      <Border x:Name="InputBox" Grid.Row="3" Margin="12,6,12,12" CornerRadius="12" Background="#1AFFFFFF">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBox x:Name="Input" Background="Transparent" BorderThickness="0" Foreground="#F2F4F7" CaretBrush="#F2F4F7"
                   FontSize="13.5" Padding="10,8" AcceptsReturn="True" TextWrapping="Wrap" MaxHeight="96"
                   VerticalScrollBarVisibility="Auto"/>
          <TextBlock x:Name="Hint" Text="說點什麼…（Enter 送出，Shift+Enter 換行）" Foreground="#5F6774" FontSize="13"
                     Margin="13,9,0,0" IsHitTestVisible="False" TextTrimming="CharacterEllipsis"/>
          <Button x:Name="SendBtn" Grid.Column="1" Style="{StaticResource Icon}" Content="&#xE724;" ToolTip="送出"
                  VerticalAlignment="Bottom" Margin="0,0,4,4"/>
        </Grid>
      </Border>
    </Grid>
  </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
$ui = @{}
foreach ($name in 'Card', 'Header', 'Dot', 'TitleText', 'Detail', 'PauseBtn', 'CollapseBtn', 'CloseBtn', 'SendBtn', 'Scroll', 'Messages', 'Thinking', 'InputBox', 'Input', 'Hint') {
  $ui[$name] = $window.FindName($name)
}
$ui.TitleText.Text = $Title

Add-Type -Namespace LiveSight -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
'@
$script:hwnd = [IntPtr]::Zero
$window.Add_SourceInitialized({
  $script:hwnd = [Windows.Interop.WindowInteropHelper]::new($window).Handle
  # WDA_EXCLUDEFROMCAPTURE (Windows 10 2004 and later); older systems keep the card visible to captures.
  if (-not $Capturable) { [void][LiveSight.Native]::SetWindowDisplayAffinity($script:hwnd, 0x11) }
})

function Brush([string]$hex) { [Windows.Media.BrushConverter]::new().ConvertFromString($hex) }

function Emit($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# ---- geometry: remember where the card was left ----
$state = @{ status = 'watching'; collapsed = $false; expandedHeight = 460; paused = $false }
function Save-Geometry {
  if (-not $StatePath) { return }
  $data = @{ left = $window.Left; top = $window.Top; width = $window.Width; height = $state.expandedHeight; collapsed = $state.collapsed }
  try {
    $dir = Split-Path -Parent $StatePath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($StatePath, ($data | ConvertTo-Json -Compress), $utf8)
  } catch {}
}
$saved = $null
if ($StatePath -and (Test-Path $StatePath)) { try { $saved = Get-Content -Raw -Encoding UTF8 $StatePath | ConvertFrom-Json } catch {} }
$area = [Windows.SystemParameters]::WorkArea
if ($saved -and $saved.width -gt 0) {
  $window.Width = [Math]::Max($window.MinWidth, $saved.width)
  $state.expandedHeight = [Math]::Max(160, $saved.height)
  $window.Height = $state.expandedHeight
  $window.Left = [Math]::Min([Math]::Max($area.Left, $saved.left), $area.Right - 120)
  $window.Top = [Math]::Min([Math]::Max($area.Top, $saved.top), $area.Bottom - 60)
} else {
  $window.Left = $area.Right - $window.Width - 16
  $window.Top = $area.Bottom - $window.Height - 16
}

# ---- messages ----
$lastAssistant = ''
# Replies are written in Markdown; the card shows **bold** as bold and drops the markers of headings.
function Set-RichText($label, [string]$text) {
  $text = [regex]::Replace($text, '(?m)^\s{0,3}#{1,6}\s+', '')
  $parts = $text -split '\*\*'
  if ($parts.Count -lt 3) { $label.Text = $text; return }
  for ($i = 0; $i -lt $parts.Count; $i++) {
    $part = $parts[$i]
    # An unmatched trailing ** leaves an even count of parts: show it as written.
    $unmatched = $i % 2 -eq 1 -and $i -eq $parts.Count - 1
    if ($unmatched) { $part = '**' + $part }
    if (-not $part) { continue }
    $run = [Windows.Documents.Run]::new($part)
    if ($i % 2 -eq 1 -and -not $unmatched) { $run.FontWeight = 'SemiBold' }
    $label.Inlines.Add($run)
  }
}

function Plain([string]$text) { ($text -replace '\*\*', '' -replace '(?m)^\s{0,3}#{1,6}\s+', '') -replace '\s+', ' ' }

function Add-Message([string]$role, [string]$text) {
  $bubble = [Windows.Controls.Border]::new()
  $bubble.CornerRadius = [Windows.CornerRadius]::new(12)
  $bubble.Padding = [Windows.Thickness]::new(11, 7, 11, 8)
  $bubble.Margin = [Windows.Thickness]::new(0, 6, 0, 0)
  $bubble.MaxWidth = [Math]::Max(180, ($window.ActualWidth - 20) * 0.84)
  $label = [Windows.Controls.TextBlock]::new()
  Set-RichText $label $text
  $label.TextWrapping = 'Wrap'
  $label.FontSize = 13.5
  $label.LineHeight = 20
  switch ($role) {
    'user' {
      $bubble.HorizontalAlignment = 'Right'
      $bubble.Background = Brush '#593D7BFF'
      $label.Foreground = Brush '#F5F7FF'
    }
    'system' {
      $bubble.HorizontalAlignment = 'Center'
      $bubble.Background = Brush '#00000000'
      $label.Foreground = Brush '#6F7785'
      $label.FontSize = 12
    }
    default {
      $bubble.HorizontalAlignment = 'Left'
      $bubble.Background = Brush '#24FFFFFF'
      $label.Foreground = Brush '#F2F4F7'
      $script:lastAssistant = $text
    }
  }
  $bubble.Child = $label
  [void]$ui.Messages.Children.Add($bubble)
  while ($ui.Messages.Children.Count -gt 60) { $ui.Messages.Children.RemoveAt(0) }
  $ui.Scroll.ScrollToEnd()
  if ($state.collapsed -and $role -eq 'assistant') { $ui.Detail.Text = Plain $text }
}

function Set-Status([string]$status, [string]$detail) {
  $state.status = $status
  switch ($status) {
    'watching' { $ui.Dot.Fill = Brush '#3DDC97'; $ui.PauseBtn.Content = [string][char]0xE769; $ui.PauseBtn.ToolTip = '暫停觀看' }
    'paused'   { $ui.Dot.Fill = Brush '#F5B83D'; $ui.PauseBtn.Content = [string][char]0xE768; $ui.PauseBtn.ToolTip = '繼續觀看' }
    default    { $ui.Dot.Fill = Brush '#6F7785' }
  }
  if (-not $state.collapsed) { $ui.Detail.Text = $detail }
}

function Update-Thinking {
  $ui.Thinking.Visibility = if ($state.busy -and -not $state.collapsed) { 'Visible' } else { 'Collapsed' }
}

function Set-Collapsed([bool]$collapsed) {
  $state.collapsed = $collapsed
  $visibility = if ($collapsed) { 'Collapsed' } else { 'Visible' }
  $ui.Scroll.Visibility = $visibility
  $ui.InputBox.Visibility = $visibility
  Update-Thinking
  if ($collapsed) {
    $state.expandedHeight = $window.Height
    $window.MinHeight = 64
    $window.Height = 64
    $ui.CollapseBtn.Content = [string][char]0xE740
    $ui.CollapseBtn.ToolTip = '展開'
    $ui.Detail.Text = Plain $lastAssistant
  } else {
    $window.Height = $state.expandedHeight
    $ui.CollapseBtn.Content = [string][char]0xE921
    $ui.CollapseBtn.ToolTip = '收合'
    $ui.Scroll.ScrollToEnd()
  }
  Save-Geometry
}

# ---- user actions ----
$ui.Header.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch {}; Save-Geometry })
$ui.PauseBtn.Add_Click({ if ($state.status -eq 'paused') { Emit @{ type = 'resume' } } else { Emit @{ type = 'pause' } } })
$ui.CollapseBtn.Add_Click({ Set-Collapsed (-not $state.collapsed) })
$ui.CloseBtn.Add_Click({ Emit @{ type = 'stop' } })
$ui.Input.Add_TextChanged({ $ui.Hint.Visibility = if ($ui.Input.Text.Length -gt 0) { 'Collapsed' } else { 'Visible' } })
function Send-Input {
  $text = $ui.Input.Text.Trim()
  if ($text) { Emit @{ type = 'send'; text = $text }; $ui.Input.Text = '' }
}
$ui.Input.Add_PreviewKeyDown({
  param($sender, $e)
  if ($e.Key -eq 'Return' -and -not ([Windows.Input.Keyboard]::Modifiers -band [Windows.Input.ModifierKeys]::Shift)) {
    $e.Handled = $true
    Send-Input
  }
})
$ui.SendBtn.Add_Click({ Send-Input })
$window.Add_SizeChanged({ if (-not $state.collapsed) { $state.expandedHeight = $window.Height } })
$window.Add_Closing({ Save-Geometry })

# ---- commands from the plugin: a reader thread queues lines, a UI timer applies them ----
$queue = [Collections.Concurrent.ConcurrentQueue[string]]::new()
$reader = [powershell]::Create()
$reader.Runspace = [runspacefactory]::CreateRunspace()
$reader.Runspace.Open()
$reader.Runspace.SessionStateProxy.SetVariable('queue', $queue)
[void]$reader.AddScript({
  $in = [Console]::In
  while ($true) {
    $line = $in.ReadLine()
    if ($null -eq $line) { $queue.Enqueue('{"type":"close"}'); break }
    if ($line.Trim()) { $queue.Enqueue($line) }
  }
})
[void]$reader.BeginInvoke()

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(60)
$timer.Add_Tick({
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    try { $command = $line | ConvertFrom-Json } catch { continue }
    switch ($command.type) {
      'state' { Set-Status $command.status $command.detail }
      'say'   { Add-Message $command.role $command.text }
      'busy'  { $state.busy = [bool]$command.value; Update-Thinking }
      'close' { $timer.Stop(); $window.Close() }
    }
  }
})
$timer.Start()

$window.Add_ContentRendered({ Emit @{ type = 'ready' } })
[void]$window.ShowDialog()
Emit @{ type = 'closed' }
# The reader thread is still blocked on stdin; end the process instead of waiting for it.
[Environment]::Exit(0)
