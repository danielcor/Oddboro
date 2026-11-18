//! The office server: Node running the SvelteKit build. The shell starts it,
//! waits for it to answer, restarts it when it dies, and stops it on quit.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, sleep};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "linux")]
use zbus::zvariant::Value as BusValue;

use serde_json::Value;

use crate::key::Key;

/// The server's entry point, relative to the staged code.
pub const ENTRY: &str = "apps/office/build/index.js";

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// Seconds to wait before the first, second, and every later restart.
const BACKOFF: [u64; 3] = [1, 5, 30];
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(600);
// `GaveUp`'s texts say these numbers in words.
const _: () = assert!(READY_TIMEOUT.as_secs() == 90);
const _: () = assert!(MAX_RESTARTS == 5);
const _: () = assert!(RESTART_WINDOW.as_secs() == 600);
/// A line Node writes to ask for a notification: the prefix, then the title,
/// a tab, and the text (`apps/office/src/lib/server/notify.ts`).
const NOTIFY: &str = "oddboro:notify ";
/// The log moves aside to `office.log.1` past this size, when Node starts.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;

/// Node's pid while it runs, 0 otherwise.
static NODE_PID: AtomicI32 = AtomicI32::new(0);
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Held while Node starts or the shell begins to quit, so the two never race.
/// The supervisor notifies it when Node is gone.
static GONE: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());
/// Node's stdin while it runs. The server quits when it closes, so closing it
/// is how the shell asks Node to go on Windows, which has no SIGTERM.
static NODE_STDIN: Mutex<Option<ChildStdin>> = Mutex::new(None);
/// The write end of the pipe a quit signal wakes. -1 until it exists.
#[cfg(unix)]
static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

pub struct Server {
    pub node: PathBuf,
    pub code: PathBuf,
    pub port: u16,
    pub path: String,
    pub home: PathBuf,
    pub log: PathBuf,
    /// The app's version, passed as `ODDBORO_VERSION`.
    pub version: String,
    /// True when this build updates itself: Node gets `ODDBORO_UPDATES=1`.
    pub updates: bool,
    /// Where error reports go, passed as `ODDBORO_DIAGNOSTICS_DSN` so the
    /// office and the shell agree. None when this build has no address.
    pub diagnostics_dsn: Option<String>,
}

/// Why the shell stopped running the office.
pub enum GaveUp {
    CouldNotStart(io::Error),
    NoAnswer,
    /// `code` is Node's last exit code, when it exited with one.
    KeptStopping {
        code: Option<i32>,
    },
}

impl GaveUp {
    /// What the owner is shown. `log_tail` is the end of the office's log.
    pub fn message(&self, log_tail: &str) -> String {
        match self {
            GaveUp::CouldNotStart(e) => format!("Oddboro could not start its server: {e}"),
            GaveUp::NoAnswer => {
                format!("The office did not answer within 90 seconds.\n\n{log_tail}")
            }
            GaveUp::KeptStopping { .. } => format!(
                "The office stopped {MAX_RESTARTS} times in 10 minutes, so Oddboro gave up.\n\n{log_tail}"
            ),
        }
    }

    /// What an error report says: a fixed text, never the log, which names
    /// the owner's home folder and holds the office's own lines.
    pub fn report(&self) -> &'static str {
        match self {
            GaveUp::CouldNotStart(_) => "The office could not start",
            GaveUp::NoAnswer => "The office did not answer within 90 seconds",
            GaveUp::KeptStopping { .. } => "The office stopped 5 times in 10 minutes",
        }
    }
}

enum Ready {
    Answered,
    Exited(ExitStatus),
    TimedOut,
}

impl Server {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Runs Node until the shell quits. Every start of Node gets a fresh key.
    /// Calls `on_ready` each time the server on the port proves it holds that
    /// key, the first time and after every restart. Returns why when it gives
    /// up.
    pub fn supervise(&self, on_ready: impl Fn()) -> Result<(), GaveUp> {
        let mut restarts: VecDeque<Instant> = VecDeque::new();
        loop {
            let (mut child, key) = {
                let _guard = GONE.0.lock().unwrap_or_else(|e| e.into_inner());
                if QUITTING.load(SeqCst) {
                    return Ok(());
                }
                self.spawn().map_err(GaveUp::CouldNotStart)?
            };
            note(&self.log, &format!("started node, pid {}", child.id()));

            let status = match wait_ready(&mut child, self.port, &key, &self.log) {
                Ready::Answered => {
                    on_ready();
                    child.wait()
                }
                Ready::Exited(status) => Ok(status),
                Ready::TimedOut => {
                    terminate(&mut child);
                    mark_gone();
                    return Err(GaveUp::NoAnswer);
                }
            };
            mark_gone();
            if QUITTING.load(SeqCst) {
                return Ok(());
            }
            let code = status.as_ref().ok().and_then(ExitStatus::code);
            let status = status.map_or_else(|e| e.to_string(), |s| s.to_string());
            note(&self.log, &format!("node stopped: {status}"));

            restarts.retain(|t| t.elapsed() < RESTART_WINDOW);
            if restarts.len() >= MAX_RESTARTS {
                return Err(GaveUp::KeptStopping { code });
            }
            let delay = BACKOFF[restarts.len().min(BACKOFF.len() - 1)];
            restarts.push_back(Instant::now());
            note(&self.log, &format!("restarting node in {delay}s"));
            sleep(Duration::from_secs(delay));
        }
    }

    /// Starts Node with a fresh key, which is from now on the current one.
    fn spawn(&self) -> io::Result<(Child, Arc<Key>)> {
        let key = crate::key::renew()
            .ok_or_else(|| io::Error::other("the system gave no randomness for the app's key"))?;
        let log = open_log(&self.log)?;
        let port = self.port.to_string();
        let mut command = Command::new(&self.node);
        command
            .arg(self.code.join(ENTRY))
            .current_dir(self.code.join("apps/office"))
            .env("PORT", &port)
            .env("ODDBORO_PORT", &port)
            .env("HOST", "127.0.0.1")
            .env("ORIGIN", self.url())
            .env("ODDBORO_HOME", &self.home)
            .env("ODDBORO_CODE", &self.code)
            // Tells the server to quit when this stdin closes.
            .env("ODDBORO_APP", "1")
            // On quit, close the page's open connections (the live event
            // stream) after a second instead of the default 30.
            .env("SHUTDOWN_TIMEOUT", "1")
            // The most any request may carry: a backup to restore, up to
            // 16 GB (`BACKUP_MAX_BYTES` in the ledger). The office's own
            // guard holds every other route to its size: 10 MB for a file
            // attached in a chat (`FILE_MAX`), 512 KB for most
            // (`guardOffice` in owner-page.ts).
            .env("BODY_SIZE_LIMIT", "16G")
            .env("PATH", &self.path)
            .env("ODDBORO_VERSION", &self.version)
            .env("ODDBORO_LOG", &self.log)
            // A pipe the shell holds open. It closes when the shell dies by
            // any means, so the server can treat its end as "quit".
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(self.updates.then_some(("ODDBORO_UPDATES", "1")))
            .envs(
                self.diagnostics_dsn
                    .as_deref()
                    .map(|dsn| ("ODDBORO_DIAGNOSTICS_DSN", dsn)),
            )
            // The Desktop OAuth client's secret for Google sign-in, built in
            // from the release's own secret. Google treats it as not
            // confidential, but it stays out of the repo.
            .envs(
                option_env!("ODDBORO_GOOGLE_CLIENT_SECRET")
                    .map(|secret| ("ODDBORO_GOOGLE_CLIENT_SECRET", secret)),
            )
            // New Altitude's GitHub OAuth App's secret, for servers that sign
            // in through GitHub, built in the same way.
            .envs(
                option_env!("ODDBORO_GITHUB_CLIENT_SECRET")
                    .map(|secret| ("ODDBORO_GITHUB_CLIENT_SECRET", secret)),
            );
        // The office keeps its secrets through this shell (`secrets.rs`), over
        // the two pipes above. Mac only.
        #[cfg(target_os = "macos")]
        command.env("ODDBORO_SECRETS", "shell");
        // Node is a console program. Without this, Windows opens a console
        // window for it, and for every program it starts.
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        // Hold Node's stdin apart, open until Node is gone: `Child::wait`
        // closes a stdin it still holds, and the server quits when its stdin
        // closes. It is in place before the relay starts, so the first
        // Keychain answer has somewhere to go. The key is the first line on
        // it, before any answer: the office reads it before it asks anything.
        *NODE_STDIN.lock().unwrap_or_else(|e| e.into_inner()) = child.stdin.take();
        to_node(&key.line());
        if let Some(err) = child.stderr.take() {
            let log = log.try_clone()?;
            thread::spawn(move || stamped(err, log));
        }
        if let Some(out) = child.stdout.take() {
            thread::spawn(move || relay(out, log));
        }
        NODE_PID.store(child.id() as i32, SeqCst);
        keep_awake(child.id());
        Ok((child, key))
    }

    pub fn log_tail(&self) -> String {
        format!(
            "The last lines of {}:\n\n{}",
            self.log.display(),
            tail(&self.log, 12)
        )
    }
}

/// One request of the shell's own to the office, with the key in its header,
/// and the answer's JSON. HTTP/1.0, so the answer comes whole, never chunked.
pub fn call(port: u16, key: &Key, method: &str, path: &str, body: Option<&Value>) -> Option<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let body = body.map(Value::to_string).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        key.header(),
        body.len()
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer).ok()?;
    let (_, json) = answer.split_once("\r\n\r\n")?;
    serde_json::from_str(json).ok()
}

/// True when anything listens on the port.
pub fn port_taken(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Asks the shell to quit: Node is asked to go, gets up to 10 seconds, and is
/// then killed. Blocks until Node is gone.
pub fn stop() {
    let pid = {
        let _guard = GONE.0.lock().unwrap_or_else(|e| e.into_inner());
        QUITTING.store(true, SeqCst);
        NODE_PID.load(SeqCst)
    };
    if pid <= 0 {
        return;
    }
    ask_to_quit(pid);
    if !wait_gone(STOP_TIMEOUT) {
        kill_now(pid);
        wait_gone(Duration::from_secs(2));
    }
}

/// When the shell itself gets SIGTERM, SIGINT or SIGHUP, run `quit` on a
/// thread, so a `kill` or a Ctrl-C quits the same way the menu does and Node
/// gets its 10 seconds and then SIGKILL. A second signal kills the shell
/// outright.
#[cfg(unix)]
pub fn on_quit_signal(quit: impl FnOnce() + Send + 'static) {
    extern "C" fn on_signal(sig: libc::c_int) {
        let fd = SIGNAL_PIPE.load(SeqCst);
        let byte = 0u8;
        // SAFETY: signal and write are async-signal-safe, and `byte` outlives
        // the write.
        unsafe {
            libc::signal(sig, libc::SIG_DFL);
            libc::write(fd, (&raw const byte).cast(), 1);
        }
    }
    let mut fds = [0; 2];
    // SAFETY: pipe writes two fds into an array of two.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let [read_fd, write_fd] = fds;
    SIGNAL_PIPE.store(write_fd, SeqCst);
    thread::spawn(move || {
        let mut byte = 0u8;
        // SAFETY: reads one byte into `byte`, which outlives the call.
        if unsafe { libc::read(read_fd, (&raw mut byte).cast(), 1) } == 1 {
            quit();
        }
    });
    let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: the handler only calls async-signal-safe functions.
        unsafe {
            libc::signal(sig, handler);
        }
    }
}

/// Windows sends a windowed app no such signals: it closes the app through its
/// windows, and logging off ends it like any other.
#[cfg(windows)]
pub fn on_quit_signal(_quit: impl FnOnce() + Send + 'static) {}

/// Waits up to 90 seconds for the server on the port to prove it holds
/// `key`. Any other answer is not the office this shell started: another
/// program may have taken the port. It never counts, and the log says so once.
fn wait_ready(child: &mut Child, port: u16, key: &Key, log: &Path) -> Ready {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut warned = false;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Ready::Exited(status);
        }
        match prove(port, key) {
            Proof::Proven => return Ready::Answered,
            Proof::Failed if !warned => {
                warned = true;
                note(
                    log,
                    &format!("something answered on port {port} without proving it holds the app's key, so the window will not open it; another program may have the port"),
                );
            }
            Proof::Failed | Proof::Silent => {}
        }
        sleep(Duration::from_millis(500));
    }
    Ready::TimedOut
}

/// What the server on the port said when asked to prove it holds the key.
#[derive(Debug, PartialEq)]
enum Proof {
    /// It answered HMAC-SHA256 of the key, the label and a fresh nonce.
    Proven,
    /// It answered, but not with the proof.
    Failed,
    /// Nothing listens, or nothing answered yet.
    Silent,
}

/// Asks `GET /api/proof?nonce=<fresh nonce>` and checks the answer
/// (`Key::proves`). The office answers it without the key, since the shell
/// sends none until the server has proved itself.
fn prove(port: u16, key: &Key) -> Proof {
    let Some(nonce) = crate::key::nonce() else {
        return Proof::Silent;
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return Proof::Silent;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /api/proof?nonce={nonce} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Proof::Silent;
    }
    let mut answer = Vec::new();
    let _ = stream.take(64 * 1024).read_to_end(&mut answer);
    if answer.is_empty() {
        return Proof::Silent;
    }
    let answer = String::from_utf8_lossy(&answer);
    let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
    let ok = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        == Some("200");
    if ok && key.proves(&nonce, body) {
        Proof::Proven
    } else {
        Proof::Failed
    }
}

/// Asked to go, up to 10 seconds, then killed, for a child this thread owns.
fn terminate(child: &mut Child) {
    ask_to_quit(child.id() as i32);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// SIGTERM, which the server takes as "quit".
#[cfg(unix)]
fn ask_to_quit(pid: i32) {
    // SAFETY: kill has no memory-safety preconditions.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

/// Closes Node's stdin, which the server takes as "quit".
#[cfg(windows)]
fn ask_to_quit(_pid: i32) {
    drop(NODE_STDIN.lock().unwrap_or_else(|e| e.into_inner()).take());
}

#[cfg(unix)]
fn kill_now(pid: i32) {
    // SAFETY: kill has no memory-safety preconditions.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_now(pid: i32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: the handle is checked before use and closed once.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn mark_gone() {
    let_sleep();
    drop(NODE_STDIN.lock().unwrap_or_else(|e| e.into_inner()).take());
    let _guard = GONE.0.lock().unwrap_or_else(|e| e.into_inner());
    NODE_PID.store(0, SeqCst);
    GONE.1.notify_all();
}

fn wait_gone(timeout: Duration) -> bool {
    let guard = GONE.0.lock().unwrap_or_else(|e| e.into_inner());
    let (_guard, result) = GONE
        .1
        .wait_timeout_while(guard, timeout, |_| NODE_PID.load(SeqCst) != 0)
        .unwrap_or_else(|e| e.into_inner());
    !result.timed_out()
}

/// Keeps the Mac awake on AC power for as long as Node runs, like
/// `caffeinate -s`. caffeinate exits by itself when Node does.
#[cfg(target_os = "macos")]
fn keep_awake(pid: u32) {
    let spawned = Command::new("/usr/bin/caffeinate")
        .args(["-s", "-w", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut caffeinate) = spawned {
        thread::spawn(move || caffeinate.wait());
    }
}

/// caffeinate lets go by itself when Node exits.
#[cfg(target_os = "macos")]
fn let_sleep() {}

/// The sleep lock while Node runs on Linux: `systemd-inhibit` holding `cat`,
/// whose stdin is a pipe this shell holds. Dropping it, or the shell dying by
/// any means, ends `cat` and with it the lock.
#[cfg(target_os = "linux")]
static AWAKE: Mutex<Option<Child>> = Mutex::new(None);

/// Keeps the computer from sleeping on its own while Node runs. Closing a
/// laptop's lid still suspends it: logind ignores this lock for the lid.
#[cfg(target_os = "linux")]
fn keep_awake(_pid: u32) {
    let spawned = crate::host::host_command("systemd-inhibit")
        .args([
            "--what=sleep",
            "--mode=block",
            "--who=Oddboro",
            "--why=The office is running",
            "cat",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(child) = spawned {
        *AWAKE.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    }
}

#[cfg(target_os = "linux")]
fn let_sleep() {
    let held = AWAKE.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut inhibit) = held {
        drop(inhibit.stdin.take());
        let _ = inhibit.wait();
    }
}

/// The sleep lock while Node runs on Windows: a thread that asked Windows to
/// stay awake and waits. Windows holds the request for as long as that thread
/// lives, so dropping this ends the thread, and the shell dying ends it too.
#[cfg(windows)]
static AWAKE: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

/// Keeps the computer from sleeping on its own while Node runs. Closing a
/// laptop's lid still sleeps it, as the lid's own setting says.
#[cfg(windows)]
fn keep_awake(_pid: u32) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let (held, released) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        // SAFETY: SetThreadExecutionState takes flags and touches no memory.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        // Returns when the sender drops.
        let _ = released.recv();
        // SAFETY: as above.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    *AWAKE.lock().unwrap_or_else(|e| e.into_inner()) = Some(held);
}

#[cfg(windows)]
fn let_sleep() {
    drop(AWAKE.lock().unwrap_or_else(|e| e.into_inner()).take());
}

/// Where one line of Node's stdout goes.
#[derive(Debug, PartialEq)]
enum Route<'a> {
    /// A request for the Keychain, or anything that may hold a secret.
    /// Never the log.
    Secret,
    /// A line with the key's mark in it. The office never writes one; if it
    /// did, it goes nowhere.
    Drop,
    /// The owner's Check now.
    Check,
    Notify(&'a str, &'a str),
    Log,
}

fn route(line: &str) -> Route<'_> {
    if crate::secrets::private(line) {
        return Route::Secret;
    }
    if line.contains(crate::key::LINE.trim_end()) {
        return Route::Drop;
    }
    if line == crate::update::CHECK_LINE {
        return Route::Check;
    }
    match line.strip_prefix(NOTIFY) {
        Some(ask) => {
            let (title, text) = ask.split_once('\t').unwrap_or(("Oddboro", ask));
            Route::Notify(title, text)
        }
        None => Route::Log,
    }
}

/// Node's stdout: a Keychain request goes to the Keychain, with the answer on
/// Node's stdin, a notification request to the system as Oddboro's own, a
/// Check now to the update watcher, everything else to the log.
fn relay(out: impl Read, mut log: File) {
    for line in lines(out) {
        match route(&line) {
            Route::Secret => match crate::secrets::answer(&line, &crate::secrets::Login) {
                Some(reply) => to_node(&reply),
                None => {
                    let _ = writeln!(
                        log,
                        "oddboro: {} a Keychain request from the office could not be read",
                        stamp()
                    );
                }
            },
            Route::Drop => {}
            Route::Check => crate::update::check_now(),
            Route::Notify(title, text) => notify(title, text),
            Route::Log => {
                let _ = writeln!(log, "{} {line}", stamp());
            }
        }
    }
}

/// Node's stderr: every line to the log, with the time.
fn stamped(out: impl Read, mut log: File) {
    for line in lines(out) {
        let _ = writeln!(log, "{} {line}", stamp());
    }
}

/// A child's output line by line, read as bytes: a line that is not UTF-8
/// would end `BufRead::lines`, and the child would then block on a full pipe.
fn lines(out: impl Read) -> impl Iterator<Item = String> {
    BufReader::new(out)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|bytes| {
            let line = String::from_utf8_lossy(&bytes);
            line.strip_suffix('\r').unwrap_or(&line).to_string()
        })
}

/// One line on Node's stdin, in one write.
fn to_node(line: &str) {
    if let Some(stdin) = NODE_STDIN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        let _ = stdin.write_all(format!("{line}\n").as_bytes());
    }
}

/// Show a notification as Oddboro's, with the Glass sound the office used before.
#[cfg(target_os = "macos")]
fn notify(title: &str, text: &str) {
    use mac_notification_sys::{send_notification, set_application, Notification};
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = set_application("com.newaltitude.oddboro");
    });
    let _ = send_notification(title, None, text, Some(Notification::new().sound("Glass")));
}

/// Show a notification as Oddboro's. The desktop's notification service gets
/// it on the session bus, filed under the `oddboro` desktop entry. A failure
/// is one line in the office log. The call never blocks the log relay.
#[cfg(target_os = "linux")]
fn notify(title: &str, text: &str) {
    let title = title.to_string();
    let text = text.to_string();
    thread::spawn(move || {
        if let Err(service) = session_notify(&title, &text) {
            note(
                &crate::env::log_file(),
                &format!("notify failed: notification service: {service}"),
            );
        }
    });
}

/// `org.freedesktop.Notifications.Notify` on the session bus. zbus speaks the
/// bus itself, so this does not load the host's libnotify or the bundle's glib.
#[cfg(target_os = "linux")]
fn session_notify(title: &str, text: &str) -> Result<(), String> {
    let bus =
        zbus::blocking::Connection::session().map_err(|error| one_line(&error.to_string()))?;
    let hints = HashMap::from([("desktop-entry", BusValue::from("oddboro"))]);
    bus.call_method(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        Some("org.freedesktop.Notifications"),
        "Notify",
        &(
            "Oddboro",
            0u32,
            "",
            title,
            text,
            &[] as &[&str],
            &hints,
            -1i32,
        ),
    )
    .map(|_| ())
    .map_err(|error| one_line(&error.to_string()))
}

/// Spaces for line breaks, and cut so one log line stays one line.
#[cfg(target_os = "linux")]
fn one_line(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect()
}

/// Show a notification as Oddboro's. Windows finds the app by the id the
/// installer gave its Start menu shortcut, the app's identifier.
#[cfg(windows)]
fn notify(title: &str, text: &str) {
    use tauri_winrt_notification::{Sound, Toast};
    let _ = Toast::new("com.newaltitude.oddboro")
        .title(title)
        .text1(text)
        .sound(Some(Sound::Default))
        .show();
}

fn open_log(path: &Path) -> io::Result<File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Writes one line of the shell's own to the log, with the time in UTC.
pub fn note(path: &Path, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "oddboro: {} {line}", stamp());
    }
}

/// Now, in UTC.
fn stamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    utc(now.as_secs(), now.subsec_millis())
}

/// Seconds since 1970 as `2026-11-08T06:15:40.123Z`. The date comes from
/// Howard Hinnant's `civil_from_days`, so the shell needs no date library.
fn utc(secs: u64, millis: u32) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (hour, minute, second) = (rest / 3600, rest % 3600 / 60, rest % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// The last `count` lines of the log, each cut to 200 characters.
fn tail(path: &Path, count: usize) -> String {
    let Ok(mut file) = File::open(path) else {
        return "(the log is empty)".to_string();
    };
    let len = file.metadata().map_or(0, |m| m.len());
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(8192)));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.chars().take(200).collect())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_line_never_goes_to_the_log() {
        for line in [
            r#"oddboro:secret {"id":1,"op":"set","account":"github:token","value":"ghp_x"}"#,
            r#"oddboro:secret {"id":2,"op":"set","account":"a:b","val"#,
            "oddboro:secret not json at all",
            "oddboro:secret",
            r#"[vite] reloadoddboro:secret {"id":3,"op":"set","value":"v"}"#,
        ] {
            assert_eq!(route(line), Route::Secret, "{line}");
        }
    }

    #[test]
    fn a_line_with_the_key_in_it_never_goes_to_the_log() {
        for line in [
            "oddboro:key 0123abcd",
            "something oddboro:key 0123abcd",
            "oddboro:key",
        ] {
            assert_eq!(route(line), Route::Drop, "{line}");
        }
    }

    #[test]
    fn the_shells_own_request_carries_the_key_in_its_header() {
        let door = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = door.local_addr().unwrap().port();
        let heard = thread::spawn(move || {
            let (mut stream, _) = door.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            while !String::from_utf8_lossy(&request).contains("{\"path\":\"/a\"}") {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            stream
                .write_all(
                    b"HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{\"code\":\"c\"}",
                )
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        let key = crate::key::fresh().unwrap();
        let body = serde_json::json!({ "path": "/a" });
        let answer = call(port, &key, "POST", "/api/browser-link", Some(&body));
        assert_eq!(answer, Some(serde_json::json!({ "code": "c" })));
        let request = heard.join().unwrap();
        assert!(request.starts_with("POST /api/browser-link HTTP/1.0\r\n"));
        assert!(request.contains(&format!("\r\n{}\r\n", key.header())));
    }

    /// A stand-in on a free port that answers one request with `reply(nonce)`.
    fn stand_in(reply: impl FnOnce(&str) -> String + Send + 'static) -> u16 {
        let door = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = door.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = door.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            let request = String::from_utf8(request).unwrap();
            let nonce = request
                .split_once("nonce=")
                .map_or("", |(_, rest)| &rest[..64]);
            let _ = stream.write_all(reply(nonce).as_bytes());
        });
        port
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n{body}")
    }

    #[test]
    fn only_a_server_with_the_current_key_counts_as_ready() {
        let key = Arc::new(crate::key::fresh().unwrap());
        let theirs = Arc::new(crate::key::fresh().unwrap());
        let mine = Arc::clone(&key);
        let port = stand_in(move |n| ok(&crate::key::tests::answer(&mine, n)));
        assert_eq!(prove(port, &key), Proof::Proven);
        // Another key's proof, a page, a refusal, a malformed proof, or the key itself.
        let other = Arc::clone(&theirs);
        let port = stand_in(move |n| ok(&crate::key::tests::answer(&other, n)));
        assert_eq!(prove(port, &key), Proof::Failed);
        let port = stand_in(|_| ok("<!doctype html><title>Oddboro</title>"));
        assert_eq!(prove(port, &key), Proof::Failed);
        let port = stand_in(|_| "HTTP/1.1 403 Forbidden\r\n\r\nno".to_string());
        assert_eq!(prove(port, &key), Proof::Failed);
        let port = stand_in(|n| ok(&n.replace('a', "b")));
        assert_eq!(prove(port, &key), Proof::Failed);
        let mine = Arc::clone(&key);
        let port = stand_in(move |n| {
            let right = crate::key::tests::answer(&mine, n);
            format!("HTTP/1.1 500 Oops\r\n\r\n{right}")
        });
        assert_eq!(prove(port, &key), Proof::Failed);
        // Nothing on the port at all.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        assert_eq!(prove(port, &key), Proof::Silent);
    }

    #[test]
    fn other_lines_go_where_they_did() {
        assert_eq!(route(crate::update::CHECK_LINE), Route::Check);
        assert_eq!(
            route("oddboro:notify Rowan\tThe report is ready"),
            Route::Notify("Rowan", "The report is ready")
        );
        assert_eq!(route("listening on 127.0.0.1:4500"), Route::Log);
    }

    #[test]
    fn log_times_read_as_utc_dates() {
        assert_eq!(utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc(951_782_400, 5), "2000-02-29T00:00:00.005Z");
        assert_eq!(utc(1_794_095_284, 123), "2026-11-07T23:48:04.123Z");
        assert_eq!(utc(4_102_444_799, 999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn each_line_from_node_gets_the_time_and_a_bad_byte_ends_nothing() {
        let name = format!("oddboro-stamped-{}.log", std::process::id());
        let path = std::env::temp_dir().join(name);
        let input = b"office: ready\n\xff not utf-8\r\nthe last line";
        stamped(&input[..], File::create(&path).unwrap());
        let text = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(&path);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        let expected = ["office: ready", "\u{fffd} not utf-8", "the last line"];
        for (line, rest) in lines.iter().zip(expected) {
            let (time, after) = line.split_once(' ').unwrap();
            assert!(time.len() == 24 && time.ends_with('Z'), "{line}");
            assert_eq!(after, rest);
        }
    }
}
