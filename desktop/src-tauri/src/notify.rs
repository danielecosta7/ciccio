// Notifiche del sistema: sul Mac UNUserNotificationCenter (notify_mac.m), su Windows i toast.
// Clic sulla notifica: la finestra già aperta va sulla chat. Pulsanti: la risposta va a Ciccio senza aprire niente.

use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Buttons {
    pub id: String,
    pub allow: String,
    pub deny: String,
}

/// DesktopNotify di shared/desktop.ts.
#[derive(Deserialize, Clone, Debug)]
pub struct Notice {
    pub id: String,
    pub title: String,
    pub body: String,
    pub path: String,
    pub approval: Option<Buttons>,
}

/// Cosa ha fatto l'utente sulla notifica.
pub enum Action {
    Open { path: Option<String> },
    Decide { approval: String, allow: bool, path: Option<String> },
}

pub fn handle(action: Action) {
    let sh = crate::shared();
    match action {
        Action::Open { path } => crate::open_path(&sh, path),
        Action::Decide { approval, allow, path } => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::link::decide(&sh, &approval, allow).await {
                    // Non è arrivata: lo dice, e il clic porta alla chat dove la card è ancora lì.
                    simple("Ciccio", &format!("Risposta non mandata: {e}"), Some(&path.unwrap_or_default()));
                }
            });
        }
    }
}

fn approval_ident(id: &str) -> String {
    format!("ap-{id}")
}

// ── Mac ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::{c_char, CStr, CString};

    extern "C" {
        fn ciccio_notify_setup(cb: extern "C" fn(*const c_char, *const c_char));
        fn ciccio_notify_show(ident: *const c_char, title: *const c_char, body: *const c_char, allow: *const c_char, deny: *const c_char, info: *const c_char);
        fn ciccio_notify_remove(ident: *const c_char);
    }

    fn cs(s: &str) -> CString {
        CString::new(s.replace('\0', "")).unwrap_or_default()
    }

    extern "C" fn on_action(action: *const c_char, info: *const c_char) {
        let action = unsafe { CStr::from_ptr(action) }.to_string_lossy().into_owned();
        let info: serde_json::Value = serde_json::from_str(&unsafe { CStr::from_ptr(info) }.to_string_lossy()).unwrap_or_default();
        let path = info.get("path").and_then(|p| p.as_str()).map(String::from);
        let approval = info.get("approval").and_then(|p| p.as_str()).map(String::from);
        match (action.as_str(), approval) {
            ("allow" | "deny", Some(approval)) => handle(Action::Decide { approval, allow: action == "allow", path }),
            ("open", _) => handle(Action::Open { path }),
            _ => {}
        }
    }

    pub fn setup() {
        unsafe { ciccio_notify_setup(on_action) }
    }

    pub fn show(n: &Notice) {
        let info = serde_json::json!({ "path": n.path, "approval": n.approval.as_ref().map(|b| b.id.clone()) }).to_string();
        let ident = n.approval.as_ref().map(|b| approval_ident(&b.id)).unwrap_or_else(|| format!("n-{}", n.id));
        let (ident, title, body, info) = (cs(&ident), cs(&n.title), cs(&n.body), cs(&info));
        let (allow, deny) = match &n.approval {
            Some(b) => (Some(cs(&b.allow)), Some(cs(&b.deny))),
            None => (None, None),
        };
        let ptr = |c: &Option<CString>| c.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null());
        unsafe { ciccio_notify_show(ident.as_ptr(), title.as_ptr(), body.as_ptr(), ptr(&allow), ptr(&deny), info.as_ptr()) }
    }

    pub fn remove(ident: &str) {
        let c = cs(ident);
        unsafe { ciccio_notify_remove(c.as_ptr()) }
    }

    /// Mac: i clic arrivano dal delegate, non da indirizzi.
    pub fn handle_url(_url: &str) -> bool {
        false
    }
}

// ── Windows ─────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    pub const AUMID: &str = "it.costa.ciccio";
    pub const SCHEME: &str = "ciccio-app";

    /// Pulsanti mostrati da questa copia dell'app: un indirizzo ciccio-app:// vale solo con il suo nonce,
    /// così un sito che apre ciccio-app://decidi?… non può rispondere al posto dell'utente.
    static NONCES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }

    fn enc(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }

    /// Identità per i toast (come il companion: senza pacchetto Windows vuole un AppUserModelID registrato)
    /// e l'indirizzo ciccio-app:// che riapre questa app con il clic o il pulsante.
    pub fn setup() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        if let Ok((k, _)) = hkcu.create_subkey(format!(r"Software\Classes\AppUserModelId\{AUMID}")) {
            let _ = k.set_value("DisplayName", &"Ciccio");
            if let Some(icon) = icon_file() {
                let _ = k.set_value("IconUri", &icon);
            }
        }
        if let Ok((k, _)) = hkcu.create_subkey(format!(r"Software\Classes\{SCHEME}")) {
            let _ = k.set_value("", &"URL:Ciccio");
            let _ = k.set_value("URL Protocol", &"");
            if let Ok((cmd, _)) = k.create_subkey(r"shell\open\command") {
                let _ = cmd.set_value("", &format!("\"{exe}\" \"%1\""));
            }
        }
    }

    fn icon_file() -> Option<String> {
        let dir = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("it.costa.ciccio");
        let file = dir.join("ciccio.png");
        if !file.exists() {
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::write(&file, include_bytes!("../icons/128x128.png")).ok()?;
        }
        Some(file.display().to_string())
    }

    fn tag_of(ident: &str) -> String {
        ident.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(60).collect()
    }

    pub fn show(n: &Notice) {
        let open = format!("{SCHEME}://apri?path={}", enc(&n.path));
        let mut actions = String::new();
        if let Some(b) = &n.approval {
            let nonce: String = {
                use rand::Rng;
                rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(24).map(char::from).collect()
            };
            NONCES.lock().unwrap().get_or_insert_with(HashMap::new).insert(nonce.clone(), b.id.clone());
            let url = |allow: bool| format!("{SCHEME}://decidi?a={}&si={}&n={}&path={}", enc(&b.id), allow as u8, nonce, enc(&n.path));
            actions = format!(
                r#"<actions><action content="{}" activationType="protocol" arguments="{}"/><action content="{}" activationType="protocol" arguments="{}"/></actions>"#,
                esc(&b.allow), esc(&url(true)), esc(&b.deny), esc(&url(false))
            );
        }
        let xml = format!(
            r#"<toast activationType="protocol" launch="{}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{}</toast>"#,
            esc(&open), esc(&n.title), esc(&n.body), actions
        );
        let ident = n.approval.as_ref().map(|b| approval_ident(&b.id)).unwrap_or_else(|| format!("n-{}", n.id));
        let _ = (|| -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml))?;
            let toast = ToastNotification::CreateToastNotification(&doc)?;
            toast.SetTag(&HSTRING::from(tag_of(&ident)))?;
            toast.SetGroup(&HSTRING::from("ciccio"))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
        })();
    }

    pub fn remove(ident: &str) {
        let _ = (|| -> windows::core::Result<()> {
            ToastNotificationManager::History()?.RemoveGroupedTagWithId(&HSTRING::from(tag_of(ident)), &HSTRING::from("ciccio"), &HSTRING::from(AUMID))
        })();
    }

    /// ciccio-app://apri?path=… o ciccio-app://decidi?a=…&si=1&n=…&path=… (argomento della seconda copia).
    pub fn handle_url(raw: &str) -> bool {
        let Ok(u) = url::Url::parse(raw) else { return false };
        if u.scheme() != SCHEME {
            return false;
        }
        let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
        let path = q.get("path").cloned();
        match u.host_str() {
            Some("decidi") => {
                let approval = q.get("a").cloned().unwrap_or_default();
                let known = q.get("n").and_then(|n| NONCES.lock().unwrap().as_mut().and_then(|m| m.remove(n)));
                if known.as_deref() == Some(approval.as_str()) {
                    handle(Action::Decide { approval, allow: q.get("si").map(String::as_str) == Some("1"), path });
                } else {
                    // Pulsante di una notifica di prima (app riavviata) o sconosciuto: si apre la chat, dove la card c'è ancora.
                    handle(Action::Open { path });
                }
            }
            _ => handle(Action::Open { path }),
        }
        true
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;
    pub fn setup() {}
    pub fn show(_n: &Notice) {}
    pub fn remove(_ident: &str) {}
    pub fn handle_url(_url: &str) -> bool {
        false
    }
}

pub fn setup() {
    imp::setup()
}

pub fn show(n: &Notice) {
    imp::show(n)
}

/// Permesso deciso altrove: la sua notifica sparisce.
pub fn resolved(approval_id: &str) {
    imp::remove(&approval_ident(approval_id))
}

/// Avviso dell'app stessa (risposta non arrivata, download finito): solo il clic.
pub fn simple(title: &str, body: &str, path: Option<&str>) {
    let id = format!("app-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    imp::show(&Notice { id, title: title.into(), body: body.into(), path: path.unwrap_or("").into(), approval: None })
}

/// Indirizzo ciccio-app:// (Windows) passato all'avvio o dalla seconda copia; true se era uno dei nostri.
pub fn handle_url(url: &str) -> bool {
    imp::handle_url(url)
}
