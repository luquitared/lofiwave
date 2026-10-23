// The lofiwave app: a menu bar item that runs the server (the bundled bun on the bundled source) and opens the
// console in the browser. Data lives in ~/Library/Application Support/lofiwave; a .env there is read at start.
import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    let resources = Bundle.main.resourceURL!
    let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/lofiwave")
    var logURL: URL { dataDir.appendingPathComponent("server.log") }
    var port = 7770
    var server: Process?
    var startedAt = Date()
    var quitting = false
    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        port = envFilePort() ?? 7770
        buildMenu()
        DispatchQueue.global().async {
            let path = self.childPath()
            DispatchQueue.main.async { self.startServer(path: path, openWhenUp: true) }
        }
    }

    // Opening the app again (Finder, Spotlight) while it runs: show the console.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openConsole()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        guard let p = server, p.isRunning else { return .terminateNow }
        // Interactive runs live in tmux and keep going; the server picks them up again on its next start.
        p.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { usleep(100_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    // MARK: menu

    func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(systemSymbolName: "waveform", accessibilityDescription: "lofiwave")
        icon?.isTemplate = true
        statusItem.button?.image = icon
        let menu = NSMenu()
        menu.addItem(withTitle: "Open lofiwave", action: #selector(openConsole), keyEquivalent: "o")
        menu.addItem(.separator())
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(withTitle: "Restart Server", action: #selector(restartServer), keyEquivalent: "r")
        menu.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "l")
        menu.addItem(withTitle: "Open Data Folder", action: #selector(openDataFolder), keyEquivalent: "")
        menu.addItem(.separator())
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit lofiwave", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    @objc func openConsole() {
        let token = (try? String(contentsOf: dataDir.appendingPathComponent("auth-token"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var url = "http://127.0.0.1:\(port)/"
        if !token.isEmpty { url += "#token=\(token)" }
        NSWorkspace.shared.open(URL(string: url)!)
    }

    @objc func restartServer() {
        guard let p = server, p.isRunning else { return startServer(path: childPath(), openWhenUp: false) }
        p.terminationHandler = { _ in DispatchQueue.main.async { self.startServer(path: self.childPath(), openWhenUp: false) } }
        p.terminate()
    }

    @objc func showLog() { NSWorkspace.shared.open(logURL) }
    @objc func openDataFolder() { NSWorkspace.shared.open(dataDir) }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            alert("Couldn't change Start at Login", error.localizedDescription)
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    // MARK: server

    func startServer(path: String, openWhenUp: Bool) {
        rotateLog()
        FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) // no-op if it exists
        guard let log = try? FileHandle(forWritingTo: logURL) else { return alert("Can't write \(logURL.path)", "") }
        log.seekToEndOfFile()
        log.write("\n--- lofiwave app \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "") starting \(Date())\n".data(using: .utf8)!)

        let p = Process()
        p.executableURL = resources.appendingPathComponent("bin/bun")
        p.arguments = ["run", resources.appendingPathComponent("app/src/server.ts").path]
        p.currentDirectoryURL = dataDir // bun reads the .env here
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["DATA_DIR"] = dataDir.path
        // Apps start without a locale; tmux then draws anything non-ASCII as "_".
        if env["LANG"] == nil && env["LC_ALL"] == nil && env["LC_CTYPE"] == nil { env["LANG"] = "en_US.UTF-8" }
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { proc in DispatchQueue.main.async { self.serverExited(proc) } }
        do { try p.run() } catch { return alert("Couldn't start the lofiwave server", error.localizedDescription) }
        server = p
        startedAt = Date()
        statusLine.title = "Starting…"
        waitUntilUp(p) { up in
            guard up else { return }
            self.statusLine.title = "Running on 127.0.0.1:\(self.port)"
            if openWhenUp { self.openConsole() }
        }
    }

    func serverExited(_ p: Process) {
        guard p === server, !quitting else { return }
        statusLine.title = "Server stopped (exit \(p.terminationStatus))"
        // A crash after it has been up a while: start it again. Dying right at start (port taken, bad .env): say why.
        if Date().timeIntervalSince(startedAt) > 15 { return startServer(path: childPath(), openWhenUp: false) }
        let tail = (try? String(contentsOf: logURL, encoding: .utf8)).map { String($0.suffix(1200)) } ?? ""
        alert("The lofiwave server stopped", "Port \(port) may be in use by another lofiwave. Set PORT in \(dataDir.path)/.env to use another.\n\n\(tail)")
    }

    /// Up = answers /api/health with our token, so another server already on the port doesn't count.
    func waitUntilUp(_ p: Process, done: @escaping (Bool) -> Void) {
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(30)
            while p.isRunning && Date() < deadline {
                if let token = try? String(contentsOf: self.dataDir.appendingPathComponent("auth-token"), encoding: .utf8) {
                    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/api/health")!, timeoutInterval: 1)
                    req.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
                    let sem = DispatchSemaphore(value: 0)
                    var ok = false
                    URLSession.shared.dataTask(with: req) { _, resp, _ in
                        ok = (resp as? HTTPURLResponse)?.statusCode == 200
                        sem.signal()
                    }.resume()
                    sem.wait()
                    if ok { return DispatchQueue.main.async { done(true) } }
                }
                usleep(250_000)
            }
            DispatchQueue.main.async { done(false) }
        }
    }

    /// PATH for the server and the agents it starts: the user's login shell PATH (where claude, codex and git are),
    /// the usual install folders, and last the bundled bin (tmux, bun), so a tmux the user has wins over ours.
    func childPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var dirs = (loginShellPath() ?? "").split(separator: ":").map(String.init)
        dirs += ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        dirs.append(resources.appendingPathComponent("bin").path)
        var seen = Set<String>()
        return dirs.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }

    func loginShellPath() -> String? {
        var shell = ProcessInfo.processInfo.environment["SHELL"] ?? ""
        if shell.isEmpty, let pw = getpwuid(getuid()) { shell = String(cString: pw.pointee.pw_shell) }
        if shell.isEmpty { shell = "/bin/zsh" }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        // Interactive login shell, so PATH set in .zshrc counts too; markers skip anything the rc files print.
        p.arguments = ["-ilc", "printf '__LOFIWAVE__%s__LOFIWAVE__' \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        timer.cancel()
        let text = String(decoding: data, as: UTF8.self)
        let parts = text.components(separatedBy: "__LOFIWAVE__")
        return parts.count >= 3 ? parts[1] : nil
    }

    /// PORT from the data folder's .env, which bun also reads when it starts the server there.
    func envFilePort() -> Int? {
        guard let text = try? String(contentsOf: dataDir.appendingPathComponent(".env"), encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("PORT=") { return Int(l.dropFirst(5).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))) }
        }
        return nil
    }

    func rotateLog() {
        let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? Int) ?? 0
        guard size > 10_000_000 else { return }
        let old = dataDir.appendingPathComponent("server.log.1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logURL, to: old)
    }

    func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
