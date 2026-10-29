import AppKit
import ServiceManagement
import UserNotifications

// Ciccio Companion per Mac: app nella barra dei menu che tiene acceso il companion
// (binario incluso nel pacchetto) e ne mostra lo stato. Si abbina da Ciccio con un link
// ciccio-companion://pair, accettato solo dopo conferma: se il Mac è già collegato, solo verso il suo server.

let agentLabel = "it.costa.ciccio-companion.app"
let oldCliLabel = "it.costa.ciccio-companion"
let bundleID = "it.costa.ciccio-companion.app"

/// Riga nel registro condiviso con il companion (~/Library/Logs/ciccio-companion.log, in coda con O_APPEND).
/// Funzione libera: la usano anche il gestore delle eccezioni e la sorveglianza del thread principale.
func appLog(_ line: String) {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ciccio-companion.log").path
    guard let data = "\(f.string(from: Date())) \(line)\n".data(using: .utf8) else { return }
    let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard fd >= 0 else { return }
    let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    h.write(data)
}

/// Chi ha mandato l'ultimo SIGTERM (si_pid), scritto dal gestore del segnale e letto quando si chiude.
var lastTermSender: pid_t = 0

func processName(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 256)
    proc_name(pid, &buf, UInt32(buf.count))
    let name = String(cString: buf)
    return name.isEmpty ? "pid \(pid)" : "\(name) (pid \(pid))"
}

/// Sorveglianza del thread principale: se per più di 5 secondi non risponde, lo scrive nel registro e salva
/// con /usr/bin/sample dove si è fermato (~/Library/Logs/ciccio-companion-blocco-*.txt), al massimo una volta ogni
/// 10 minuti; quando si sblocca scrive dopo quanto. Gira su un thread suo: il principale bloccato non la ferma.
final class MainThreadWatchdog {
    private let lock = NSLock()
    private var lastBeat = Date()
    private var blockedSince: Date?
    private var lastSample = Date.distantPast

    func start() {
        let t = Thread { [weak self] in
            while let self {
                DispatchQueue.main.async { self.beat() }
                Thread.sleep(forTimeInterval: 1)
                self.check()
            }
        }
        t.name = "sorveglianza thread principale"
        t.qualityOfService = .utility
        t.start()
    }

    private func beat() {
        lock.lock(); let was = blockedSince; blockedSince = nil; lastBeat = Date(); lock.unlock()
        if let was { appLog("app: thread principale di nuovo libero dopo \(Int(Date().timeIntervalSince(was) + 5)) s") }
    }

    private func check() {
        lock.lock()
        let late = Date().timeIntervalSince(lastBeat)
        let first = late > 5 && blockedSince == nil
        if first { blockedSince = lastBeat }
        let sample = first && Date().timeIntervalSince(lastSample) > 600
        if sample { lastSample = Date() }
        lock.unlock()
        guard first else { return }
        appLog("app: thread principale bloccato da \(Int(late)) s")
        guard sample else { return }
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        let out = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/ciccio-companion-blocco-\(f.string(from: Date())).txt").path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        p.arguments = [String(getpid()), "3", "-mayDie", "-file", out]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil { appLog("app: dove si è fermato, in \(out)") }
    }
}

/// Una notifica lasciata dal companion in ~/.ciccio-companion/notify (NotifyParams in shared/companion.ts).
struct PendingNotification: Decodable { let id: String; let title: String; let body: String; let url: String }

struct ServerState: Decodable { let name: String; let status: String; let tools: Int; let error: String? }
struct UpdateInfo: Decodable { let version: String; let path: String }
struct Status: Decodable {
    let connected: Bool
    let device: String?
    let server: String
    let problem: String
    let rejected: Bool
    let servers: [ServerState]
    let update: UpdateInfo?
    let updatedAt: Double
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private var item: NSStatusItem!
    private var child: Process?
    private var stopping = false
    /** Ricollega chiesto: quando il companion esce, riparte subito. */
    private var restartPending = false
    /** Avvio in corso (prima si chiude un eventuale companion rimasto acceso da solo). */
    private var starting = false
    private var termSignal: DispatchSourceSignal?
    /** Aggiornamento in installazione: si fa una volta sola. */
    private var updating = false
    /** Stato del permesso di notifica, letto all'avvio e a ogni apertura della finestra dei permessi. */
    private var notifyAuth: UNAuthorizationStatus = .notDetermined
    private var permissions: PermissionsWindow?
    /** Chiusa da fuori (Impostazioni di Sistema, Monitoraggio Attività…): si riapre da sola. */
    private var relaunchAfterQuit = false
    private var restartDelay = 1.0
    /// Perché l'app si sta chiudendo: si scrive nel registro alla chiusura («motivo sconosciuto» se manca).
    private var quitReason: String?
    private let watchdog = MainThreadWatchdog()
    private var timer: Timer?
    private let fm = FileManager.default

    private var home: URL { fm.homeDirectoryForCurrentUser }
    private var configDir: URL { home.appendingPathComponent(".ciccio-companion") }
    private var configFile: URL { configDir.appendingPathComponent("config.json") }
    private var statusFile: URL { configDir.appendingPathComponent("status.json") }
    private var notifyDir: URL { configDir.appendingPathComponent("notify") }
    private var logFile: URL { home.appendingPathComponent("Library/Logs/ciccio-companion.log") }
    private var agentPlist: URL { home.appendingPathComponent("Library/LaunchAgents/\(agentLabel).plist") }
    private var binary: String { Bundle.main.resourceURL!.appendingPathComponent("ciccio-companion").path }

    // MARK: avvio

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = pixelIcon(dim: true)
        item.button?.toolTip = "Ciccio Companion"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        removeOldCliAgent()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        appLog("app avviata (versione \(version), pid \(getpid()))")
        // Acceso all'avvio, spento solo dalla chiusura normale: se è ancora acceso, la volta prima l'app è
        // stata chiusa di colpo (a forza, o un crash senza rapporto).
        if UserDefaults.standard.bool(forKey: "running") { appLog("app: la volta prima si è chiusa di colpo, senza la sua uscita normale") }
        UserDefaults.standard.set(true, forKey: "running")
        NSSetUncaughtExceptionHandler { e in
            appLog("app: eccezione non gestita \(e.name.rawValue): \(e.reason ?? "")\n\(e.callStackSymbols.prefix(15).joined(separator: "\n"))")
        }
        watchdog.start()
        // Chiusa con un segnale (logout, kill): si esce bene, chiudendo anche il companion. Il gestore C annota
        // solo chi l'ha mandato; l'uscita la fa la sorgente di dispatch, sul thread principale.
        var action = sigaction()
        action.sa_flags = SA_SIGINFO
        action.__sigaction_u.__sa_sigaction = { _, info, _ in if let info { lastTermSender = info.pointee.si_pid } }
        sigaction(SIGTERM, &action, nil)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in
            let from = lastTermSender > 0 ? processName(lastTermSender) : "mittente sconosciuto"
            self?.quitReason = self?.quitReason ?? "segnale SIGTERM da \(from)"
            NSApp.terminate(nil)
        }
        term.resume()
        termSignal = term
        // Alla prima apertura si accende da solo all'accesso: è un servizio, deve esserci sempre.
        if !UserDefaults.standard.bool(forKey: "loginConfigured") {
            setLaunchAtLogin(true)
            UserDefaults.standard.set(true, forKey: "loginConfigured")
        }
        UNUserNotificationCenter.current().delegate = self
        refreshNotifyAuth()
        startChild()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshIcon() }
        // Prima apertura: prima i permessi, poi (se serve) come collegarsi a Ciccio.
        if !UserDefaults.standard.bool(forKey: "permissionsGuideShown") {
            UserDefaults.standard.set(true, forKey: "permissionsGuideShown")
            showPermissions { [weak self] in if self?.paired() == false { self?.showPairHelp() } }
        } else if !paired() { showPairHelp() }
    }

    /// Chi chiede di chiudere l'app? «Esci» dal menu non passa da qui con un evento: nessuna riapertura.
    /// Un «Quit» mandato da un altro processo sì (per esempio macOS quando si cambia «Consenti in
    /// background» in Elementi di login): l'app è un servizio e si riapre. Logout, riavvio e
    /// spegnimento arrivano da loginwindow: lì si chiude e basta.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let ev = NSAppleEventManager.shared().currentAppleEvent, ev.eventID == AEEventID(kAEQuitApplication),
           let pid = ev.attributeDescriptor(forKeyword: AEKeyword(keySenderPIDAttr))?.int32Value, pid != getpid() {
            var buf = [CChar](repeating: 0, count: 256)
            proc_name(pid, &buf, UInt32(buf.count))
            let name = String(cString: buf)
            appendLog("app chiusa da \(name.isEmpty ? "pid \(pid)" : name)")
            quitReason = quitReason ?? "richiesta di uscita da \(processName(pid))"
            if name != "loginwindow" { relaunchAfterQuit = true }
        }
        return .terminateNow
    }

    private func appendLog(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        guard let data = "\(f.string(from: Date())) \(line)\n".data(using: .utf8), let h = appendHandle() else { return }
        h.write(data)
        try? h.close()
    }

    /// Registro aperto in coda (O_APPEND): app e companion scrivono nello stesso file senza sovrascriversi.
    private func appendHandle() -> FileHandle? {
        let fd = open(logFile.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        return fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
    }

    func applicationWillTerminate(_ notification: Notification) {
        appLog("app chiusa: \(quitReason ?? "motivo sconosciuto")")
        UserDefaults.standard.set(false, forKey: "running")
        if relaunchAfterQuit {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "sleep 3; /usr/bin/open -g \"$1\"", "sh", Bundle.main.bundlePath]
            try? p.run()
        }
        stopping = true
        guard let p = child else { return }
        p.terminate()
        // Al massimo 3 secondi, poi si chiude a forza: l'uscita non resta mai appesa.
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // MARK: companion

    private func paired() -> Bool {
        guard let data = try? Data(contentsOf: configFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else { return false }
        return token.hasPrefix("ccp_")
    }

    /// Indirizzo di Ciccio nella config, nil finché il Mac non è mai stato collegato.
    private func serverURL() -> String? {
        guard let data = try? Data(contentsOf: configFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = json["server"] as? String else { return nil }
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return t.isEmpty ? nil : t
    }

    private func startChild() {
        guard child == nil, !starting, paired() else { return }
        starting = true
        // Un companion rimasto acceso da solo (app chiusa a forza) terrebbe il posto e il nuovo non partirebbe:
        // prima gli si chiede di chiudersi, fuori dal thread principale perché può volerci qualche secondo.
        let bin = binary
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let stop = Process()
            stop.executableURL = URL(fileURLWithPath: bin)
            stop.arguments = ["stop"]
            stop.standardOutput = FileHandle.nullDevice
            stop.standardError = FileHandle.nullDevice
            if (try? stop.run()) != nil { stop.waitUntilExit() }
            DispatchQueue.main.async {
                guard let self else { return }
                self.starting = false
                self.launchChild()
            }
        }
    }

    private func launchChild() {
        guard child == nil, !stopping, paired() else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["run"]
        var env = ProcessInfo.processInfo.environment
        // Da un'app il PATH è minimo: servono Homebrew e /usr/local per npx e node (Chrome).
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        // Il companion sa che c'è l'app dell'icona: solo lei mostra le notifiche.
        env["CICCIO_COMPANION_TRAY"] = "1"
        p.environment = env
        // Il registro si allunga, non si riscrive a ogni avvio: resta anche quello che è successo prima.
        if let h = appendHandle() {
            p.standardOutput = h
            p.standardError = h
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.child === p else { return }
                self.child = nil
                if self.restartPending {
                    self.restartPending = false
                    self.restartDelay = 1
                    self.startChild()
                    self.refreshIcon()
                    return
                }
                if self.stopping { return }
                // Si riavvia da solo, con attesa crescente fino a 30 secondi.
                let wait = self.restartDelay
                self.restartDelay = min(self.restartDelay * 2, 30)
                DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.startChild() }
            }
        }
        do {
            try p.run()
            child = p
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in if self?.child === p { self?.restartDelay = 1 } }
        } catch {
            alert("Il companion non parte", error.localizedDescription)
        }
    }

    /// Mai aspettare il companion sul thread principale: se non esce, il menu resterebbe bloccato.
    /// Si chiede l'uscita e riparte quando il processo è finito (terminationHandler).
    private func restartChild() {
        restartDelay = 1
        try? fm.removeItem(at: statusFile)
        guard let p = child else { if !starting { startChild() }; refreshIcon(); return }
        restartPending = true
        p.terminate()
        // Se dopo 5 secondi è ancora vivo, si chiude a forza.
        let pid = p.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.child === p, p.isRunning { kill(pid, SIGKILL) }
        }
        refreshIcon()
    }

    private func readStatus() -> Status? {
        guard child != nil, let data = try? Data(contentsOf: statusFile) else { return nil }
        return try? JSONDecoder().decode(Status.self, from: data)
    }

    // MARK: abbinamento

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let comps = URLComponents(string: raw), comps.host == "pair" else { return }
        let q = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let token = q["token"] ?? ""
        let server = (q["server"] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard token.hasPrefix("ccp_"), token.count > 20 else { alert("Link non valido", "Il link di abbinamento non contiene un token valido."); return }
        // Un link da un altro sito non può dirottare gli strumenti di questo Mac: se è già collegato vale
        // solo il suo server; la prima volta solo https, e l'indirizzo è nella conferma.
        guard let u = URL(string: server), let host = u.host,
              u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else {
            alert("Server non riconosciuto", "Il link non contiene un indirizzo https valido."); return
        }
        let current = serverURL()
        if let current, current.lowercased() != server.lowercased() {
            alert("Server non riconosciuto", "Questo Mac è collegato a \(URL(string: current)?.host ?? current), il link è per \(host). Per cambiare server: ciccio-companion init <token> --server <indirizzo> dal Terminale.")
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        if current == nil {
            a.messageText = "Collegare questo Mac a \(host)?"
            a.informativeText = "Collega solo se \(host) è l'indirizzo del tuo Ciccio: gli agenti di quel server potranno usare Affinity e Chrome di questo Mac, sempre con i permessi della chat."
        } else {
            a.messageText = "Collegare questo Mac a Ciccio?"
            a.informativeText = "Gli agenti potranno usare Affinity e Chrome di questo Mac (\(host)), sempre con i permessi della chat."
        }
        a.addButton(withTitle: "Collega")
        a.addButton(withTitle: "Annulla")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["init", token, "--server", server]
        p.standardOutput = FileHandle.nullDevice
        let err = Pipe()
        p.standardError = err
        do { try p.run(); p.waitUntilExit() } catch { alert("Abbinamento non riuscito", error.localizedDescription); return }
        guard p.terminationStatus == 0 else {
            alert("Abbinamento non riuscito", String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
            return
        }
        restartChild()
        notify("Mac collegato a Ciccio", "Trovi lo stato nell'icona in alto a destra.")
    }

    private func showPairHelp() {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Collega Ciccio Companion"
        // Prima volta: l'indirizzo di Ciccio non lo sappiamo ancora, lo apri tu nel browser.
        guard serverURL() != nil else {
            a.informativeText = "Apri il tuo Ciccio nel browser, vai in Impostazioni › Companion e premi «Collega questo Mac»."
            _ = a.runModal()
            return
        }
        a.informativeText = "Apri Ciccio › Impostazioni › Companion e premi «Collega questo Mac»."
        a.addButton(withTitle: "Apri Ciccio")
        a.addButton(withTitle: "Più tardi")
        if a.runModal() == .alertFirstButtonReturn { openCiccio() }
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let title = NSMenuItem(title: "Ciccio Companion", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        let st = readStatus()
        if !paired() {
            menu.addItem(info("Non ancora collegato"))
            menu.addItem(action("Collega a Ciccio…", #selector(pairHelp)))
        } else if let st, st.connected {
            menu.addItem(info("● Collegato come «\(st.device ?? "mac")»"))
            for s in st.servers {
                let line = s.status == "online" ? "\(s.name): \(s.tools) strumenti" : "\(s.name): non disponibile"
                menu.addItem(info("    \(line)"))
            }
        } else {
            let why = st?.problem.isEmpty == false ? st!.problem : "In collegamento…"
            menu.addItem(info("○ \(why.prefix(80))"))
        }
        menu.addItem(.separator())
        menu.addItem(action("Apri Ciccio", #selector(openCiccio)))
        if paired() { menu.addItem(action("Ricollega", #selector(reconnect))) }
        let login = action("Avvia all'accesso", #selector(toggleLogin))
        login.state = fm.fileExists(atPath: agentPlist.path) ? .on : .off
        menu.addItem(login)
        let notes = action("Notifiche di Ciccio", #selector(toggleNotifications))
        notes.state = notificationsOn() ? .on : .off
        menu.addItem(notes)
        let missing = missingPermissions()
        menu.addItem(action(missing > 0 ? "Permessi… (\(missing) da attivare)" : "Permessi…", #selector(openPermissions)))
        menu.addItem(action("Strumenti esposti…", #selector(openConfig)))
        menu.addItem(action("Registro", #selector(openLog)))
        menu.addItem(.separator())
        let quit = action("Esci", #selector(quitFromMenu))
        quit.keyEquivalent = "q"
        menu.addItem(quit)
    }

    private func info(_ s: String) -> NSMenuItem { let i = NSMenuItem(title: s, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
    private func action(_ s: String, _ sel: Selector) -> NSMenuItem { let i = NSMenuItem(title: s, action: sel, keyEquivalent: ""); i.target = self; return i }

    @objc private func pairHelp() { showPairHelp() }
    @objc private func openCiccio() {
        guard let s = serverURL(), let u = URL(string: s) else { showPairHelp(); return }
        NSWorkspace.shared.open(u)
    }
    @objc private func reconnect() { restartChild() }
    @objc private func toggleLogin() { setLaunchAtLogin(!fm.fileExists(atPath: agentPlist.path)) }
    @objc private func openConfig() {
        if fm.fileExists(atPath: configFile.path) { NSWorkspace.shared.open([configFile], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"), configuration: NSWorkspace.OpenConfiguration()) }
        else { alert("Ancora niente da mostrare", "La configurazione nasce quando colleghi il Mac a Ciccio.") }
    }
    @objc private func openLog() { NSWorkspace.shared.open(logFile) }

    @objc private func quitFromMenu() {
        quitReason = "«Esci» dal menu"
        NSApp.terminate(nil)
    }

    private func refreshIcon() {
        deliverNotifications()
        let st = readStatus()
        if let u = st?.update { installUpdate(u) }
        let on = st?.connected == true
        item.button?.image = pixelIcon(dim: !on)
        item.button?.toolTip = on ? "Ciccio Companion · collegato" : "Ciccio Companion · non collegato"
        if child == nil && paired() && !stopping && !restartPending { startChild() }
    }

    // MARK: notifiche

    /// Opzione «Notifiche di Ciccio» (config.json, notifications: predefinita accesa).
    private func notificationsOn() -> Bool {
        guard let data = try? Data(contentsOf: configFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
        return (json["notifications"] as? Bool) ?? true
    }

    @objc private func toggleNotifications() {
        guard var json = (try? Data(contentsOf: configFile)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else {
            alert("Ancora niente da cambiare", "Le notifiche si attivano dopo che hai collegato il Mac a Ciccio.")
            return
        }
        let on = !notificationsOn()
        json["notifications"] = on
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: configFile, options: .atomic)
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFile.path)
        }
        if on && notifyAuth == .notDetermined { requestNotifications() }
        if on && notifyAuth == .denied { showPermissions(nil) }
        restartChild()
    }

    /// Per la finestra dei permessi: rilegge lo stato e lo passa.
    func refreshNotifyAuthPublic(_ done: @escaping (UNAuthorizationStatus) -> Void) {
        refreshNotifyAuth { [weak self] in done(self?.notifyAuth ?? .notDetermined) }
    }

    private func refreshNotifyAuth(_ done: (() -> Void)? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            DispatchQueue.main.async { [weak self] in
                self?.notifyAuth = s.authorizationStatus
                done?()
            }
        }
    }

    func requestNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            DispatchQueue.main.async { [weak self] in self?.refreshNotifyAuth { self?.permissions?.refresh() } }
        }
    }

    /// Mostra le notifiche lasciate dal companion e cancella i file; quelle di più di 10 minuti fa si scartano.
    private func deliverNotifications() {
        guard let files = try? fm.contentsOfDirectory(at: notifyDir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for f in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            defer { try? fm.removeItem(at: f) }
            let date = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
            guard Date().timeIntervalSince(date) < 600, notificationsOn(),
                  let data = try? Data(contentsOf: f), let n = try? JSONDecoder().decode(PendingNotification.self, from: data) else { continue }
            let content = UNMutableNotificationContent()
            content.title = n.title
            content.body = n.body
            content.sound = .default
            content.userInfo = ["url": n.url]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "ciccio-\(n.id)", content: content, trigger: nil))
        }
    }

    // L'app è nella barra dei menu: le notifiche si mostrano anche quando è "in primo piano".
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // Clic sulla notifica: si apre la chat dell'agente in Ciccio.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s),
           url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }

    // MARK: permessi

    /// Avvio in background: con il LaunchAgent, macOS chiede di consentirlo in Elementi di login.
    func loginItemStatus() -> SMAppService.Status {
        guard fm.fileExists(atPath: agentPlist.path) else { return .notRegistered }
        return SMAppService.statusForLegacyPlist(at: agentPlist)
    }

    func notificationsAllowed() -> Bool { notifyAuth == .authorized || notifyAuth == .provisional }

    private func missingPermissions() -> Int {
        var n = 0
        if notificationsOn() && !notificationsAllowed() { n += 1 }
        if fm.fileExists(atPath: agentPlist.path) && loginItemStatus() != .enabled { n += 1 }
        return n
    }

    @objc private func openPermissions() { showPermissions(nil) }

    private func showPermissions(_ onClose: (() -> Void)?) {
        refreshNotifyAuth { [weak self] in
            guard let self else { return }
            if self.permissions == nil { self.permissions = PermissionsWindow(app: self) }
            self.permissions?.onClose = onClose
            self.permissions?.show()
        }
    }

    /// Pagina esatta delle Impostazioni di Sistema per le notifiche di questa app.
    func openNotificationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleID)")!)
    }

    func openLoginItemsSettings() { SMAppService.openSystemSettingsLoginItems() }

    // MARK: aggiornamento automatico

    /// Il companion ha scaricato e controllato (sha256 e firma Ed25519 della release, in update.ts) lo zip della versione nuova dell'app:
    /// si scompatta accanto, uno script aspetta che l'app sia chiusa, scambia le cartelle e la riapre.
    private func installUpdate(_ u: UpdateInfo) {
        guard !updating, fm.fileExists(atPath: u.path) else { return }
        updating = true
        let bundle = Bundle.main.bundlePath
        let stage = configDir.appendingPathComponent("updates/stage-\(u.version)").path
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            try? self.fm.removeItem(atPath: stage)
            let unzip = Process()
            unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            unzip.arguments = ["-x", "-k", u.path, stage]
            let ok = (try? unzip.run()) != nil && { unzip.waitUntilExit(); return unzip.terminationStatus == 0 }()
            let newApp = stage + "/Ciccio Companion.app"
            guard ok, self.fm.fileExists(atPath: newApp + "/Contents/MacOS/CiccioCompanion") else {
                try? self.fm.removeItem(atPath: u.path)
                DispatchQueue.main.async { self.updating = false }
                return
            }
            // Se lo scambio non riesce si rimette la versione vecchia; in ogni caso l'app si riapre.
            let script = """
            while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
            rm -rf "$2.old"
            if mv "$2" "$2.old" && mv "$3" "$2"; then rm -rf "$2.old"; else [ -d "$2" ] || mv "$2.old" "$2"; fi
            rm -rf "$4" "$5"
            open "$2"
            """
            let swap = Process()
            swap.executableURL = URL(fileURLWithPath: "/bin/sh")
            swap.arguments = ["-c", script, "sh", String(getpid()), bundle, newApp, stage, u.path]
            swap.standardOutput = FileHandle.nullDevice
            swap.standardError = FileHandle.nullDevice
            DispatchQueue.main.async {
                guard (try? swap.run()) != nil else { self.updating = false; return }
                self.quitReason = "aggiornamento alla versione \(u.version)"
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: avvio all'accesso (LaunchAgent che apre l'app)

    private func setLaunchAtLogin(_ on: Bool) {
        let uid = getuid()
        launchctl(["bootout", "gui/\(uid)/\(agentLabel)"])
        if on {
            let plist: [String: Any] = [
                "Label": agentLabel,
                "ProgramArguments": ["/usr/bin/open", "-g", "-a", Bundle.main.bundlePath],
                "RunAtLoad": true,
            ]
            try? fm.createDirectory(at: agentPlist.deletingLastPathComponent(), withIntermediateDirectories: true)
            (plist as NSDictionary).write(to: agentPlist, atomically: true)
        } else {
            try? fm.removeItem(at: agentPlist)
        }
    }

    /// Il companion installato a mano dal terminale terrebbe lo stesso token: si toglie per non litigare.
    private func removeOldCliAgent() {
        let old = home.appendingPathComponent("Library/LaunchAgents/\(oldCliLabel).plist")
        guard fm.fileExists(atPath: old.path) else { return }
        launchctl(["bootout", "gui/\(getuid())/\(oldCliLabel)"])
        try? fm.removeItem(at: old)
    }

    private func launchctl(_ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }

    // MARK: varie

    private func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    private func notify(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    /// La "C" pixel di Ciccio, 8×8 a blocchi di 2 punti: nitida, e si adatta a menu chiaro o scuro.
    private func pixelIcon(dim: Bool) -> NSImage {
        let dark: Set<[Int]> = [[2,2],[3,2],[4,2],[5,2],[2,3],[2,4],[2,5],[3,5],[4,5],[5,5]]
        let img = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { _ in
            NSColor.black.withAlphaComponent(dim ? 0.45 : 1).setFill()
            for y in 0..<8 { for x in 0..<8 where !dark.contains([x, y]) {
                NSBezierPath(rect: NSRect(x: x * 2, y: y * 2, width: 2, height: 2)).fill()
            } }
            return true
        }
        img.isTemplate = true
        return img
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

/// Finestra «Permessi di Ciccio Companion»: cosa serve per funzionare bene, con lo stato di ogni voce
/// e un pulsante che porta al punto esatto delle Impostazioni di Sistema. Si aggiorna da sola mentre è aperta.
final class PermissionsWindow: NSObject, NSWindowDelegate {
    private weak var app: AppDelegate?
    private let window: NSWindow
    private var rows: [(status: NSTextField, button: NSButton, kind: Int)] = []
    private var timer: Timer?
    var onClose: (() -> Void)?

    init(app: AppDelegate) {
        self.app = app
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Permessi di Ciccio Companion"
        window.isReleasedWhenClosed = false
        window.delegate = self

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)

        let intro = NSTextField(wrappingLabelWithString: "Per funzionare bene Ciccio Companion ha bisogno di due permessi. Premi il pulsante di ogni voce: si apre il punto esatto delle Impostazioni di Sistema da attivare.")
        intro.preferredMaxLayoutWidth = 456
        stack.addArrangedSubview(intro)

        addRow(to: stack, kind: 0, title: "Notifiche",
               text: "Gli avvisi di Ciccio (un agente ha finito, chiede un permesso, si è bloccato) arrivano come notifiche del Mac, con l\u{2019}icona di Ciccio, anche a browser chiuso. Nelle Impostazioni: Notifiche › Ciccio Companion › Consenti notifiche.")
        addRow(to: stack, kind: 1, title: "Avvio in background",
               text: "Serve perché il companion si accenda da solo all\u{2019}accesso e resti acceso. Nelle Impostazioni: Generali › Elementi di login ed estensioni › Consenti in background › Ciccio Companion. Se cambi questa voce macOS chiude l\u{2019}app: si riapre da sola dopo qualche secondo.")

        let done = NSButton(title: "Fatto", target: self, action: #selector(close))
        done.keyEquivalent = "\r"
        let footer = NSStackView(views: [NSView(), done])
        footer.orientation = .horizontal
        footer.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(footer)
        footer.widthAnchor.constraint(equalToConstant: 456).isActive = true

        window.contentView = stack
        window.setContentSize(stack.fittingSize)
    }

    private func addRow(to stack: NSStackView, kind: Int, title: String, text: String) {
        let name = NSTextField(labelWithString: title)
        name.font = .boldSystemFont(ofSize: 13)
        let status = NSTextField(labelWithString: "")
        let header = NSStackView(views: [name, status])
        header.spacing = 8
        let body = NSTextField(wrappingLabelWithString: text)
        body.preferredMaxLayoutWidth = 456
        body.textColor = .secondaryLabelColor
        body.font = .systemFont(ofSize: 12)
        let button = NSButton(title: "", target: self, action: #selector(act(_:)))
        button.tag = kind
        let row = NSStackView(views: [header, body, button])
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 6
        stack.addArrangedSubview(row)
        rows.append((status, button, kind))
    }

    func refresh() {
        guard let app else { return }
        for r in rows {
            let ok: Bool
            let label: String
            if r.kind == 0 {
                ok = app.notificationsAllowed()
                label = ok ? "Apri le impostazioni delle notifiche" : "Consenti le notifiche"
            } else {
                let st = app.loginItemStatus()
                ok = st == .enabled
                label = st == .notRegistered ? "Apri Elementi di login" : (ok ? "Apri Elementi di login" : "Consenti in background")
            }
            r.status.stringValue = ok ? "✓ attivo" : "da attivare"
            r.status.textColor = ok ? .systemGreen : .systemOrange
            r.button.title = label
        }
    }

    @objc private func act(_ sender: NSButton) {
        guard let app else { return }
        if sender.tag == 0 {
            // Prima volta: la domanda di macOS; dopo un rifiuto si può solo dalle Impostazioni.
            app.refreshNotifyAuthPublic { status in
                if status == .notDetermined { app.requestNotifications() } else { app.openNotificationSettings() }
            }
        } else {
            app.openLoginItemsSettings()
        }
    }

    func show() {
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.app?.refreshNotifyAuthPublic { _ in self?.refresh() }
        }
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func close() { window.close() }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
        let cb = onClose
        onClose = nil
        cb?()
    }
}
