// Ciccio, l'app desktop: una finestra con Ciccio (la web app del server) e le notifiche del sistema,
// con Consenti e Rifiuta per i permessi degli agenti. Il companion resta a parte, per gli strumenti del PC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod link;
mod notify;
mod update;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

pub struct Shared {
    pub app: AppHandle,
    /// Cartella di config.json.
    pub dir: std::path::PathBuf,
    /// Indirizzo di Ciccio (vuoto finché non lo si sceglie nella pagina locale).
    pub server: Mutex<String>,
    pub server_ready: tokio::sync::Notify,
    pub token: Mutex<Option<String>>,
    pub token_ready: tokio::sync::Notify,
    /// Messaggi verso Ciccio sulla WebSocket aperta (None se scollegati).
    pub out: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    pub replies: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    pub next_id: AtomicU64,
    /// Stato della pagina locale (collegamento, errori).
    pub ui: Mutex<Value>,
    pub retry: tokio::sync::Notify,
    pub starting: AtomicBool,
    /// La finestra mostra Ciccio (non la pagina locale).
    pub on_ciccio: AtomicBool,
    /// Chat da aprire appena Ciccio è caricato (clic su una notifica durante l'avvio).
    pub pending_path: Mutex<Option<String>>,
    pub pair_url: Mutex<Option<String>>,
    pub update: Mutex<Option<update::Staged>>,
    pub quitting: AtomicBool,
    pub windows: AtomicU64,
}

impl Shared {
    pub fn server(&self) -> String {
        self.server.lock().unwrap().clone()
    }
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

pub fn shared() -> Arc<Shared> {
    SHARED.get().expect("app avviata").clone()
}

pub fn main_window(sh: &Shared) -> Option<WebviewWindow> {
    sh.app.get_webview_window("main")
}

const LOCAL_PAGE: &str = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };

/// Stato per la pagina locale; per il codice di collegamento la finestra ci torna anche da Ciccio.
pub fn set_ui(sh: &Shared, v: Value) {
    let code = v.get("fase").and_then(|f| f.as_str()) == Some("codice");
    *sh.ui.lock().unwrap() = v.clone();
    let _ = sh.app.emit("ui", v);
    if code && sh.on_ciccio.load(Ordering::SeqCst) {
        if let (Some(w), Ok(u)) = (main_window(sh), url::Url::parse(LOCAL_PAGE)) {
            let _ = w.navigate(u);
        }
    }
}

fn same_origin(u: &url::Url, base: &str) -> bool {
    url::Url::parse(base).is_ok_and(|b| b.origin() == u.origin())
}

fn is_local(u: &url::Url) -> bool {
    u.scheme() == "tauri" || matches!(u.host_str(), Some("tauri.localhost" | "ipc.localhost"))
}

pub fn show_main(sh: &Shared) {
    if let Some(w) = main_window(sh) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Clic su una notifica: la finestra già aperta va sulla chat, senza ricaricare la pagina.
pub fn open_path(sh: &Arc<Shared>, path: Option<String>) {
    show_main(sh);
    let Some(path) = path.filter(|p| p.starts_with('/') && !p.starts_with("//") && !p.contains('\\')) else { return };
    if !sh.on_ciccio.load(Ordering::SeqCst) {
        *sh.pending_path.lock().unwrap() = Some(path);
        return;
    }
    let js = format!(
        "(p => {{ if (location.pathname !== p) {{ history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }} }})({})",
        Value::String(path)
    );
    if let Some(w) = main_window(sh) {
        let _ = w.eval(&js);
    }
}

// ── Comandi della pagina locale ─────────────────────────────────────────

#[tauri::command]
fn stato() -> Value {
    shared().ui.lock().unwrap().clone()
}

#[tauri::command]
fn apri_browser() {
    if let Some(u) = shared().pair_url.lock().unwrap().clone() {
        let _ = open::that_detached(u);
    }
}

#[tauri::command]
fn riprova() {
    shared().retry.notify_waiters();
}

/// Primo avvio: l'indirizzo di Ciccio scritto nella pagina locale. Si controlla che risponda come Ciccio.
#[tauri::command]
async fn imposta_server(indirizzo: String) -> Result<(), String> {
    link::set_server(&shared(), &indirizzo).await
}

// ── Finestre ────────────────────────────────────────────────────────────

fn build_main(app: &AppHandle, hidden: bool) -> tauri::Result<WebviewWindow> {
    let init = format!("window.__CICCIO_APP__ = {};", json!({ "version": link::VERSION, "platform": config::platform() }));
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Ciccio")
        .inner_size(1280.0, 860.0)
        .min_inner_size(400.0, 480.0)
        .center()
        .visible(!hidden)
        .background_color(tauri::window::Color(11, 11, 11, 255))
        // I file trascinati sulla finestra (allegati, immagini) li gestisce la pagina, come nel browser:
        // con il gestore di Tauri acceso la webview non riceve mai il drop.
        .disable_drag_drop_handler()
        .initialization_script(&init)
        .on_navigation(|u| {
            let sh = shared();
            // Sessione scaduta: la rifà l'app con il suo token (Auth.tsx manda qui).
            if same_origin(u, &sh.server()) && u.path() == "/desktop/relogin" {
                let next = u.query_pairs().find(|(k, _)| k == "next").map(|(_, v)| v.into_owned());
                link::relogin(sh.clone(), next);
                return false;
            }
            // Il resto passa: sul Mac questo controllo vale anche per gli iframe (anteprime, Office), che restano dentro.
            true
        })
        .on_new_window(|u, features| {
            let sh = shared();
            // Link esterni (target=_blank): nel browser del sistema.
            if !same_origin(&u, &sh.server()) {
                let _ = open::that_detached(u.as_str());
                return NewWindowResponse::Deny;
            }
            // Pagine di Ciccio (file a pagina intera): un'altra finestra dell'app, con la stessa sessione.
            let n = sh.windows.fetch_add(1, Ordering::SeqCst);
            match WebviewWindowBuilder::new(&sh.app, format!("pagina-{n}"), WebviewUrl::External(u.clone()))
                .window_features(features)
                .title("Ciccio")
                .on_document_title_changed(|w, t| { let _ = w.set_title(&t); })
                .build()
            {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .on_download(|w, ev| {
            match ev {
                DownloadEvent::Requested { url, destination } => {
                    let name = destination.file_name().map(|n| n.to_string_lossy().into_owned())
                        .or_else(|| url.path_segments().and_then(|mut s| s.next_back().map(String::from)))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "download".into());
                    if let Ok(dir) = w.app_handle().path().download_dir() {
                        *destination = unique(dir.join(name));
                    }
                }
                DownloadEvent::Finished { success, .. } => {
                    notify::simple("Ciccio", if success { "Download finito: è nella cartella Download." } else { "Download non riuscito." }, None);
                }
                _ => {}
            }
            true
        })
        .on_page_load(|w, p| {
            if p.event() != PageLoadEvent::Finished {
                return;
            }
            let sh = shared();
            let on = same_origin(p.url(), &sh.server());
            sh.on_ciccio.store(on, Ordering::SeqCst);
            if on {
                let _ = w.app_handle();
                let path = sh.pending_path.lock().unwrap().take();
                if path.is_some() {
                    open_path(&sh, path);
                }
            } else if is_local(p.url()) {
                // La pagina locale si è (ri)caricata: le si ridà lo stato.
                let _ = sh.app.emit("ui", sh.ui.lock().unwrap().clone());
            }
        })
        .build()
}

/// Download con lo stesso nome di un file già lì: «nome (2).ext».
fn unique(p: std::path::PathBuf) -> std::path::PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..1000).map(|i| p.with_file_name(format!("{stem} ({i}){ext}"))).find(|c| !c.exists()).unwrap_or(p)
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let ciccio = Submenu::with_items(app, "Ciccio", true, &[
        &PredefinedMenuItem::about(app, Some("Informazioni su Ciccio"), None)?,
        &PredefinedMenuItem::separator(app)?,
        &CheckMenuItem::with_id(app, "autostart", "Apri all'accesso", true, autostart, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some("Nascondi Ciccio"))?,
        &PredefinedMenuItem::hide_others(app, Some("Nascondi altre"))?,
        &PredefinedMenuItem::show_all(app, Some("Mostra tutte"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some("Esci da Ciccio"))?,
    ])?;
    let edit = Submenu::with_items(app, "Composizione", true, &[
        &PredefinedMenuItem::undo(app, Some("Annulla"))?,
        &PredefinedMenuItem::redo(app, Some("Ripeti"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, Some("Taglia"))?,
        &PredefinedMenuItem::copy(app, Some("Copia"))?,
        &PredefinedMenuItem::paste(app, Some("Incolla"))?,
        &PredefinedMenuItem::select_all(app, Some("Seleziona tutto"))?,
    ])?;
    let view = Submenu::with_items(app, "Vista", true, &[
        &MenuItem::with_id(app, "dashboard", "Dashboard", true, Some("CmdOrCtrl+Shift+D"))?,
        &MenuItem::with_id(app, "ricarica", "Ricarica", true, Some("CmdOrCtrl+R"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::fullscreen(app, Some("Schermo intero"))?,
    ])?;
    let window = Submenu::with_items(app, "Finestra", true, &[
        &PredefinedMenuItem::minimize(app, Some("Riduci"))?,
        &PredefinedMenuItem::maximize(app, Some("Ingrandisci"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::close_window(app, Some("Chiudi finestra"))?,
    ])?;
    Menu::with_items(app, &[&ciccio, &edit, &view, &window])
}

fn on_menu(app: &AppHandle, id: &str) {
    let sh = shared();
    match id {
        "apri" => show_main(&sh),
        "esci" => app.exit(0),
        "autostart" => {
            let al = app.autolaunch();
            let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
        }
        "dashboard" => {
            if sh.on_ciccio.load(Ordering::SeqCst) {
                open_path(&sh, Some("/".into()));
            } else {
                link::start(sh.clone(), None);
            }
        }
        "ricarica" => {
            if sh.on_ciccio.load(Ordering::SeqCst) {
                if let Some(w) = main_window(&sh) {
                    let _ = w.eval("location.reload()");
                }
            } else {
                sh.retry.notify_waiters();
            }
        }
        _ => {}
    }
}

/// Windows: l'icona nell'area di notifica tiene l'app accesa a finestra chiusa (per le notifiche).
#[cfg(windows)]
fn tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let m = Menu::with_items(app, &[
        &MenuItem::with_id(app, "apri", "Apri Ciccio", true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "autostart", "Avvia all'accesso", true, autostart, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "esci", "Esci", true, None::<&str>)?,
    ])?;
    TrayIconBuilder::with_id("ciccio")
        .icon(app.default_window_icon().cloned().expect("icona"))
        .tooltip("Ciccio")
        .menu(&m)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                let _ = tray;
                show_main(&shared());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Avvio all'accesso: in background, la finestra si apre dal Dock o dall'icona.
    let hidden = args.iter().any(|a| a == "--nascosta");
    let app = tauri::Builder::default()
        // Prima di tutto: la seconda copia passa i suoi argomenti a questa e si chiude.
        .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
            let sh = shared();
            if !argv.iter().skip(1).any(|a| notify::handle_url(a)) {
                show_main(&sh);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
            .with_denylist(&["pagina-0", "pagina-1", "pagina-2"])
            .build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--nascosta"])))
        .invoke_handler(tauri::generate_handler![stato, apri_browser, riprova, imposta_server])
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir = app.path().app_config_dir()?;
            let first_run = !dir.join("config.json").exists();
            let cfg = config::Config::load(&dir);
            let sh = Arc::new(Shared {
                app: handle.clone(),
                dir,
                server: Mutex::new(cfg.server),
                server_ready: tokio::sync::Notify::new(),
                // Letto dopo, fuori dall'avvio: dopo un aggiornamento macOS può chiedere la password del Portachiavi.
                token: Mutex::new(None),
                token_ready: tokio::sync::Notify::new(),
                out: Mutex::new(None),
                replies: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                ui: Mutex::new(json!({ "fase": "avvio", "testo": "Mi collego a Ciccio…" })),
                retry: tokio::sync::Notify::new(),
                starting: AtomicBool::new(false),
                on_ciccio: AtomicBool::new(false),
                pending_path: Mutex::new(None),
                pair_url: Mutex::new(None),
                update: Mutex::new(None),
                quitting: AtomicBool::new(false),
                windows: AtomicU64::new(0),
            });
            let _ = SHARED.set(sh.clone());
            // Le notifiche servono anche a finestra chiusa: la prima volta l'app si apre da sola all'accesso.
            if first_run {
                let _ = handle.autolaunch().enable();
            }
            notify::setup();
            if cfg!(target_os = "macos") {
                app.set_menu(menu(&handle)?)?;
                app.on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()));
            }
            #[cfg(windows)]
            {
                tray(&handle)?;
                app.on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()));
            }
            build_main(&handle, hidden)?;
            // Avviata da un clic su una notifica (Windows, ciccio-app://…).
            for a in args.iter().skip(1) {
                notify::handle_url(a);
            }
            link::start(sh.clone(), None);
            tauri::async_runtime::spawn(link::ws_loop(sh));
            Ok(())
        })
        .on_window_event(|w, ev| {
            // Chiudere la finestra principale la nasconde: l'app resta accesa per le notifiche.
            if let WindowEvent::CloseRequested { api, .. } = ev {
                let sh = shared();
                if w.label() == "main" && !sh.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = w.hide();
                    // Versione nuova pronta: con la finestra chiusa è il momento giusto.
                    update::apply(&sh, true);
                }
            }
            if let WindowEvent::Resized(_) = ev {
                // Ridotta a icona: anche questo va bene per aggiornarsi.
                if w.label() == "main" && w.is_minimized().unwrap_or(false) {
                    update::apply(&shared(), true);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("avvio di Ciccio");

    app.run(|app, ev| match ev {
        // Clic sull'icona nel Dock con la finestra chiusa.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(&shared()),
        RunEvent::ExitRequested { .. } => {
            let sh = shared();
            sh.quitting.store(true, Ordering::SeqCst);
            // All'uscita voluta si installa la versione pronta, senza riaprire.
            update::apply(&sh, false);
            let _ = app;
        }
        // ⌘Q e «Esci da Ciccio» nel menu del Mac chiudono l'app senza ExitRequested: si installa qui.
        RunEvent::Exit => {
            update::install(&shared(), false);
        }
        _ => {}
    });
}
