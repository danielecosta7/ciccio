// Aggiornamento automatico, come il companion: Ciccio dice che c'è una versione nuova (desktop/update) e
// manda il manifest della release (app.json) con la sua firma. L'app controlla la firma con la chiave pubblica
// delle release che ha dentro (shared/release-key.ts, la stessa del companion), scarica con il suo token il file
// che dice il manifest, ne controlla dimensione, sha256 e firma e solo allora lo prepara: un server compromesso
// non può far installare niente. Senza chiave (segnaposto) l'app non si aggiorna da sola.
// Si installa quando la finestra non è davanti (chiusa o ridotta) o all'uscita, così non si chiude mai mentre scrivi.
// Mac: si scambia Ciccio.app con quella nuova e si riapre. Windows: l'installer in silenzio, poi si riapre.

use crate::Shared;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize)]
pub struct Offer {
    pub version: String,
    /// Nome, sha256, dimensione e indirizzo come li dice il server: si usa solo il manifest firmato.
    #[allow(dead_code)]
    pub file: String,
    #[allow(dead_code)]
    pub sha256: String,
    #[allow(dead_code)]
    pub size: u64,
    #[allow(dead_code)]
    pub url: String,
    /// Testo esatto di app.json e la sua firma (base64): senza, l'aggiornamento si rifiuta.
    #[serde(default)]
    pub manifest: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
}

// ── Firma delle release (formato in shared/node/release.ts) ─────────────

/// shared/release-key.ts: le chiavi pubbliche sono le righe tra apici (32 byte in base64).
const RELEASE_KEY_TS: &str = include_str!("../../../shared/release-key.ts");

/// Le chiavi vere di shared/release-key.ts; vuoto = c'è ancora il segnaposto.
pub fn release_keys() -> Vec<VerifyingKey> {
    parse_keys(RELEASE_KEY_TS)
}

fn parse_keys(text: &str) -> Vec<VerifyingKey> {
    let b64 = base64::engine::general_purpose::STANDARD;
    text
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let inner = l.strip_prefix('\'')?;
            let inner = inner.strip_suffix(',').unwrap_or(inner).strip_suffix('\'')?;
            if inner.contains('\'') {
                return None;
            }
            let raw = b64.decode(inner).ok()?;
            if b64.encode(&raw) != inner {
                return None;
            }
            VerifyingKey::from_bytes(&<[u8; 32]>::try_from(raw.as_slice()).ok()?).ok()
        })
        .collect()
}

const NO_KEY: &str = "questa versione non ha la chiave pubblica delle release (c'è ancora il segnaposto in shared/release-key.ts): aggiornamenti automatici spenti, si aggiorna a mano";

/// La firma (base64) dei dati è di una delle chiavi?
fn signed_by(data: &[u8], sig_b64: &str, keys: &[VerifyingKey]) -> bool {
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) else { return false };
    let Ok(bytes) = <[u8; 64]>::try_from(raw.as_slice()) else { return false };
    let sig = Signature::from_bytes(&bytes);
    keys.iter().any(|k| k.verify_strict(data, &sig).is_ok())
}

#[derive(Deserialize)]
struct SignedFile {
    file: String,
    sha256: String,
    size: u64,
    sig: String,
}

#[derive(Deserialize)]
struct Manifest {
    product: String,
    version: String,
    files: HashMap<String, SignedFile>,
}

/// Il file di questa piattaforma nel manifest firmato della versione offerta.
fn signed_entry(u: &Offer, keys: &[VerifyingKey]) -> Result<SignedFile, String> {
    let (Some(text), Some(sig)) = (u.manifest.as_deref(), u.signature.as_deref()) else {
        return Err("aggiornamento senza firma: il server non ha il manifest firmato".into());
    };
    if !signed_by(text.as_bytes(), sig, keys) {
        return Err("firma del manifest non valida: non è di una release firmata con la chiave di questa app".into());
    }
    let mut m: Manifest = serde_json::from_str(text).map_err(|_| "manifest firmato ma non leggibile".to_string())?;
    if m.product != "app" {
        return Err(format!("manifest firmato di un altro programma ({})", m.product));
    }
    if m.version != u.version {
        return Err(format!("il manifest firmato è della versione {}, non della {}", m.version, u.version));
    }
    let platform = crate::config::platform();
    let f = m.files.remove(platform).ok_or_else(|| format!("la release {} non ha un file per {platform}", m.version))?;
    if f.file.is_empty() || !f.file.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || f.sha256.len() != 64 {
        return Err("manifest firmato con una voce non valida".into());
    }
    Ok(f)
}

pub struct Staged {
    pub version: String,
    /// Mac: la Ciccio.app nuova già scompattata. Windows: l'installer.
    pub path: PathBuf,
}

/// true se la versione a è più nuova di b (0.10.0 > 0.9.3).
pub fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (p(a), p(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn updates_dir() -> Option<PathBuf> {
    use tauri::Manager;
    Some(crate::shared().app.path().app_data_dir().ok()?.join("updates"))
}

pub async fn offer(sh: Arc<Shared>, u: Offer, base: String, token: String) {
    if !newer(&u.version, crate::link::VERSION) || sh.update.lock().unwrap().as_ref().is_some_and(|s| s.version == u.version) {
        return;
    }
    if release_keys().is_empty() {
        eprintln!("c'è la versione {} dell'app, ma {NO_KEY}", u.version);
        return;
    }
    match prepare(&u, &base, &token).await {
        Ok(path) => {
            *sh.update.lock().unwrap() = Some(Staged { version: u.version.clone(), path });
            // Finestra già nascosta: si aggiorna subito.
            if crate::main_window(&sh).is_some_and(|w| !w.is_visible().unwrap_or(true)) {
                apply(&sh, true);
            }
        }
        Err(e) => eprintln!("aggiornamento {} non riuscito: {e}", u.version),
    }
}

async fn prepare(u: &Offer, base: &str, token: &str) -> Result<PathBuf, String> {
    // Il file giusto lo dice il manifest firmato, non il resto del messaggio del server.
    let keys = release_keys();
    if keys.is_empty() {
        return Err(NO_KEY.into());
    }
    let entry = signed_entry(u, &keys)?;
    let dir = updates_dir().ok_or("cartella dati non disponibile")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&entry.file);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let r = http.get(format!("{base}/desktop/download/{}", entry.file)).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("il server ha risposto {}", r.status()));
    }
    let data = r.bytes().await.map_err(|e| e.to_string())?;
    if data.len() as u64 != entry.size || hex::encode(Sha256::digest(&data)) != entry.sha256 {
        return Err("file scaricato diverso da quello della release (dimensione o sha256)".into());
    }
    if !signed_by(&data, &entry.sig, &keys) {
        return Err("firma del file non valida".into());
    }
    std::fs::write(&file, &data).map_err(|e| e.to_string())?;
    if cfg!(target_os = "macos") {
        let stage = dir.join(format!("stage-{}", u.version));
        let _ = std::fs::remove_dir_all(&stage);
        let ok = std::process::Command::new("/usr/bin/ditto").arg("-x").arg("-k").arg(&file).arg(&stage).status().map(|s| s.success()).unwrap_or(false);
        let _ = std::fs::remove_file(&file);
        let app = stage.join("Ciccio.app");
        if !ok || !app.join("Contents/MacOS/ciccio").exists() {
            return Err("zip della versione nuova non valido".into());
        }
        return Ok(app);
    }
    Ok(file)
}

/// Installa la versione pronta e chiude l'app; `reopen`: si riapre da sola (all'uscita voluta no).
pub fn apply(sh: &Arc<Shared>, reopen: bool) -> bool {
    let started = install(sh, reopen);
    if started {
        sh.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        sh.app.exit(0);
    }
    started
}

/// Fa partire lo scambio con la versione pronta, che aspetta la fine di questo processo.
/// Da sola (senza `apply`) quando l'app sta già uscendo: ⌘Q sul Mac arriva solo come RunEvent::Exit.
pub fn install(sh: &Arc<Shared>, reopen: bool) -> bool {
    let Some(staged) = sh.update.lock().unwrap().take() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    let pid = std::process::id().to_string();
    #[cfg(target_os = "macos")]
    let started = {
        // .../Ciccio.app/Contents/MacOS/ciccio: fuori da un .app (cargo run) non si aggiorna niente.
        let Some(bundle) = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|e| e == "app")) else { return false };
        // Se lo scambio non riesce si rimette la versione vecchia.
        let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
rm -rf "$2.old"
if mv "$2" "$2.old" && mv "$3" "$2"; then rm -rf "$2.old"; else [ -d "$2" ] || mv "$2.old" "$2"; fi
rm -rf "$(dirname "$3")"
[ "$4" = 1 ] && open "$2""#;
        std::process::Command::new("/bin/sh")
            .args(["-c", script, "sh", &pid])
            .arg(bundle)
            .arg(&staged.path)
            .arg(if reopen { "1" } else { "0" })
            .spawn()
            .is_ok()
    };
    #[cfg(target_os = "windows")]
    let started = {
        use std::os::windows::process::CommandExt;
        // L'installer (NSIS, per l'utente) sostituisce i file quando questa copia è chiusa.
        let q = |p: &std::path::Path| p.display().to_string().replace('\'', "''");
        let script = format!(
            "Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Process -Wait -FilePath '{}' -ArgumentList '/S'; Remove-Item -Force '{}'; {}",
            q(&staged.path),
            q(&staged.path),
            if reopen { format!("Start-Process -FilePath '{}'", q(&exe)) } else { String::new() }
        );
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .is_ok()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let started = {
        let _ = (exe, pid, reopen, staged);
        false
    };
    started
}

#[cfg(test)]
mod tests {
    use super::*;

    // Chiave usa e getta e firma fatte con Node (crypto.sign), come scripts/release-key.mjs.
    const PUB: &str = "+eEc4GoHLsYKziGWlIOBiY+m9ZCi8OWOj78WR1gLqUQ=";
    const TEXT: &str = r#"{"product":"app","version":"9.9.9","files":{"win32-x64":{"file":"Ciccio-test.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"sig":"x"},"darwin-arm64":{"file":"Ciccio-test.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"sig":"x"},"darwin-x64":{"file":"Ciccio-test.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"sig":"x"},"linux-x64":{"file":"Ciccio-test.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"sig":"x"}}}"#;
    const SIG: &str = "9peso71KIPtkJnh02rl+OHjNNio559nr1SifNJYQA4MZkdB26Ped9+FXLnSSnYfGCyE/olQnUY6MjwA5iRFcDg==";

    fn offer(version: &str, manifest: &str, sig: &str) -> Offer {
        Offer { version: version.into(), file: String::new(), sha256: String::new(), size: 0, url: String::new(), manifest: Some(manifest.into()), signature: Some(sig.into()) }
    }

    #[test]
    fn chiavi_dal_file_ts() {
        assert!(parse_keys("export const K = [
  'SEGNAPOSTO-SOSTITUISCI-CON-LA-CHIAVE-PUBBLICA',
];").is_empty());
        assert_eq!(parse_keys(&format!("[
  '{PUB}',
  'SEGNAPOSTO',
]")).len(), 1);
    }

    #[test]
    fn manifest_firmato() {
        let keys = parse_keys(&format!("'{PUB}',"));
        let e = signed_entry(&offer("9.9.9", TEXT, SIG), &keys).expect("firma valida");
        assert_eq!(e.file, "Ciccio-test.bin");
        // Versione diversa da quella firmata, testo cambiato, firma di un'altra chiave, nessuna firma.
        assert!(signed_entry(&offer("9.9.8", TEXT, SIG), &keys).is_err());
        assert!(signed_entry(&offer("9.9.9", &TEXT.replace("9.9.9", "9.9.10"), SIG), &keys).is_err());
        assert!(signed_entry(&offer("9.9.9", TEXT, SIG), &parse_keys("'hTxX0Ep0y/NwLlKo+zYVCqWtyE3OwsbGC1C3947XZy4=',")).is_err());
        let mut none = offer("9.9.9", TEXT, SIG);
        none.signature = None;
        assert!(signed_entry(&none, &keys).is_err());
    }
}
