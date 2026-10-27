import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { configDir } from './config.js';
import { ICON_ICO_BASE64, ICON_PNG_BASE64 } from './icon-data.js';

// Interfaccia di Windows senza niente da installare: PowerShell 5.1 e Windows Forms ci sono su ogni
// Windows 10/11. Gli script stanno qui dentro (l'.exe resta un file solo), si scrivono in
// ~/.ciccio-companion/ui e girano senza finestra di console. La logica resta nel companion (tray.ts):
// PowerShell disegna soltanto icona, menu e finestre e dice cosa si è cliccato.

const TRAY_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Consapevole della scala dello schermo: senza, a 125% Windows dice che le icone piccole sono da 16 px
# e poi ingrandisce l'icona a 20, sgranandola. Va chiesto prima di creare qualsiasi finestra.
Add-Type -Namespace CcDpi -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][CcDpi.U]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Send($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

# La "C" di Ciccio (come il logo disegnato in Affinity, griglia 8x8) alla misura vera delle icone piccole,
# con i bordi arrotondati al pixel intero: nitida a 100, 125, 150, 200%. Spenta = trasparente al 45%.
function New-PixelIcon([bool]$dim) {
  $n = [Math]::Max(16, [System.Windows.Forms.SystemInformation]::SmallIconSize.Width)
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $a = 255; if ($dim) { $a = 115 }
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, 166, 255, 0))
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, 7, 7, 7))
  $g.FillRectangle($bg, 0, 0, $n, $n)
  $e = { param($v) [int][Math]::Round($v * $n / 8) }
  foreach ($r in @(@(2,2,6,3), @(2,3,3,5), @(2,5,6,6))) {
    $x0 = & $e $r[0]; $y0 = & $e $r[1]; $x1 = & $e $r[2]; $y1 = & $e $r[3]
    $g.FillRectangle($ink, $x0, $y0, $x1 - $x0, $y1 - $y0)
  }
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# Notifiche di Ciccio (toast di Windows), con l'AppUserModelID registrato all'installazione.
$script:notifier = $null
function Show-Toast($msg) {
  try {
    if (-not $script:notifier) {
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
      $script:notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$msg.aumid)
    }
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml([string]$msg.xml)
    $t = [Windows.UI.Notifications.ToastNotification]::new($doc)
    $t.Tag = [string]$msg.tag
    $t.Group = 'ciccio'
    $script:notifier.Show($t)
    $sv = $script:notifier.Setting
    $sn = 'nessuno'; if ($null -ne $sv) { $sn = [string][int]$sv }
    Send @{ type = 'toast'; id = [string]$msg.id; ok = $true; setting = $sn }
  } catch {
    Send @{ type = 'toast'; id = [string]$msg.id; ok = $false; error = $_.Exception.Message }
  }
}

$iconOn = New-PixelIcon $false
$iconOff = New-PixelIcon $true
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOff
$tray.Text = 'Ciccio Companion'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$script:model = @()

# Il menu si ricostruisce a ogni apertura dall'ultimo stato ricevuto: non aspetta mai il companion.
function Build-Menu {
  $menu.Items.Clear()
  foreach ($it in $script:model) {
    if ($it.sep) { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)); continue }
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem ([string]$it.text)
    if ($it.disabled) { $mi.Enabled = $false }
    if ($it.checked) { $mi.Checked = $true }
    if ($it.id) { $mi.Tag = [string]$it.id; $mi.add_Click({ Send @{ type = 'click'; id = $this.Tag } }) }
    [void]$menu.Items.Add($mi)
  }
}
$menu.add_Opening({ param($s, $e) Build-Menu; $e.Cancel = $false })
# Anche il clic sinistro apre il menu, come sul Mac.
$tray.add_MouseUp({ param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $tray.GetType().GetMethod('ShowContextMenu', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($tray, $null)
  }
})
$tray.Visible = $true

# Messaggi dal companion, una riga JSON alla volta. Se il companion sparisce (stdin chiuso), si chiude anche l'icona.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$script:pending = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({
  while ($script:pending.IsCompleted) {
    $line = $script:pending.Result
    if ($null -eq $line) { $timer.Stop(); $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
    $script:pending = $stdin.ReadLineAsync()
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    if ($msg.type -eq 'state') {
      if ($msg.on) { $tray.Icon = $iconOn } else { $tray.Icon = $iconOff }
      $tray.Text = [string]$msg.tooltip
      $script:model = @($msg.menu)
    } elseif ($msg.type -eq 'toast') {
      Show-Toast $msg
    } elseif ($msg.type -eq 'quit') {
      $timer.Stop(); $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return
    }
  }
})
$timer.Start()
Send @{ type = 'ready'; visible = $tray.Visible }
[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
$tray.Dispose()
`;

// PowerShell parte con windowsHide: Windows applica quel «nascosto» alla prima ShowWindow del processo,
// cioè alla finestra, che resta invisibile e aspetta per sempre un clic. Appena c'è, la si mostra di nuovo.
const SHOW_WINDOW_PS1 = String.raw`
Add-Type -Namespace CcWin -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
function Show-CcWindow($form) { [void][CcWin.U]::ShowWindow($form.Handle, 5); [void][CcWin.U]::SetForegroundWindow($form.Handle); $form.Activate() }
`;

const DIALOG_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${SHOW_WINDOW_PS1}
[System.Windows.Forms.Application]::EnableVisualStyles()
# In PowerShell 5.1 ConvertFrom-Json passa l'array come oggetto unico: @() ne farebbe un pulsante solo.
$buttons = [string[]]($env:CC_DLG_BUTTONS | ConvertFrom-Json)
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Ciccio Companion'
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ShowInTaskbar = $true
$f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'
$f.Padding = New-Object System.Windows.Forms.Padding 18
$f.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$col = New-Object System.Windows.Forms.FlowLayoutPanel
$col.FlowDirection = 'TopDown'; $col.AutoSize = $true; $col.WrapContents = $false
$title = New-Object System.Windows.Forms.Label
$title.Text = $env:CC_DLG_TITLE; $title.AutoSize = $true; $title.MaximumSize = New-Object System.Drawing.Size 440, 0
$title.Font = New-Object System.Drawing.Font('Segoe UI', 11.5, [System.Drawing.FontStyle]::Bold)
$text = New-Object System.Windows.Forms.Label
$text.Text = $env:CC_DLG_TEXT; $text.AutoSize = $true; $text.MaximumSize = New-Object System.Drawing.Size 440, 0
$text.Margin = New-Object System.Windows.Forms.Padding 0, 8, 0, 16
# Casella facoltativa (es. «Solo lettura»): il suo stato torna insieme al pulsante.
$check = $null
if ($env:CC_DLG_CHECK) {
  $check = New-Object System.Windows.Forms.CheckBox
  $check.Text = $env:CC_DLG_CHECK; $check.AutoSize = $true; $check.Checked = ($env:CC_DLG_CHECKED -eq '1')
  $check.Margin = New-Object System.Windows.Forms.Padding 0, 0, 0, 14
}
# Pulsante predefinito (Invio, e il fuoco all'apertura) e pulsante di Esc: di solito il primo e nessuno.
$def = 0; if ($env:CC_DLG_DEFAULT) { $def = [int]$env:CC_DLG_DEFAULT }
$cancel = -1; if ($env:CC_DLG_CANCEL) { $cancel = [int]$env:CC_DLG_CANCEL }
# Pulsanti solo col mouse (es. i consensi): fuori dal Tab e attivi dopo un secondo, così un tasto o un clic
# di chi stava scrivendo altrove quando la finestra è comparsa non li preme.
$mouse = @(); if ($env:CC_DLG_MOUSE) { $mouse = [int[]]($env:CC_DLG_MOUSE -split ',') }
$script:late = @()
$row = New-Object System.Windows.Forms.FlowLayoutPanel
$row.FlowDirection = 'RightToLeft'; $row.AutoSize = $true; $row.Anchor = 'Right'
$script:choice = -1
for ($i = $buttons.Count - 1; $i -ge 0; $i--) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = [string]$buttons[$i]; $b.AutoSize = $true; $b.MinimumSize = New-Object System.Drawing.Size 96, 30
  $b.Tag = $i
  $b.add_Click({ $script:choice = [int]$this.Tag; $this.FindForm().Close() })
  [void]$row.Controls.Add($b)
  if ($i -eq $def) { $f.AcceptButton = $b }
  if ($i -eq $cancel) { $f.CancelButton = $b }
  if ($mouse -contains $i) { $b.TabStop = $false; $b.Enabled = $false; $script:late += $b }
}
if ($script:late.Count) {
  if ($check) { $check.TabStop = $false }
  $wake = New-Object System.Windows.Forms.Timer
  $wake.Interval = 1000
  $wake.add_Tick({ $wake.Stop(); foreach ($x in $script:late) { $x.Enabled = $true } })
  $f.add_Shown({ $wake.Start() })
}
$items = @($title, $text)
if ($check) { $items += $check }
$items += $row
$col.Controls.AddRange([System.Windows.Forms.Control[]]$items)
$f.Controls.Add($col)
$f.add_Shown({ Show-CcWindow $f; if ($f.AcceptButton) { [void]$f.AcceptButton.Focus() } })
[void]$f.ShowDialog()
$out = [string]$script:choice
if ($check) { $out += '|' + [int]$check.Checked }
[Console]::Out.Write($out)
`;

// Collegamento "Ciccio Companion" nel menu Start con l'AppUserModelID: senza, Windows non mostra le
// notifiche di un programma non pacchettizzato. Interfacce COM di Windows (IShellLinkW, IPropertyStore).
const SHORTCUT_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
namespace Ciccio {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, uint fl);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
    void GetHotkey(out short h); void SetHotkey(short h);
    void GetShowCmd(out int s); void SetShowCmd(int s);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint r);
    void Resolve(IntPtr h, uint f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr pad; }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint c); void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v); void SetValue(ref PropertyKey k, ref PropVariant v); void Commit();
  }
  public static class Shortcut {
    public static void Create(string lnk, string target, string args, string icon, string aumid) {
      var link = (IShellLinkW)new CShellLink();
      link.SetPath(target); link.SetArguments(args); link.SetIconLocation(icon, 0);
      link.SetDescription("Ciccio Companion");
      var store = (IPropertyStore)link;
      var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
      var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
      store.SetValue(ref key, ref v); store.Commit();
      Marshal.FreeCoTaskMem(v.p);
      ((IPersistFile)link).Save(lnk, true);
    }
  }
}
'@
New-Item -ItemType Directory -Force -Path (Split-Path $env:CC_LNK) | Out-Null
[Ciccio.Shortcut]::Create($env:CC_LNK, $env:CC_TARGET, $env:CC_ARGS, $env:CC_ICON, $env:CC_AUMID)
[Console]::Out.Write('ok')
`;

// Permessi di Ciccio Companion: cosa serve perché funzioni bene su questo PC, ognuno con il suo stato
// e il pulsante che apre la pagina giusta delle Impostazioni. Con CC_PERM_JSON=1 scrive solo i controlli (prove).
const PERMISSIONS_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$win11 = [Environment]::OSVersion.Version.Build -ge 22000

function Get-Checks {
  $checks = @()

  # Notifiche: stato reale per l'AppUserModelID di Ciccio Companion.
  $setting = 'sconosciuto'
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    # In PowerShell 5.1 l'enum di Windows Runtime convertito in testo resta vuoto: si legge il numero.
    # Prima il notifier in una variabile: letta in catena, la proprietà arriva vuota (come nell'icona, che la legge così).
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:CC_AUMID)
    $v = $notifier.Setting
    $names = @('Enabled', 'DisabledForApplication', 'DisabledForUser', 'DisabledByGroupPolicy', 'DisabledByManifest')
    if ($null -eq $v) { $setting = 'nessuno' }
    else { $i = [int]$v; if ($i -ge 0 -and $i -lt $names.Count) { $setting = $names[$i] } else { $setting = 'valore ' + $i } }
  } catch { $setting = 'errore: ' + $_.Exception.Message }
  # Se Windows Runtime non risponde, si legge dove scrive Impostazioni › Notifiche: interruttore generale e quello dell'app.
  if ($setting -notmatch '^(Enabled|Disabled)') {
    $all = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -Name ToastEnabled -ErrorAction SilentlyContinue).ToastEnabled
    $app = (Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\' + $env:CC_AUMID) -Name Enabled -ErrorAction SilentlyContinue).Enabled
    if ($all -eq 0) { $setting = 'DisabledForUser' } elseif ($app -eq 0) { $setting = 'DisabledForApplication' } else { $setting = 'Enabled' }
  }
  $n = @{ key = 'notifications'; title = 'Notifiche di Ciccio Companion'; button = @{ label = 'Apri Notifiche'; action = 'ms-settings:notifications' } }
  if ($env:CC_PERM_NOTIFY_OPTION -eq '0') { $n.ok = $false; $n.text = 'Spente in Ciccio Companion: riaccendile dal menu dell''icona › «Notifiche di Ciccio».'; $n.button = $null }
  elseif ($setting -eq 'Enabled') { $n.ok = $true; $n.text = 'Accese: gli avvisi di Ciccio arrivano come notifiche di Windows.' }
  elseif ($setting -eq 'DisabledForApplication') { $n.ok = $false; $n.text = 'Spente per Ciccio Companion: in Notifiche, accendi «Ciccio Companion».' }
  elseif ($setting -eq 'DisabledForUser') { $n.ok = $false; $n.text = 'Spente per tutte le app: in Notifiche, accendi «Notifiche».' }
  elseif ($setting -eq 'DisabledByGroupPolicy') { $n.ok = $false; $n.text = 'Bloccate dai criteri del PC (amministratore).'; $n.button = $null }
  else { $n.ok = $null; $n.text = 'Non verificabile su questo PC (' + $setting + ').' }
  $n.state = $setting
  $checks += $n

  # Non disturbare / Assistente notifiche: Windows non lo dice ai programmi, quindi solo un promemoria.
  $dnd = 'ms-settings:quiethours'; if ($win11) { $dnd = 'ms-settings:notifications' }
  $checks += @{ key = 'dnd'; title = 'Non disturbare'; ok = $null; text = 'Se è attivo, le notifiche finiscono nel centro notifiche senza comparire sullo schermo.'; button = @{ label = 'Controlla'; action = $dnd } }

  # Avvio all'accesso: la chiave Run e l'interruttore in Impostazioni › App › Avvio (StartupApproved).
  $run = (Get-ItemProperty -Path $runKey -Name 'CiccioCompanion' -ErrorAction SilentlyContinue).CiccioCompanion
  $approved = (Get-ItemProperty -Path $approvedKey -Name 'CiccioCompanion' -ErrorAction SilentlyContinue).CiccioCompanion
  $off = $approved -and (($approved[0] -band 1) -eq 1)
  $a = @{ key = 'startup'; title = "Avvio all'accesso" }
  if (-not $run) { $a.ok = $false; $a.text = 'Non attivo: dopo un riavvio Ciccio Companion resta spento.'; $a.button = @{ label = 'Attiva'; action = 'enable-run' } }
  elseif ($off) { $a.ok = $false; $a.text = 'Spento in Impostazioni › App › Avvio: accendi «Ciccio Companion».'; $a.button = @{ label = 'Apri Avvio'; action = 'ms-settings:startupapps' } }
  else { $a.ok = $true; $a.text = 'Attivo: parte da solo a ogni accesso a Windows.'; $a.button = @{ label = 'Apri Avvio'; action = 'ms-settings:startupapps' } }
  $checks += $a

  # Node.js serve solo ai server MCP lanciati con npx (Chrome).
  if ($env:CC_PERM_NEEDS_NODE -eq '1') {
    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if ($npx) { $checks += @{ key = 'node'; title = 'Node.js (per Chrome)'; ok = $true; text = 'Installato: gli strumenti di Chrome possono partire.' } }
    else { $checks += @{ key = 'node'; title = 'Node.js (per Chrome)'; ok = $false; text = 'Manca: senza, gli strumenti di Chrome non partono. Installa la versione LTS e riavvia Ciccio Companion.'; button = @{ label = 'Scarica Node.js'; action = 'https://nodejs.org/it/download' } } }
  }

  # Affinity: il server MCP si accende nell'app.
  if ($env:CC_PERM_AFFINITY -eq '1') {
    $aff = $null
    try { $aff = ((Get-Content $env:CC_PERM_STATUS -Raw | ConvertFrom-Json).servers | Where-Object { $_.name -eq 'affinity' }).status } catch { }
    if ($aff -eq 'online') { $checks += @{ key = 'affinity'; title = 'Affinity'; ok = $true; text = 'Server MCP raggiungibile.' } }
    else { $checks += @{ key = 'affinity'; title = 'Affinity'; ok = $null; text = 'Non raggiungibile adesso: apri Affinity e accendi il server MCP in Modifica › Impostazioni › Model Context Protocol.' } }
  }
  return ,$checks
}

if ($env:CC_PERM_JSON -eq '1') { [Console]::Out.Write((ConvertTo-Json -Depth 5 -Compress (Get-Checks))); exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${SHOW_WINDOW_PS1}
[System.Windows.Forms.Application]::EnableVisualStyles()
$f =New-Object System.Windows.Forms.Form
$f.Text = 'Permessi di Ciccio Companion'
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'
$f.Padding = New-Object System.Windows.Forms.Padding 18
$f.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$col = New-Object System.Windows.Forms.FlowLayoutPanel
$col.FlowDirection = 'TopDown'; $col.AutoSize = $true; $col.WrapContents = $false
$f.Controls.Add($col)

function Render {
  $col.SuspendLayout()
  $col.Controls.Clear()
  $h = New-Object System.Windows.Forms.Label
  $h.Text = 'Permessi di Ciccio Companion'; $h.AutoSize = $true
  $h.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
  $sub = New-Object System.Windows.Forms.Label
  $sub.Text = 'Cosa serve perché funzioni bene su questo PC.'; $sub.AutoSize = $true
  $sub.Margin = New-Object System.Windows.Forms.Padding 0, 4, 0, 12
  $col.Controls.AddRange(@($h, $sub))
  foreach ($c in (Get-Checks)) {
    $row = New-Object System.Windows.Forms.TableLayoutPanel
    $row.ColumnCount = 3; $row.RowCount = 2; $row.AutoSize = $true
    $row.Margin = New-Object System.Windows.Forms.Padding 0, 0, 0, 10
    [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle ([System.Windows.Forms.SizeType]::Absolute, 26)))
    [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle ([System.Windows.Forms.SizeType]::Absolute, 330)))
    [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle ([System.Windows.Forms.SizeType]::AutoSize)))
    $mark = New-Object System.Windows.Forms.Label
    $mark.AutoSize = $true; $mark.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    if ($c.ok -eq $true) { $mark.Text = [char]0x2713; $mark.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 70) }
    elseif ($c.ok -eq $false) { $mark.Text = '!'; $mark.ForeColor = [System.Drawing.Color]::FromArgb(200, 90, 0) }
    else { $mark.Text = 'i'; $mark.ForeColor = [System.Drawing.Color]::Gray }
    $t = New-Object System.Windows.Forms.Label
    $t.Text = [string]$c.title; $t.AutoSize = $true; $t.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
    $d = New-Object System.Windows.Forms.Label
    $d.Text = [string]$c.text; $d.AutoSize = $true; $d.MaximumSize = New-Object System.Drawing.Size 320, 0
    $row.Controls.Add($mark, 0, 0); $row.SetRowSpan($mark, 2)
    $row.Controls.Add($t, 1, 0); $row.Controls.Add($d, 1, 1)
    if ($c.button) {
      $b = New-Object System.Windows.Forms.Button
      $b.Text = [string]$c.button.label; $b.AutoSize = $true; $b.MinimumSize = New-Object System.Drawing.Size 110, 28
      $b.Tag = [string]$c.button.action
      $b.add_Click({
        if ($this.Tag -eq 'enable-run') {
          Set-ItemProperty -Path $runKey -Name 'CiccioCompanion' -Value $env:CC_PERM_RUN_CMD
          Remove-ItemProperty -Path $approvedKey -Name 'CiccioCompanion' -ErrorAction SilentlyContinue
          Render
        } else { Start-Process $this.Tag }
      })
      $row.Controls.Add($b, 2, 0); $row.SetRowSpan($b, 2)
    }
    $col.Controls.Add($row)
  }
  $note = New-Object System.Windows.Forms.Label
  $note.AutoSize = $true; $note.MaximumSize = New-Object System.Drawing.Size 480, 0; $note.ForeColor = [System.Drawing.Color]::DimGray
  $note.Text = 'Firewall: niente da aprire, Ciccio Companion si collega solo in uscita. SmartScreen chiede conferma solo la prima volta che apri l''.exe scaricato.'
  $note.Margin = New-Object System.Windows.Forms.Padding 0, 4, 0, 12
  $btns = New-Object System.Windows.Forms.FlowLayoutPanel
  $btns.FlowDirection = 'RightToLeft'; $btns.AutoSize = $true; $btns.Anchor = 'Right'
  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Chiudi'; $close.AutoSize = $true; $close.MinimumSize = New-Object System.Drawing.Size 96, 30
  $close.add_Click({ $f.Close() })
  $again = New-Object System.Windows.Forms.Button
  $again.Text = 'Ricontrolla'; $again.AutoSize = $true; $again.MinimumSize = New-Object System.Drawing.Size 96, 30
  $again.add_Click({ Render })
  $btns.Controls.AddRange(@($close, $again))
  $f.AcceptButton = $close
  $col.Controls.AddRange(@($note, $btns))
  $col.ResumeLayout()
}
Render
# Tornando dalle Impostazioni la finestra si aggiorna da sola.
$f.add_Activated({ if ($script:shown) { Render } })
$f.add_Shown({ $script:shown = $true; Show-CcWindow $f })
[void]$f.ShowDialog()
`;

const POWERSHELL = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Scrive lo script (UTF-8 con BOM, come lo vuole PowerShell 5.1) e restituisce il percorso.
 * Si riscrive solo se è cambiato: un PowerShell acceso (finestra dei permessi, icona) lo tiene aperto,
 * e in quel caso, se serve una versione nuova, se ne usa una copia a parte.
 */
function script(name: string, body: string): string {
  const dir = path.join(configDir(), 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const content = `\uFEFF${body.trim()}\r\n`;
  try { if (fs.readFileSync(file, 'utf8') === content) return file; } catch { /* non c'è ancora */ }
  try {
    fs.writeFileSync(file, content);
    return file;
  } catch {
    const copy = path.join(dir, `${path.basename(name, '.ps1')}-${process.pid}.ps1`);
    fs.writeFileSync(copy, content);
    return copy;
  }
}

const psArgs = (file: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file];

/**
 * Finestra con pulsanti propri (es. «Collega» / «Annulla»). Gira in un processo a parte, quindi
 * non blocca mai chi la apre. Restituisce l'indice del pulsante scelto, -1 se chiusa.
 */
export async function dialog(title: string, text: string, buttons: string[] = ['OK']): Promise<number> {
  return (await choose(title, text, buttons)).choice;
}

export interface ChooseOptions {
  /** Casella sotto il testo (es. «Solo lettura») e il suo stato iniziale. */
  check?: { label: string; checked: boolean };
  /** Pulsante di Invio, con il fuoco all'apertura (default il primo). */
  defaultButton?: number;
  /** Pulsante di Esc (default nessuno: Esc non fa niente). */
  cancelButton?: number;
  /** Pulsanti che si premono solo col mouse, dopo un secondo (i consensi): da tastiera resta solo il resto. */
  mouseOnly?: number[];
  /** Interrotto: la finestra si chiude, come senza risposta (-1). */
  signal?: AbortSignal;
}

/** Come dialog, con casella, pulsante predefinito e chiusura dall'esterno; `checked` è lo stato della casella. */
export function choose(title: string, text: string, buttons: string[], o: ChooseOptions = {}): Promise<{ choice: number; checked?: boolean }> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(POWERSHELL(), psArgs(script('dialog.ps1', DIALOG_PS1)), {
      env: {
        ...process.env, CC_DLG_TITLE: title, CC_DLG_TEXT: text, CC_DLG_BUTTONS: JSON.stringify(buttons),
        CC_DLG_CHECK: o.check?.label ?? '', CC_DLG_CHECKED: o.check?.checked ? '1' : '0',
        CC_DLG_DEFAULT: String(o.defaultButton ?? 0), CC_DLG_CANCEL: o.cancelButton != null ? String(o.cancelButton) : '', CC_DLG_MOUSE: (o.mouseOnly ?? []).join(','),
      },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    openWindows.add(p);
    const abort = () => p.kill();
    o.signal?.addEventListener('abort', abort);
    if (o.signal?.aborted) abort();
    p.on('exit', () => { openWindows.delete(p); o.signal?.removeEventListener('abort', abort); });
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('error', () => resolve({ choice: -1 }));
    p.on('exit', () => {
      const [c, k] = out.trim().split('|');
      const n = Number.parseInt(c, 10);
      resolve({ choice: Number.isFinite(n) ? n : -1, ...(k != null ? { checked: k === '1' } : {}) });
    });
  });
}

/** Identità di Ciccio Companion per Windows (notifiche, menu Start): AppUserModelID. */
export const AUMID = 'it.costa.ciccio-companion';
const AUMID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;

/** Collegamento nel menu Start (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Ciccio Companion.lnk). */
export const startMenuShortcut = () => path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ciccio Companion.lnk');

/** Icone di Ciccio su disco (dall'.exe), per il collegamento e le notifiche. */
export function iconFiles(dir: string): { ico: string; png: string } {
  fs.mkdirSync(dir, { recursive: true });
  const ico = path.join(dir, 'ciccio.ico');
  const png = path.join(dir, 'ciccio.png');
  fs.writeFileSync(ico, Buffer.from(ICON_ICO_BASE64, 'base64'));
  fs.writeFileSync(png, Buffer.from(ICON_PNG_BASE64, 'base64'));
  return { ico, png };
}

/** Finestre aperte (permessi, domande): «Esci» le chiude insieme all'icona. */
const openWindows = new Set<ChildProcess>();
export function closeWindows() { for (const p of openWindows) p.kill(); openWindows.clear(); }

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 60_000) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  const p = execFile(file, args, { env: env ?? process.env, windowsHide: true, encoding: 'utf8', timeout }, (err, stdout, stderr) => {
    openWindows.delete(p);
    resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
  });
  openWindows.add(p);
});

/**
 * Registra Ciccio Companion per le notifiche di Windows, senza amministratore:
 * AppUserModelID in HKCU (nome e icona) e collegamento nel menu Start con lo stesso ID,
 * che avvia l'icona. Si può rifare quante volte si vuole.
 */
export async function registerApp(bgExe: string, binDir: string): Promise<{ ok: boolean; error?: string }> {
  const { ico, png } = iconFiles(binDir);
  const reg = (args: string[]) => run('reg', ['add', AUMID_KEY, ...args, '/f']);
  await reg(['/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Ciccio Companion']);
  await reg(['/v', 'IconUri', '/t', 'REG_SZ', '/d', png]);
  await reg(['/v', 'IconBackgroundColor', '/t', 'REG_SZ', '/d', 'FFA6FF00']);
  const r = await run(POWERSHELL(), psArgs(script('shortcut.ps1', SHORTCUT_PS1)), {
    ...process.env, CC_LNK: startMenuShortcut(), CC_TARGET: bgExe, CC_ARGS: 'tray', CC_ICON: ico, CC_AUMID: AUMID,
  });
  return r.ok && r.out.endsWith('ok') ? { ok: true } : { ok: false, error: r.out.split('\n').slice(-3).join(' ').slice(0, 300) };
}

/** Toglie collegamento e registrazione (uninstall). */
export async function unregisterApp() {
  fs.rmSync(startMenuShortcut(), { force: true });
  await run('reg', ['delete', AUMID_KEY, '/f']);
}

export interface PermissionCheck { key: string; title: string; ok: boolean | null; text: string; state?: string; button?: { label: string; action: string } | null }
export interface PermissionsEnv { notifyOption: boolean; needsNode: boolean; affinity: boolean; statusFile: string; runCommand: string }

const permEnv = (o: PermissionsEnv, json: boolean): NodeJS.ProcessEnv => ({
  ...process.env, CC_AUMID: AUMID, CC_PERM_JSON: json ? '1' : '0', CC_PERM_NOTIFY_OPTION: o.notifyOption ? '1' : '0',
  CC_PERM_NEEDS_NODE: o.needsNode ? '1' : '0', CC_PERM_AFFINITY: o.affinity ? '1' : '0', CC_PERM_STATUS: o.statusFile, CC_PERM_RUN_CMD: o.runCommand,
});

/** Finestra «Permessi di Ciccio Companion»; si risolve quando viene chiusa. Processo a parte: non blocca l'icona. */
export async function showPermissions(o: PermissionsEnv): Promise<void> {
  // Senza limite di tempo: resta aperta finché non la chiudi.
  await run(POWERSHELL(), psArgs(script('permissions.ps1', PERMISSIONS_PS1)), permEnv(o, false), 0);
}

/** Gli stessi controlli della finestra, come dati (per "permissions --json" e per le prove). */
export async function permissionChecks(o: PermissionsEnv): Promise<PermissionCheck[]> {
  const r = await run(POWERSHELL(), psArgs(script('permissions.ps1', PERMISSIONS_PS1)), permEnv(o, true));
  try { return JSON.parse(r.out) as PermissionCheck[]; } catch { throw new Error(`controlli non riusciti: ${r.out.slice(0, 300)}`); }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Notifica di Windows: titolo, testo, icona di Ciccio; il clic (o «Apri») apre la chat nel browser. */
export function toastXml(n: { title: string; body: string; url: string }, png: string): string {
  const src = `file:///${png.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
  return `<toast activationType="protocol" launch="${xml(n.url)}"><visual><binding template="ToastGeneric">`
    + `<text>${xml(n.title)}</text><text>${xml(n.body)}</text>`
    + `<image placement="appLogoOverride" hint-crop="none" src="${xml(src)}"/></binding></visual>`
    + `<actions><action content="Apri la chat" activationType="protocol" arguments="${xml(n.url)}"/></actions></toast>`;
}

export interface MenuItem { text?: string; id?: string; disabled?: boolean; checked?: boolean; sep?: boolean }
export interface TrayState { on: boolean; tooltip: string; menu: MenuItem[] }
export type UiEvent = { type: 'ready'; visible?: boolean } | { type: 'click'; id: string } | { type: 'toast'; id: string; ok: boolean; error?: string; setting?: string } | { type: 'exit'; code: number | null; error: string };

/** L'icona nell'area di notifica: un processo PowerShell che riceve lo stato e manda i clic. */
export class TrayUi {
  private p: ChildProcessWithoutNullStreams | null = null;
  private last: TrayState | null = null;

  constructor(private onEvent: (e: UiEvent) => void) {}

  start() {
    const p = spawn(POWERSHELL(), psArgs(script('tray-ui.ps1', TRAY_PS1)), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.p = p;
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1500); });
    p.stdin.on('error', () => undefined);
    createInterface({ input: p.stdout }).on('line', (line) => {
      try { this.onEvent(JSON.parse(line) as UiEvent); } catch { /* riga non JSON */ }
    });
    p.on('error', (e) => { err = e.message; });
    p.on('exit', (code) => { if (this.p === p) { this.p = null; this.onEvent({ type: 'exit', code, error: err.trim() }); } });
    if (this.last) this.send(this.last);
  }

  get running() { return this.p != null; }

  send(state: TrayState) {
    this.last = state;
    // Il testo del suggerimento di un'icona di Windows è al massimo di 63 caratteri.
    const msg = { type: 'state', ...state, tooltip: state.tooltip.slice(0, 63) };
    if (this.p?.stdin.writable) this.p.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** Mostra una notifica (la risposta arriva come evento "toast"); false se l'interfaccia non è accesa. */
  toast(id: string, xmlText: string): boolean {
    if (!this.p?.stdin.writable) return false;
    this.p.stdin.write(`${JSON.stringify({ type: 'toast', id, tag: id.slice(0, 60), aumid: AUMID, xml: xmlText })}\n`);
    return true;
  }

  stop() {
    const p = this.p;
    this.p = null;
    if (!p) return;
    try { p.stdin.write('{"type":"quit"}\n'); p.stdin.end(); } catch { /* già chiuso */ }
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 2000).unref();
  }
}
