// Collegamento con Ciccio: l'indirizzo (scelto al primo avvio), il token dell'app (codice da confermare
// nel browser), la sessione della finestra e la WebSocket degli avvisi (shared/desktop.ts).

use crate::{config, notify, set_ui, Shared};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().timeout(timeout).user_agent(format!("CiccioApp/{VERSION}")).build().expect("client http")
}

/// Indirizzo scritto nella pagina locale: https (http solo verso questo computer, per le prove), poi
/// GET /api/auth/state deve rispondere come Ciccio. Si salva in config.json e il collegamento riparte.
pub async fn set_server(sh: &Arc<Shared>, raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    let raw = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let u = url::Url::parse(&raw).map_err(|_| "Indirizzo non valido.".to_string())?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if u.scheme() != "https" && !(u.scheme() == "http" && local) {
        return Err("Serve un indirizzo https, per esempio https://ciccio.tuo-tailnet.ts.net".into());
    }
    if !sh.server().is_empty() {
        return Err("L'indirizzo di Ciccio è già impostato.".into());
    }
    let server = u.origin().ascii_serialization();
    let r = client(Duration::from_secs(10)).get(format!("{server}/api/auth/state")).send().await.map_err(|e| {
        if e.is_timeout() || e.is_connect() { format!("{server} non risponde: controlla l'indirizzo e la connessione.") } else { format!("Errore di rete: {e}") }
    })?;
    let v: Value = r.json().await.map_err(|_| "A questo indirizzo non risponde Ciccio.".to_string())?;
    if v.get("authenticated").is_none() {
        return Err("A questo indirizzo non risponde Ciccio.".into());
    }
    let cfg = config::Config { server: server.clone() };
    cfg.save(&sh.dir).map_err(|e| format!("Non riesco a salvare la configurazione: {e}"))?;
    // Un token rimasto nel Portachiavi è di un altro collegamento: non lo si manda al server nuovo.
    tokio::task::spawn_blocking(config::forget_token).await.ok();
    *sh.token.lock().unwrap() = None;
    *sh.server.lock().unwrap() = server;
    sh.server_ready.notify_one();
    Ok(())
}

fn token(sh: &Shared) -> Option<String> {
    sh.token.lock().unwrap().clone()
}

/// Token non più valido (app scollegata da Ciccio): si dimentica e si ricollega da capo.
pub fn forget(sh: &Arc<Shared>) {
    config::forget_token();
    *sh.token.lock().unwrap() = None;
    start(sh.clone(), None);
}

/// Finestra: token (se manca, collegamento), poi Ciccio con una sessione nuova. Una sola volta alla volta.
pub fn start(sh: Arc<Shared>, next: Option<String>) {
    if sh.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Primo avvio: prima si chiede l'indirizzo di Ciccio.
        if sh.server().is_empty() {
            set_ui(&sh, json!({ "fase": "server" }));
            while sh.server().is_empty() {
                sh.server_ready.notified().await;
            }
        }
        loop {
            match ensure_token(&sh).await {
                Ok(()) => match open_ciccio(&sh, next.clone()).await {
                    Ok(()) => break,
                    Err(Fail::Unauthorized) => {
                        config::forget_token();
                        *sh.token.lock().unwrap() = None;
                        continue;
                    }
                    Err(Fail::Other(e)) => set_ui(&sh, json!({ "fase": "errore", "testo": e })),
                },
                Err(e) => set_ui(&sh, json!({ "fase": "errore", "testo": e })),
            }
            // Si riprova da soli ogni 10 secondi, o subito con «Riprova».
            let _ = tokio::time::timeout(Duration::from_secs(10), sh.retry.notified()).await;
        }
        sh.starting.store(false, Ordering::SeqCst);
    });
}

enum Fail {
    Unauthorized,
    Other(String),
}

fn unreachable(e: reqwest::Error) -> String {
    if e.is_timeout() || e.is_connect() { "Ciccio non risponde: controlla la connessione.".into() } else { format!("Errore di rete: {e}") }
}

/// Codice monouso e finestra su DESKTOP_LOGIN_PATH: il server crea la sessione e porta alla pagina `next`.
async fn open_ciccio(sh: &Arc<Shared>, next: Option<String>) -> Result<(), Fail> {
    let Some(tok) = token(sh) else { return Err(Fail::Unauthorized) };
    if !sh.on_ciccio.load(Ordering::SeqCst) {
        set_ui(sh, json!({ "fase": "avvio", "testo": "Apro Ciccio…" }));
    }
    let r = client(Duration::from_secs(15)).post(format!("{}/desktop/session", sh.server())).bearer_auth(&tok).send().await.map_err(|e| Fail::Other(unreachable(e)))?;
    if r.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Fail::Unauthorized);
    }
    if !r.status().is_success() {
        return Err(Fail::Other(format!("Ciccio ha risposto {}", r.status())));
    }
    let v: Value = r.json().await.map_err(|e| Fail::Other(e.to_string()))?;
    let path = v.get("url").and_then(|u| u.as_str()).unwrap_or_default();
    let next = next.or_else(|| sh.pending_path.lock().unwrap().take()).unwrap_or_else(|| "/".into());
    let next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
    let target = url::Url::parse(&format!("{}{}&next={}", sh.server(), path, next)).map_err(|e| Fail::Other(e.to_string()))?;
    let w = crate::main_window(sh).ok_or_else(|| Fail::Other("finestra chiusa".into()))?;
    w.navigate(target).map_err(|e| Fail::Other(e.to_string()))?;
    Ok(())
}

/// Ciccio intercettato su /desktop/relogin (sessione scaduta nella finestra).
pub fn relogin(sh: Arc<Shared>, next: Option<String>) {
    tauri::async_runtime::spawn(async move {
        if let Err(Fail::Unauthorized) = open_ciccio(&sh, next.clone()).await {
            forget(&sh);
        } else if !sh.on_ciccio.load(Ordering::SeqCst) {
            start(sh.clone(), next);
        }
    });
}

async fn ensure_token(sh: &Arc<Shared>) -> Result<(), String> {
    if token(sh).is_some() {
        return Ok(());
    }
    if let Some(t) = tokio::task::spawn_blocking(config::load_token).await.ok().flatten() {
        *sh.token.lock().unwrap() = Some(t);
        sh.token_ready.notify_one();
        return Ok(());
    }
    set_ui(sh, json!({ "fase": "avvio", "testo": "Collego l'app a Ciccio…" }));
    let body = json!({ "name": config::device_name(), "platform": config::platform() });
    let http = client(Duration::from_secs(15));
    let tok = pair_with_code(sh, &http, &body).await?;
    config::save_token(&tok)?;
    *sh.token.lock().unwrap() = Some(tok);
    sh.token_ready.notify_one();
    Ok(())
}

/// Codice da confermare in Impostazioni › App (nel browser, con la passkey). Si aspetta finché arriva.
async fn pair_with_code(sh: &Arc<Shared>, http: &reqwest::Client, body: &Value) -> Result<String, String> {
    let server = sh.server();
    loop {
        let r = http.post(format!("{server}/desktop/pair")).json(body).send().await.map_err(unreachable)?;
        let v: Value = r.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let (Some(id), Some(code)) = (v.get("pairId").and_then(|x| x.as_str()), v.get("code").and_then(|x| x.as_str())) else {
            return Err("risposta non valida".into());
        };
        *sh.pair_url.lock().unwrap() = Some(format!("{server}/impostazioni#app"));
        set_ui(sh, json!({ "fase": "codice", "codice": code }));
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let r = match http.post(format!("{server}/desktop/pair/poll")).json(&json!({ "pairId": id })).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            if r.status() == reqwest::StatusCode::NOT_FOUND {
                break; // scaduto: codice nuovo
            }
            let Ok(v) = r.json::<Value>().await else { continue };
            if let Some(t) = v.get("token").and_then(|t| t.as_str()) {
                *sh.pair_url.lock().unwrap() = None;
                return Ok(t.to_string());
            }
        }
    }
}

// ── Avvisi ──────────────────────────────────────────────────────────────

fn ws_url(base: &str) -> String {
    let u = base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    format!("{u}/desktop")
}

/// Sempre acceso: si collega, riceve gli avvisi, si ricollega da solo (attesa crescente fino a 30 secondi).
pub async fn ws_loop(sh: Arc<Shared>) {
    let mut wait = 1u64;
    loop {
        let Some(tok) = token(&sh) else {
            sh.token_ready.notified().await;
            continue;
        };
        let base = sh.server();
        let mut req = match ws_url(&base).into_client_request() {
            Ok(r) => r,
            Err(_) => return,
        };
        req.headers_mut().insert("Authorization", format!("Bearer {tok}").parse().unwrap());
        req.headers_mut().insert("User-Agent", format!("CiccioApp/{VERSION}").parse().unwrap());
        match tokio_tungstenite::connect_async(req).await {
            Ok((ws, _)) => {
                wait = 1;
                if session(&sh, ws, &base).await == End::Unauthorized {
                    forget(&sh);
                }
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) if resp.status() == 401 => forget(&sh),
            Err(_) => {}
        }
        *sh.out.lock().unwrap() = None;
        sh.replies.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_secs(wait)).await;
        wait = (wait * 2).min(30);
    }
}

#[derive(PartialEq)]
enum End {
    Closed,
    Unauthorized,
}

async fn session(sh: &Arc<Shared>, ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, base: &str) -> End {
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *sh.out.lock().unwrap() = Some(tx);
    let hello = json!({ "jsonrpc": "2.0", "method": "desktop/hello", "params": { "version": VERSION, "platform": config::platform(), "companion": config::companion_hash() } });
    if write.send(Message::text(hello.to_string())).await.is_err() {
        return End::Closed;
    }
    loop {
        tokio::select! {
            m = tokio::time::timeout(Duration::from_secs(75), read.next()) => match m {
                // Il server manda un ping ogni 30 secondi: 75 secondi di silenzio = collegamento morto.
                Err(_) | Ok(None) | Ok(Some(Err(_))) => return End::Closed,
                Ok(Some(Ok(Message::Text(t)))) => on_message(sh, t.as_str(), base),
                Ok(Some(Ok(Message::Close(f)))) => {
                    return if f.map(|f| u16::from(f.code)) == Some(4001) { End::Unauthorized } else { End::Closed };
                }
                Ok(Some(Ok(_))) => {}
            },
            o = rx.recv() => {
                let Some(s) = o else { return End::Closed };
                if write.send(Message::text(s)).await.is_err() {
                    return End::Closed;
                }
            }
        }
    }
}

fn on_message(sh: &Arc<Shared>, raw: &str, base: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else { return };
    if let (Some(id), Some(result)) = (msg.get("id").and_then(|i| i.as_u64()), msg.get("result")) {
        if let Some(tx) = sh.replies.lock().unwrap().remove(&id) {
            let _ = tx.send(result.clone());
        }
        return;
    }
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    match msg.get("method").and_then(|m| m.as_str()) {
        Some("desktop/notify") => {
            if let Ok(n) = serde_json::from_value::<notify::Notice>(params) {
                notify::show(&n);
            }
        }
        Some("desktop/resolved") => {
            if let Some(id) = params.get("approvalId").and_then(|i| i.as_str()) {
                notify::resolved(id);
            }
        }
        Some("desktop/update") => {
            if let (Ok(u), Some(tok)) = (serde_json::from_value::<crate::update::Offer>(params), token(sh)) {
                let (sh, base) = (sh.clone(), base.to_string());
                tauri::async_runtime::spawn(async move { crate::update::offer(sh, u, base, tok).await });
            }
        }
        _ => {}
    }
}

/// Consenti o Rifiuta da una notifica. Il testo dell'errore finisce in una notifica.
pub async fn decide(sh: &Arc<Shared>, approval: &str, allow: bool) -> Result<String, String> {
    // Appena svegliato il Mac il collegamento può non esserci ancora: si aspetta qualche secondo.
    let mut out = None;
    for _ in 0..20 {
        out = sh.out.lock().unwrap().clone();
        if out.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let out = out.ok_or("Ciccio non è raggiungibile")?;
    let id = sh.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    sh.replies.lock().unwrap().insert(id, tx);
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "desktop/decide", "params": { "approvalId": approval, "allow": allow } });
    out.send(msg.to_string()).map_err(|_| "collegamento chiuso")?;
    let r = tokio::time::timeout(Duration::from_secs(15), rx).await.map_err(|_| "Ciccio non ha risposto")?.map_err(|_| "collegamento chiuso")?;
    let text = r.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    if r.get("ok") == Some(&Value::Bool(true)) { Ok(text) } else { Err(text) }
}
