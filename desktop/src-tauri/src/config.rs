// Dove sta Ciccio e chi è questo PC. Il token dell'app sta solo nel Portachiavi del Mac o
// nell'archivio credenziali di Windows; nel file di config ci sono solo gli indirizzi.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "it.costa.ciccio";
const KEYRING_USER: &str = "token";

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Config {
    /// Indirizzo di Ciccio (https): la finestra apre sempre questo. Vuoto finché non lo si sceglie
    /// nella pagina locale al primo avvio. Un vecchio campo «tailnet» nel file viene ignorato.
    #[serde(default)]
    pub server: String,
}

pub fn clean(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

impl Config {
    /// config.json nella cartella dell'app; CICCIO_APP_SERVER la scavalca (prove).
    pub fn load(dir: &PathBuf) -> Config {
        let file = dir.join("config.json");
        let mut cfg = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str::<Config>(&s).ok()).unwrap_or_else(|| {
            let cfg = Config::default();
            let _ = cfg.save(dir);
            cfg
        });
        if let Ok(s) = std::env::var("CICCIO_APP_SERVER") {
            cfg.server = s;
        }
        cfg.server = clean(&cfg.server);
        cfg
    }

    pub fn save(&self, dir: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("config.json"), serde_json::to_string_pretty(self).unwrap_or_default()).map_err(|e| e.to_string())
    }
}

fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

pub fn load_token() -> Option<String> {
    entry()?.get_password().ok().filter(|t| t.starts_with("cda_"))
}

pub fn save_token(token: &str) -> Result<(), String> {
    entry().ok_or("Portachiavi non disponibile")?.set_password(token).map_err(|e| format!("Portachiavi: {e}"))
}

pub fn forget_token() {
    if let Some(e) = entry() {
        let _ = e.delete_credential();
    }
}

/// Piattaforma come la conosce il manifest degli aggiornamenti (stesse chiavi del companion).
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "darwin-arm64" } else { "darwin-x64" }
    } else if cfg!(target_os = "windows") {
        "win32-x64"
    } else {
        "linux-x64"
    }
}

/// Nome del PC per l'elenco in Impostazioni › App («MacBook Pro di Giulia», «DESKTOP-1»).
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
        "Mac".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into())
    }
}

/// sha256 del token del companion di questo PC, se c'è: Ciccio così sa di non mandargli le notifiche.
/// Si legge solo il token per farne l'hash, che è quello che il server ha già nel database.
pub fn companion_hash() -> Option<String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let file = PathBuf::from(home).join(".ciccio-companion").join("config.json");
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let token = raw.get("token")?.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    Some(hex::encode(Sha256::digest(token.as_bytes())))
}
