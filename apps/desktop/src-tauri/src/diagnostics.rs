//! The shell's error reports: a panic, the office given up on, or a broken
//! install. They leave only after the owner's yes in the office's settings.
//! Nothing is built until there is something to send, so an idle shell runs
//! no thread or timer for reports. Reports to New Altitude go only while the
//! office is signed in to a New Altitude account, each with its access token.

use std::borrow::Cow;
use std::fs;
use std::panic;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::Url;
use sentry::integrations::backtrace::ProcessStacktraceIntegration;
use sentry::integrations::contexts::ContextIntegration;
use sentry::integrations::debug_images::DebugImagesIntegration;
use sentry::integrations::panic::PanicIntegration;
use sentry::protocol::{
    Context, DebugImage, DeviceContext, Event, Exception, Level, Map, Mechanism, Stacktrace,
};
use sentry::transports::{DefaultTransportFactory, ReqwestHttpTransportOptions};
use sentry::types::Dsn;
use sentry::{ClientOptions, Integration, Transport, TransportFactory, TransportOptions};

use crate::env;
use crate::server::GaveUp;

const DSN_KEY: &str = "ODDBORO_DIAGNOSTICS_DSN";
/// The New Altitude site the office signs in to, set only in development
/// and tests. Reports to it need the sign-in too.
const ACCOUNT_SITE_KEY: &str = "ODDBORO_ACCOUNT_SITE";
/// Where the office keeps its New Altitude sign-in in the system's secret
/// store on Linux: the service every Oddboro secret sits under and the
/// sign-in's name, as `packages/ledger/src/secrets.ts` and
/// `apps/office/src/lib/server/account.ts` write them. On a Mac the app's
/// office keeps it through this shell, under `secrets::SERVICE`.
const SECRET_SERVICE: &str = "oddboro";
const SIGN_IN: &str = "new-altitude-account:oauth";
/// A token with less left than this is not sent. The office refreshes the
/// sign-in; the shell only reads it, so a report waits for the office.
const SIGN_IN_MARGIN: Duration = Duration::from_secs(60);
/// A program and its arguments.
type Reader = (&'static str, &'static [&'static str]);
/// How the office reads a secret on Linux, through the session's keyring.
const KEYRING_READ: Reader = (
    "secret-tool",
    &["lookup", "service", SECRET_SERVICE, "account", SIGN_IN],
);
/// The owner's answer, which the office's Setup writes.
const ANSWER_KEY: &str = "OFFICE_DIAGNOSTICS";
/// The most a report may hold up the dialog or the panic that sent it.
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
const WITHHELD: &str = "[withheld]";
/// Sent in place of the computer's name.
const SERVER_NAME: &str = "oddboro-shell";
const EXIT_CODE: &str = "exit_code";
const KEPT_CONTEXTS: [&str; 3] = ["os", "rust", "device"];
/// Where a release names the repo in the shell's own frames: the build maps
/// the checkout's path to this (`PATH_MAPS` in `apps/desktop/scripts/release.ts`).
/// Not the checkout's own path, which would put the builder's home folder in
/// the binary.
const ROOT: &str = "/oddboro";

/// One panic report per run. A later panic most often follows from the
/// first, and a panic while a report is being sent must not send another.
static PANIC_REPORTED: AtomicBool = AtomicBool::new(false);

pub struct Diagnostics {
    /// The address as found, so Node gets the same text the shell uses.
    dsn: String,
    /// The office's settings file, which holds the owner's answer.
    settings: PathBuf,
    /// Paths under it leave as their file name alone (`report_path`).
    home: PathBuf,
    /// Whether reports to `dsn` need the office's New Altitude sign-in.
    needs_sign_in: bool,
    /// Reads the office's saved sign-in: `read_sign_in`, or a test's own.
    sign_in: fn() -> Option<String>,
}

impl Diagnostics {
    /// None when no report address is set or it is not a DSN: then the
    /// shell reports nothing and installs no panic hook.
    pub fn find() -> Option<Self> {
        // The rule `ENV_FILE` follows in `packages/ledger/src/env.ts`, for
        // the app, where the office's settings live in its home.
        let settings = std::env::var_os("ODDBORO_ENV")
            .map_or_else(|| env::office_home().join(".env"), PathBuf::from);
        Self::from_settings(
            |key| std::env::var(key).ok(),
            option_env!("ODDBORO_DIAGNOSTICS_DSN"),
            settings,
        )
    }

    /// `find` with the shell's environment, the address built into the
    /// release and the settings file given, so a test can give its own. The
    /// account site comes from the environment or the settings file only: a
    /// release builds in no site.
    fn from_settings(
        environment: impl Fn(&str) -> Option<String>,
        built_dsn: Option<&str>,
        settings: PathBuf,
    ) -> Option<Self> {
        let dsn = find_setting(DSN_KEY, environment(DSN_KEY), built_dsn, &settings)?;
        dsn.parse::<Dsn>().ok()?;
        let account_site = find_setting(
            ACCOUNT_SITE_KEY,
            environment(ACCOUNT_SITE_KEY),
            None,
            &settings,
        );
        Some(Self {
            needs_sign_in: needs_sign_in(&dsn, account_site.as_deref()),
            dsn,
            settings,
            home: env::home(),
            sign_in: read_sign_in,
        })
    }

    pub fn dsn(&self) -> &str {
        &self.dsn
    }

    /// Read at send time, so the owner's latest answer holds. A missing or
    /// unreadable file means no.
    fn allowed(&self) -> bool {
        setting(&self.settings, ANSWER_KEY).as_deref() == Some("yes")
    }

    /// Reports a panic, then hands it on to the hook that was there before.
    pub fn watch_panics(self: Arc<Self>) {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if self.allowed() && !PANIC_REPORTED.swap(true, SeqCst) {
                // Never registered with a client, so it installs no hook of
                // its own; it only turns the panic into an event.
                self.send(PanicIntegration::new().event_from_panic_info(info), None);
            }
            previous(info);
        }));
    }

    /// Reports why the shell gave up on the office: a fixed text and Node's
    /// exit code, never the log.
    pub fn gave_up(&self, why: &GaveUp) {
        let tags = match why {
            GaveUp::KeptStopping { code: Some(code) } => {
                Map::from([(EXIT_CODE.to_string(), code.to_string())])
            }
            _ => Map::new(),
        };
        self.send_fixed(why.report(), tags);
    }

    /// Reports a broken install with the fixed text the owner is shown.
    pub fn failed(&self, text: &'static str) {
        self.send_fixed(text, Map::new());
    }

    fn send_fixed(&self, text: &'static str, tags: Map<String, String>) {
        let event = Event {
            level: Level::Fatal,
            message: Some(text.to_string()),
            tags,
            ..Default::default()
        };
        self.send(event, Some(text));
    }

    /// Sends one event, if the owner said yes. `fixed` is the one message
    /// text it may keep. The client lives only for this event.
    fn send(&self, event: Event<'static>, fixed: Option<&'static str>) {
        if !self.allowed() {
            return;
        }
        let home = self.home.to_string_lossy().into_owned();
        let integrations: [Arc<dyn Integration>; 3] = [
            Arc::new(ContextIntegration::new()),
            Arc::new(DebugImagesIntegration::new()),
            Arc::new(ProcessStacktraceIntegration::new()),
        ];
        let mut options = ClientOptions::new()
            .release(format!("oddboro@{}", env!("CARGO_PKG_VERSION")))
            // Set before `ContextIntegration` runs, which fills in the
            // computer's name only when this is empty.
            .server_name(SERVER_NAME)
            .default_integrations(false)
            .integrations(integrations)
            .before_send(move |event| Some(scrub(event, &home, fixed)));
        // Not `ClientOptions::dsn`, which panics on a bad value, and this may
        // run inside the panic hook. `find` already checked it.
        options.dsn = self.dsn.parse().ok();
        let sign_in = self.needs_sign_in.then_some(self.sign_in);

        let (sent, done) = mpsc::channel();
        // On its own thread, so a door that never answers holds up the caller
        // for `SEND_TIMEOUT` at most: `close` waits that long for the queue,
        // then joins the transport's thread however long its request takes.
        // Reading the sign-in, which may wait on a locked keyring, counts in
        // the same wait.
        let sender = thread::Builder::new()
            .name("oddboro-report".into())
            .spawn(move || {
                // `rustls-no-provider` leaves the crypto provider to the
                // process. The updater installs ring only when it checks, so
                // it may be there already, which is fine. A client is built
                // only with one installed.
                let _ = rustls::crypto::ring::default_provider().install_default();
                options.transport = match sign_in {
                    None => Some(Arc::new(DefaultTransportFactory)),
                    Some(read) => {
                        // Signed out, an expired token, or a client that
                        // could not be built: the report is dropped, and
                        // dropping `sent` lets the caller go at once.
                        let Some(client) = read()
                            .and_then(|saved| access_token(&saved, now_ms()))
                            .and_then(|token| signed_client(&token))
                        else {
                            return;
                        };
                        Some(Arc::new(SignedIn(client)))
                    }
                };
                let client = sentry::Client::from(options);
                client.capture_event(event, None);
                client.close(Some(SEND_TIMEOUT));
                let _ = sent.send(());
            });
        // A thread that could not start sends nothing; a report is never
        // worth more than the dialog or the panic waiting on it.
        if sender.is_ok() {
            let _ = done.recv_timeout(SEND_TIMEOUT);
        }
    }
}

/// A setting such as the report address, first found wins: the shell's
/// environment, the value built into the release, then the settings file. An
/// empty value counts as unset at every step: a release built with the
/// variable unset gets `Some("")`.
fn find_setting(
    key: &str,
    environment: Option<String>,
    built: Option<&str>,
    settings: &Path,
) -> Option<String> {
    environment
        .filter(|v| !v.is_empty())
        .or_else(|| built.filter(|v| !v.is_empty()).map(str::to_string))
        .or_else(|| setting(settings, key).filter(|v| !v.is_empty()))
}

/// Whether reports sent to this address need a New Altitude sign-in: New
/// Altitude's own address over https, or the account site itself when one is
/// set (a stand-in in development and tests, whose port may differ). The
/// office's `needsSignIn` in `apps/office/src/lib/diagnostics.ts` is the
/// same rule, and both are tested against `needs-sign-in.cases.json`.
fn needs_sign_in(dsn: &str, account_site: Option<&str>) -> bool {
    let Ok(to) = Url::parse(dsn) else {
        return false;
    };
    let Some(host) = to.host_str() else {
        return false;
    };
    let own = host == "newaltitude.ai" || host.ends_with(".newaltitude.ai");
    let site = account_site.and_then(|site| Url::parse(site).ok());
    (to.scheme() == "https" && own) || site.is_some_and(|site| site.host_str() == Some(host))
}

/// Milliseconds since 1970, as the office's `Date.now()` saves them.
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis())
}

/// The access token in the office's saved sign-in, when it has at least
/// `SIGN_IN_MARGIN` left. The office saves `{ tokens, savedAt }`, with the
/// token's lifetime in seconds and the time saved in milliseconds.
fn access_token(saved: &str, now_ms: u128) -> Option<String> {
    let saved: serde_json::Value = serde_json::from_str(saved).ok()?;
    let token = saved["tokens"]["access_token"].as_str()?;
    let lasts_s = saved["tokens"]["expires_in"].as_u64()?;
    let saved_at = saved["savedAt"].as_u64()?;
    let expires = u128::from(saved_at) + u128::from(lasts_s) * 1000;
    (expires > now_ms + SIGN_IN_MARGIN.as_millis()).then(|| token.to_string())
}

/// The command that reads the office's sign-in on this system. None on a
/// Mac, where the shell reads its own Keychain (`keychain_sign_in`), and on
/// Windows, where the office keeps it in the Credential Manager in pieces
/// the shell does not read, so its reports to New Altitude are dropped.
fn sign_in_command() -> Option<Reader> {
    // `cfg!`, not `#[cfg]`, so every system's branch compiles everywhere.
    cfg!(target_os = "linux").then_some(KEYRING_READ)
}

/// The office's sign-in in the app's own Keychain items, which trust only
/// this app, so the read needs no prompt (`secrets.rs`).
#[cfg(target_os = "macos")]
fn keychain_sign_in() -> Option<String> {
    let value =
        security_framework::passwords::get_generic_password(crate::secrets::SERVICE, SIGN_IN)
            .ok()?;
    String::from_utf8(value).ok()
}

#[cfg(not(target_os = "macos"))]
fn keychain_sign_in() -> Option<String> {
    None
}

/// The office's saved sign-in, read from the secret store the office keeps
/// it in. Never refreshed or written here. None when there is none, the
/// read fails, or the system has no way to it.
fn read_sign_in() -> Option<String> {
    if cfg!(target_os = "macos") {
        return keychain_sign_in();
    }
    let (program, args) = sign_in_command()?;
    let read = crate::host::host_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !read.status.success() {
        return None;
    }
    // A line break after the value would not matter: JSON reads past it.
    String::from_utf8(read.stdout).ok()
}

/// A client that sends the account's token with every request, marked
/// sensitive so no debug output prints it.
fn signed_client(token: &str) -> Option<reqwest::Client> {
    let mut bearer = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
    bearer.set_sensitive(true);
    reqwest::Client::builder()
        .default_headers(HeaderMap::from_iter([(AUTHORIZATION, bearer)]))
        .build()
        .ok()
}

/// Sentry's own transport, on a client that carries the sign-in.
struct SignedIn(reqwest::Client);

impl TransportFactory for SignedIn {
    fn create_transport_with_options(&self, options: TransportOptions) -> Arc<dyn Transport> {
        Arc::new(
            ReqwestHttpTransportOptions::from(options)
                .with_client(self.0.clone())
                .build(),
        )
    }
}

/// A key's value in a settings file, read as `readEnv` in
/// `packages/ledger/src/env.ts` reads it: the last `KEY=value` line wins.
fn setting(file: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(file).ok()?;
    text.lines()
        .rev()
        .filter_map(|line| line.trim().split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, value)| value.to_string())
}

/// The one rule every shell report passes on its way out, an allow-list: an
/// event leaves with only the fields named here. A message is kept only when
/// it is `fixed`, the text the code sent; an exception's value never is,
/// since a panic's message is free text (`unwrap` and `expect` print values
/// and paths). File and line stay: they are code. No user, extra, request
/// or breadcrumbs.
fn scrub(event: Event<'static>, home: &str, fixed: Option<&str>) -> Event<'static> {
    let exception: Vec<Exception> = event
        .exception
        .values
        .into_iter()
        .map(|e| Exception {
            ty: e.ty,
            value: e.value.map(|_| WITHHELD.to_string()),
            stacktrace: e.stacktrace.map(|s| stacktrace_report_paths(s, home)),
            thread_id: e.thread_id,
            mechanism: e.mechanism.map(|m| Mechanism {
                ty: m.ty,
                handled: m.handled,
                ..Default::default()
            }),
            ..Default::default()
        })
        .collect();
    let mut debug_meta = event.debug_meta.into_owned();
    debug_meta.images = debug_meta
        .images
        .into_iter()
        .map(image_file_names)
        .collect();
    Event {
        event_id: event.event_id,
        level: event.level,
        timestamp: event.timestamp,
        platform: event.platform,
        release: event.release,
        environment: event.environment,
        server_name: event.server_name,
        sdk: event.sdk,
        message: event.message.map(|m| {
            if Some(m.as_str()) == fixed {
                m
            } else {
                WITHHELD.to_string()
            }
        }),
        tags: event
            .tags
            .into_iter()
            .filter(|(k, _)| k == EXIT_CODE)
            .collect(),
        contexts: event
            .contexts
            .into_iter()
            .filter(|(k, _)| KEPT_CONTEXTS.contains(&k.as_str()))
            .map(|(k, context)| match k.as_str() {
                "device" => (k, chip_only(context)),
                _ => (k, context),
            })
            .collect(),
        exception: exception.into(),
        debug_meta: Cow::Owned(debug_meta),
        ..Default::default()
    }
}

fn stacktrace_report_paths(mut stacktrace: Stacktrace, home: &str) -> Stacktrace {
    for frame in &mut stacktrace.frames {
        frame.abs_path = frame.abs_path.as_deref().map(|p| report_path(p, home));
        frame.filename = frame.filename.as_deref().map(|p| report_path(p, home));
    }
    stacktrace
}

/// The device context with only the chip's architecture, the part the
/// privacy policy names. On a Mac the context also holds the model
/// (`MacBookPro18,3`) and its family.
fn chip_only(context: Context) -> Context {
    let arch = match context {
        Context::Device(device) => device.arch,
        _ => None,
    };
    DeviceContext {
        arch,
        ..Default::default()
    }
    .into()
}

/// A debug image as its file names alone. It names a loaded file wherever it
/// was installed, in a folder the owner may have named (`D:\Ada Quill\Apps`,
/// `/Volumes/<name>`). Sentry matches debug files by their id, not their path.
fn image_file_names(image: DebugImage) -> DebugImage {
    match image {
        DebugImage::Apple(mut i) => {
            i.name = file_name(&i.name).to_string();
            DebugImage::Apple(i)
        }
        DebugImage::Symbolic(mut i) => {
            i.name = file_name(&i.name).to_string();
            i.debug_file = i.debug_file.map(|f| file_name(&f).to_string());
            DebugImage::Symbolic(i)
        }
        DebugImage::Wasm(mut i) => {
            i.code_file = file_name(&i.code_file).to_string();
            i.debug_file = i.debug_file.map(|f| file_name(&f).to_string());
            DebugImage::Wasm(i)
        }
        // A UUID, no path.
        DebugImage::Proguard(i) => DebugImage::Proguard(i),
    }
}

/// The last part of a path, by either kind of slash.
fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or_default()
}

/// Forward slashes and no drive letter, so a Windows path and its folder
/// compare the same way a Unix one does.
fn comparable(path: &str) -> String {
    let path = path.replace('\\', "/");
    match path.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => path[2..].to_string(),
        _ => path,
    }
}

/// `path` relative to `folder` when it lies inside it.
fn inside<'a>(path: &'a str, folder: &str) -> Option<&'a str> {
    // `env::home()` is `/` when no home is set, which is no folder to hide.
    if folder.len() < 2 {
        return None;
    }
    path.strip_prefix(&format!("{}/", comparable(folder).trim_end_matches('/')))
}

/// A file path as a report may carry it, by the office's rule (`reportPath`
/// in `apps/office/src/lib/diagnostics.ts`). Under Oddboro's own code it
/// becomes relative to it; inside a package, it keeps the part from
/// `node_modules/` on; anywhere else under the home folder it becomes its
/// file name alone, since the folders there can name the owner's work. A path
/// outside the home folder (a system library, the installed app) stays as it
/// is, and so does anything that is not a file path.
fn report_path(path: &str, home: &str) -> String {
    let file = match path.as_bytes() {
        [b'/' | b'\\', ..] => true,
        [drive, b':', b'/' | b'\\', ..] => drive.is_ascii_alphabetic(),
        _ => false,
    };
    if !file {
        return path.to_string();
    }
    let p = comparable(path);
    if let Some(own) = inside(&p, ROOT) {
        return own.to_string();
    }
    if let Some(at) = p.find("/node_modules/") {
        return p[at + 1..].to_string();
    }
    if inside(&p, home).is_some() {
        return file_name(&p).to_string();
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Server;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::process::Command;
    use std::sync::mpsc::Receiver;

    /// Words from an owner's office that must never reach a report.
    const PLANTS: [&str; 4] = [
        "Ada Quill",
        "Juno Brightwater",
        "please book the dentist for Tuesday",
        "ada.quill@example.com",
    ];

    /// What the fake door saw of one request.
    struct Request {
        path: String,
        body: String,
        authorization: Option<String>,
    }

    /// A fake door on a free port. It answers every request with `{}` and
    /// hands over each request's path, body and `authorization` header.
    fn door() -> (String, Receiver<Request>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (got, requests) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming().map_while(Result::ok) {
                let mut reader = BufReader::new(stream);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                let mut length = 0;
                let mut authorization = None;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                        if name.eq_ignore_ascii_case("authorization") {
                            authorization = Some(value.trim().to_string());
                        }
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let _ = reader.get_mut().write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                );
                let _ = got.send(Request {
                    path,
                    body: String::from_utf8_lossy(&body).into_owned(),
                    authorization,
                });
            }
        });
        (
            format!("http://oddboro@127.0.0.1:{port}/oddboro/0"),
            requests,
        )
    }

    fn no_sign_in() -> Option<String> {
        None
    }

    /// A sign-in as the office saves it, with an hour-long token, saved
    /// `ago`. The time is read here, not through `now_ms`, so a wrong unit
    /// there shows at the door.
    fn sign_in_saved(ago: Duration) -> Option<String> {
        let tokens = serde_json::json!({ "access_token": "access-1", "expires_in": 3600 });
        let saved_at = (SystemTime::now() - ago)
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let saved_at = u64::try_from(saved_at).unwrap();
        Some(serde_json::json!({ "tokens": tokens, "savedAt": saved_at }).to_string())
    }

    /// Saved just now, with most of an hour left.
    fn saved_sign_in() -> Option<String> {
        sign_in_saved(Duration::ZERO)
    }

    /// Saved an hour ago, so its token has run out.
    fn run_out_sign_in() -> Option<String> {
        sign_in_saved(Duration::from_secs(3600))
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("oddboro-diagnostics-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn the_one_request(door: &Receiver<Request>) -> Request {
        let request = door
            .recv_timeout(Duration::from_secs(10))
            .expect("nothing reached the door");
        assert!(door.try_recv().is_err(), "more than one request");
        request
    }

    /// The body without the event's `os` context, whose kernel string may
    /// hold the computer's name on Linux (`7.2.11-1-cachyos` on a computer
    /// named `cachyos`).
    fn without_os_context(body: &str) -> String {
        body.lines()
            .map(|line| {
                let mut json: serde_json::Value = serde_json::from_str(line).unwrap();
                if let Some(contexts) = json.get_mut("contexts").and_then(|c| c.as_object_mut()) {
                    contexts.remove("os");
                }
                json.to_string()
            })
            .collect()
    }

    #[test]
    fn a_panic_reaches_the_door_only_after_yes_without_its_message() {
        let (dsn, door) = door();
        let dir = temp_dir("panic");
        let settings = dir.join(".env");
        fs::write(&settings, "OFFICE_DIAGNOSTICS=no\n").unwrap();
        let home = env::home();
        Arc::new(Diagnostics {
            needs_sign_in: needs_sign_in(&dsn, None),
            dsn,
            settings: settings.clone(),
            home: home.clone(),
            sign_in: no_sign_in,
        })
        .watch_panics();
        let planted = home.join("plant-folder");
        let panic_with_plants = || {
            let _ = panic::catch_unwind(|| {
                panic!("MARK {} {}", PLANTS.join(" "), planted.display());
            });
        };

        panic_with_plants();
        assert!(door.try_recv().is_err(), "a report left before yes");

        fs::write(&settings, "OFFICE_DIAGNOSTICS=yes\n").unwrap();
        panic_with_plants();
        let Request {
            path,
            body,
            authorization,
        } = the_one_request(&door);
        drop(panic::take_hook());
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(path.split('?').next(), Some("/oddboro/api/0/envelope/"));
        assert_eq!(
            authorization, None,
            "a report to the owner's own door got a token"
        );
        assert!(body.contains(WITHHELD), "{body}");
        assert!(body.contains(SERVER_NAME), "{body}");
        let home = home.to_string_lossy();
        let mut never = vec![
            "MARK".to_string(),
            home.to_string(),
            home.replace('\\', "/"),
        ];
        never.extend(PLANTS.map(String::from));
        never.extend(
            ["USER", "USERNAME"]
                .iter()
                .filter_map(|name| std::env::var(name).ok())
                .filter(|v| !v.is_empty()),
        );
        for word in never {
            assert!(!body.contains(&word), "the report holds {word}");
        }
        let hostname = Command::new("hostname").output().unwrap().stdout;
        let hostname = String::from_utf8_lossy(&hostname).trim().to_string();
        assert!(!hostname.is_empty());
        assert!(
            !without_os_context(&body).contains(&hostname),
            "the report holds the computer's name"
        );
    }

    #[test]
    fn giving_up_sends_a_fixed_message_and_the_exit_code_never_the_log() {
        let (dsn, door) = door();
        let dir = temp_dir("gave-up");
        let settings = dir.join(".env");
        fs::write(&settings, "OFFICE_DIAGNOSTICS=yes\n").unwrap();
        let log = dir.join("office.log");
        fs::write(&log, "LOGMARK\n").unwrap();
        let server = Server {
            node: PathBuf::new(),
            code: PathBuf::new(),
            port: 0,
            path: String::new(),
            home: dir.clone(),
            log: log.clone(),
            version: String::new(),
            update_token: String::new(),
            diagnostics_dsn: None,
        };
        let why = GaveUp::KeptStopping { code: Some(3) };
        // The owner's dialog shows the log, as `main.rs` builds it.
        assert!(why.message(&server.log_tail()).contains("LOGMARK"));

        Diagnostics {
            needs_sign_in: needs_sign_in(&dsn, None),
            dsn,
            settings,
            home: env::home(),
            sign_in: no_sign_in,
        }
        .gave_up(&why);
        let body = the_one_request(&door).body;
        fs::remove_dir_all(&dir).unwrap();

        assert!(
            body.contains("\"The office stopped 5 times in 10 minutes\""),
            "{body}"
        );
        assert!(body.contains("\"exit_code\":\"3\""), "{body}");
        assert!(!body.contains("LOGMARK"));
        assert!(!body.contains(&*log.to_string_lossy()));
    }

    #[test]
    fn giving_up_and_a_broken_install_reach_the_door_only_after_yes() {
        let dir = temp_dir("consent");
        let answers = [
            ("yes.env", Some("OFFICE_DIAGNOSTICS=yes\n"), 2),
            ("no.env", Some("OFFICE_DIAGNOSTICS=no\n"), 0),
            ("unasked.env", Some("PORT=4500\n"), 0),
            ("missing.env", None, 0),
        ];
        for (name, text, want) in answers {
            let (dsn, door) = door();
            let settings = dir.join(name);
            if let Some(text) = text {
                fs::write(&settings, text).unwrap();
            }
            let diagnostics = Diagnostics {
                needs_sign_in: needs_sign_in(&dsn, None),
                dsn,
                settings,
                home: env::home(),
                sign_in: no_sign_in,
            };
            diagnostics.gave_up(&GaveUp::KeptStopping { code: Some(3) });
            diagnostics.failed(crate::NO_NODE);
            // Each report has reached the door, or never will, by the time
            // its call returns; the wait only catches a late one.
            let mut got = 0;
            while door.recv_timeout(Duration::from_millis(500)).is_ok() {
                got += 1;
            }
            assert_eq!(got, want, "{name}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_settings_file_decides_yes_no_and_unasked() {
        let dir = temp_dir("answer");
        let allowed = |name: &str, text: Option<&str>| {
            let settings = dir.join(name);
            if let Some(text) = text {
                fs::write(&settings, text).unwrap();
            }
            Diagnostics {
                dsn: String::new(),
                settings,
                home: PathBuf::new(),
                needs_sign_in: false,
                sign_in: no_sign_in,
            }
            .allowed()
        };
        let yes = allowed("yes.env", Some("PORT=4500\nOFFICE_DIAGNOSTICS=yes\n"));
        let no = allowed("no.env", Some("OFFICE_DIAGNOSTICS=no\n"));
        let unasked = allowed("unasked.env", Some("PORT=4500\n"));
        let no_file = allowed("missing.env", None);
        fs::remove_dir_all(&dir).unwrap();

        assert!(yes);
        assert!(!no);
        assert!(!unasked);
        assert!(!no_file);
    }

    #[test]
    fn finding_the_address_prefers_the_environment_then_the_build_then_the_settings_file() {
        let dir = temp_dir("address");
        let file = dir.join("set.env");
        fs::write(&file, "ODDBORO_DIAGNOSTICS_DSN=http://file@127.0.0.1/3\n").unwrap();
        let empty = dir.join("empty.env");
        fs::write(&empty, "ODDBORO_DIAGNOSTICS_DSN=\n").unwrap();
        let missing = dir.join("missing.env");
        let environment = || Some("http://env@127.0.0.1/1".to_string());
        let built = Some("http://built@127.0.0.1/2");
        let found = |environment, built, settings: &Path| {
            find_setting(DSN_KEY, environment, built, settings)
        };

        assert_eq!(
            found(environment(), built, &file).as_deref(),
            Some("http://env@127.0.0.1/1")
        );
        assert_eq!(
            found(Some(String::new()), built, &file).as_deref(),
            Some("http://built@127.0.0.1/2")
        );
        assert_eq!(
            found(None, Some(""), &file).as_deref(),
            Some("http://file@127.0.0.1/3")
        );
        assert_eq!(found(Some(String::new()), Some(""), &empty), None);
        assert_eq!(found(None, None, &missing), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_report_keeps_only_the_fixed_message_the_exit_code_and_three_contexts() {
        let mut event = Event {
            message: Some(PLANTS[0].to_string()),
            tags: Map::from([
                (EXIT_CODE.to_string(), "3".to_string()),
                ("owner".to_string(), PLANTS[1].to_string()),
            ]),
            user: Some(sentry::protocol::User {
                email: Some(PLANTS[3].to_string()),
                ..Default::default()
            }),
            extra: Map::from([("chat".to_string(), PLANTS[2].into())]),
            ..Default::default()
        };
        for name in ["os", "rust", "device", "app"] {
            event.contexts.insert(
                name.to_string(),
                sentry::protocol::Context::Other(Map::from([(
                    "plant".to_string(),
                    format!("{name} {}", PLANTS[1]).into(),
                )])),
            );
        }
        let fixed = event.clone();

        let withheld = scrub(event, "", None);
        let kept = scrub(
            Event {
                message: Some("The office could not start".to_string()),
                ..fixed
            },
            "",
            Some("The office could not start"),
        );

        assert_eq!(withheld.message.as_deref(), Some(WITHHELD));
        assert_eq!(kept.message.as_deref(), Some("The office could not start"));
        assert_eq!(
            withheld.tags,
            Map::from([(EXIT_CODE.to_string(), "3".to_string())])
        );
        assert!(withheld.user.is_none());
        assert!(withheld.extra.is_empty());
        let mut contexts: Vec<&str> = withheld.contexts.keys().map(String::as_str).collect();
        contexts.sort_unstable();
        assert_eq!(contexts, ["device", "os", "rust"]);
    }

    #[test]
    fn a_path_keeps_oddboros_own_folders_and_a_packages_and_only_the_file_name_of_anything_else_in_the_home_folder(
    ) {
        let home = "/home/ada";
        let windows = "C:\\Users\\ada";
        let s = str::to_string;
        let cases = [
            // A release's own frame, as its build maps the repo.
            (
                s("/oddboro/apps/desktop/src-tauri/src/main.rs"),
                home,
                "apps/desktop/src-tauri/src/main.rs",
            ),
            (
                s("/oddboro\\apps\\desktop\\src-tauri\\src\\main.rs"),
                windows,
                "apps/desktop/src-tauri/src/main.rs",
            ),
            // A development build, whose checkout is not mapped.
            (
                format!("{home}/git/oddboro/apps/desktop/src-tauri/src/main.rs"),
                home,
                "main.rs",
            ),
            (
                format!("{home}/plant-folder/node_modules/pkg/index.js"),
                home,
                "node_modules/pkg/index.js",
            ),
            (format!("{home}/plant-folder/clients/x.js"), home, "x.js"),
            (
                format!("{windows}\\AppData\\Local\\Oddboro\\oddboro.exe"),
                windows,
                "oddboro.exe",
            ),
            (s("/usr/lib/libgtk-3.so.0"), home, "/usr/lib/libgtk-3.so.0"),
            (
                s("/Applications/Oddboro.app/Contents/MacOS/oddboro"),
                home,
                "/Applications/Oddboro.app/Contents/MacOS/oddboro",
            ),
            (
                s("/cargo/registry/src/index.crates.io/sentry-0.49.5/src/lib.rs"),
                home,
                "/cargo/registry/src/index.crates.io/sentry-0.49.5/src/lib.rs",
            ),
            (s("<unknown>"), home, "<unknown>"),
        ];
        for (path, home, want) in cases {
            assert_eq!(report_path(&path, home), want, "{path}");
        }
        // `/` is no folder to hide: what `env::home()` gives with no home set.
        let anywhere = format!("{home}/x.rs");
        assert_eq!(report_path(&anywhere, "/"), anywhere);
    }

    #[test]
    fn a_frame_follows_the_path_rule_and_a_debug_image_keeps_only_its_file_name() {
        let home = "/home/ada";
        let planted = format!("{home}/plant-folder/clients/x.js");
        let frame = |path: &str| sentry::protocol::Frame {
            abs_path: Some(path.to_string()),
            filename: Some(path.to_string()),
            ..Default::default()
        };
        let image = |path: &str| -> DebugImage {
            sentry::protocol::SymbolicDebugImage {
                name: path.to_string(),
                arch: None,
                image_addr: sentry::protocol::Addr(0),
                image_size: 0,
                image_vmaddr: sentry::protocol::Addr(0),
                id: Default::default(),
                code_id: None,
                debug_file: Some(path.to_string()),
            }
            .into()
        };
        let images = [
            (planted.as_str(), "x.js"),
            ("D:\\Ada Quill\\Apps\\Oddboro\\oddboro.exe", "oddboro.exe"),
            (
                "/Volumes/Ada Quill/Oddboro.app/Contents/MacOS/oddboro",
                "oddboro",
            ),
            ("/usr/lib/libgtk-3.so.0", "libgtk-3.so.0"),
        ];
        let event = Event {
            exception: vec![Exception {
                stacktrace: Some(Stacktrace {
                    frames: vec![frame(&planted), frame("/usr/lib/libgtk-3.so.0")],
                    ..Default::default()
                }),
                ..Default::default()
            }]
            .into(),
            debug_meta: Cow::Owned(sentry::protocol::DebugMeta {
                images: images.iter().map(|(path, _)| image(path)).collect(),
                ..Default::default()
            }),
            ..Default::default()
        };

        let sent = serde_json::to_value(scrub(event, home, None)).unwrap();

        let frames: Vec<&str> = sent["exception"]["values"][0]["stacktrace"]["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["abs_path"].as_str().unwrap())
            .collect();
        assert_eq!(frames, ["x.js", "/usr/lib/libgtk-3.so.0"]);
        let files = |key: &str| -> Vec<String> {
            sent["debug_meta"]["images"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i[key].as_str().unwrap().to_string())
                .collect()
        };
        let want: Vec<&str> = images.iter().map(|(_, file)| *file).collect();
        assert_eq!(files("name"), want);
        assert_eq!(files("debug_file"), want);
    }

    #[test]
    fn the_device_context_keeps_only_the_chip() {
        let mut event = Event::default();
        event.contexts.insert(
            "device".to_string(),
            DeviceContext {
                model: Some("MacBookPro18,3".to_string()),
                family: Some("MacBookPro".to_string()),
                name: Some(PLANTS[0].to_string()),
                arch: Some("aarch64".to_string()),
                ..Default::default()
            }
            .into(),
        );

        let sent = scrub(event, "", None);

        assert_eq!(
            serde_json::to_value(&sent.contexts["device"]).unwrap(),
            serde_json::json!({ "type": "device", "arch": "aarch64" })
        );
    }

    #[test]
    fn a_saved_sign_in_gives_its_token_only_with_a_minute_left() {
        let now: u128 = 1_800_000_000_000;
        let hour_ms = 3_600_000;
        let saved = |left_ms: u128| {
            let saved_at = u64::try_from(now + left_ms - hour_ms).unwrap();
            serde_json::json!({
                "tokens": { "access_token": "access-1", "expires_in": 3600 },
                "savedAt": saved_at
            })
            .to_string()
        };
        assert_eq!(
            access_token(&saved(600_000), now).as_deref(),
            Some("access-1")
        );
        assert_eq!(
            access_token(&saved(61_000), now).as_deref(),
            Some("access-1")
        );
        assert_eq!(access_token(&saved(60_000), now), None);
        assert_eq!(access_token(&saved(59_000), now), None);
        // A line break after the value, as a command line read may print.
        let with_line_break = format!("{}\n", saved(600_000));
        assert_eq!(
            access_token(&with_line_break, now).as_deref(),
            Some("access-1")
        );

        let missing = [
            serde_json::json!({ "tokens": { "expires_in": 3600 }, "savedAt": 1 }),
            serde_json::json!({ "tokens": { "access_token": "access-1" }, "savedAt": 1 }),
            serde_json::json!({ "tokens": { "access_token": "access-1", "expires_in": 3600 } }),
        ];
        for saved in missing {
            assert_eq!(access_token(&saved.to_string(), 0), None, "{saved}");
        }
        assert_eq!(access_token("not json", 0), None);
        assert_eq!(access_token("", 0), None);
    }

    #[test]
    fn only_new_altitudes_https_address_or_the_account_site_needs_a_sign_in() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../office/src/lib/needs-sign-in.cases.json"
        ))
        .unwrap();
        assert!(!cases.is_empty(), "no cases to check");
        for case in cases {
            let dsn = case["dsn"].as_str().unwrap();
            let want = case["needs"].as_bool().unwrap();
            assert_eq!(needs_sign_in(dsn, case["site"].as_str()), want, "{case}");
        }
    }

    #[test]
    fn a_report_that_needs_a_sign_in_goes_with_its_token_or_not_at_all() {
        let dir = temp_dir("sign-in");
        let settings = dir.join("settings");
        fs::write(&settings, "OFFICE_DIAGNOSTICS=yes\n").unwrap();
        let report = |sign_in: fn() -> Option<String>| {
            let (dsn, door) = door();
            // The account site on the door's host, as in development.
            let needs_sign_in = needs_sign_in(&dsn, Some("http://127.0.0.1:4598"));
            assert!(needs_sign_in);
            Diagnostics {
                dsn,
                settings: settings.clone(),
                home: env::home(),
                needs_sign_in,
                sign_in,
            }
            .failed(crate::NO_NODE);
            door
        };

        let signed_in = the_one_request(&report(saved_sign_in));
        let signed_out = report(no_sign_in).recv_timeout(Duration::from_millis(500));
        let run_out = report(run_out_sign_in).recv_timeout(Duration::from_millis(500));
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(signed_in.authorization.as_deref(), Some("Bearer access-1"));
        assert!(!signed_in.body.contains("access-1"), "{}", signed_in.body);
        assert!(signed_out.is_err(), "a report left while signed out");
        assert!(run_out.is_err(), "a report left with a run-out token");
    }

    #[test]
    fn only_an_address_that_needs_a_sign_in_is_given_the_token() {
        let dir = temp_dir("needs-sign-in");
        let door = "ODDBORO_DIAGNOSTICS_DSN=http://k@127.0.0.1:4599/oddboro/0\n";
        let site = "ODDBORO_ACCOUNT_SITE=http://127.0.0.1:4598\n";
        let own = dir.join("own.env");
        fs::write(
            &own,
            "ODDBORO_DIAGNOSTICS_DSN=https://own@o1.ingest.sentry.io/2\n",
        )
        .unwrap();
        let local = dir.join("local.env");
        fs::write(&local, door).unwrap();
        let site_in_file = dir.join("site.env");
        fs::write(&site_in_file, format!("{door}{site}")).unwrap();
        let missing = dir.join("missing.env");
        let nothing = |_: &str| None;
        let site_in_environment =
            |key: &str| (key == ACCOUNT_SITE_KEY).then(|| "http://127.0.0.1:4598".to_string());
        let needs = |environment: &dyn Fn(&str) -> Option<String>, built, settings: &Path| {
            Diagnostics::from_settings(environment, built, settings.to_path_buf())
                .expect("no address found")
                .needs_sign_in
        };

        let own_sentry = needs(&nothing, None, &own);
        let no_site = needs(&nothing, None, &local);
        let from_file = needs(&nothing, None, &site_in_file);
        let from_environment = needs(&site_in_environment, None, &local);
        let release = needs(
            &nothing,
            Some("https://oddboro@relay.newaltitude.ai/oddboro/0"),
            &missing,
        );
        fs::remove_dir_all(&dir).unwrap();

        assert!(
            !own_sentry,
            "a source build's own Sentry would get the token"
        );
        assert!(
            !no_site,
            "a local address with no account site needs a sign-in"
        );
        assert!(
            from_file,
            "the account site in the settings file was missed"
        );
        assert!(
            from_environment,
            "the account site in the environment was missed"
        );
        assert!(release, "a release's New Altitude address needs no sign-in");
    }

    #[test]
    fn the_shell_reads_the_sign_in_where_the_office_keeps_it() {
        let keyring = [
            "lookup",
            "service",
            "oddboro",
            "account",
            "new-altitude-account:oauth",
        ];
        assert_eq!(KEYRING_READ, ("secret-tool", &keyring[..]));
        // The Mac app's office keeps its secrets through this shell.
        assert_eq!(crate::secrets::SERVICE, "com.oddboro.office");
        assert_eq!(SIGN_IN, "new-altitude-account:oauth");
        #[cfg(target_os = "linux")]
        assert_eq!(sign_in_command(), Some(KEYRING_READ));
        #[cfg(not(target_os = "linux"))]
        assert_eq!(sign_in_command(), None);
    }

    /// Run by hand inside a keyring where an office has signed in.
    #[test]
    #[ignore = "reads the real secret store"]
    fn the_real_secret_store_gives_the_offices_sign_in() {
        let saved = read_sign_in().expect("no sign-in in the secret store");
        assert!(
            access_token(&saved, now_ms()).is_some(),
            "the saved sign-in has no token with a minute left"
        );
    }
}
