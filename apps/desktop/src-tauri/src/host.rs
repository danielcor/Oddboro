//! The environment a program from the host computer gets.
//!
//! An AppImage points `LD_LIBRARY_PATH` at the glib it bundled. The host's
//! `notify-send`, `secret-tool` and the rest then load that older glib and
//! fail before they run (`undefined symbol: g_once_init_leave_pointer`).
//! Outside an AppImage a host program inherits this process as it always did.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// What one variable becomes for the child. `Remove` unsets it.
#[derive(Debug, PartialEq, Eq)]
enum EnvValue {
    Remove,
    Set(OsString),
}

/// The changes a host program needs inside an AppImage.
#[derive(Debug, PartialEq, Eq)]
struct HostAdjust {
    library_path: EnvValue,
    preload: EnvValue,
    /// Set when `APPDIR` names the mount and `PATH` is set. Otherwise the
    /// child's `PATH` stays as this process has it.
    path: Option<OsString>,
}

/// The names an AppImage runtime may have used to keep the values from before
/// it started. The long name is the usual one. The short name is the other
/// spelling some AppRun scripts write. The first that is set wins, and an
/// empty value means the variable was unset.
const SAVED_LIBRARY_PATH: [&str; 2] = [
    "APPIMAGE_ORIGINAL_LD_LIBRARY_PATH",
    "APPIMAGE_ORIG_LD_LIBRARY_PATH",
];
const SAVED_PRELOAD: [&str; 2] = ["APPIMAGE_ORIGINAL_LD_PRELOAD", "APPIMAGE_ORIG_LD_PRELOAD"];

/// A command that runs a program from the host. Inside an AppImage its
/// library path is the host's, not the bundle's.
pub fn host_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    if env::var_os("APPIMAGE").is_some() || env::var_os("APPDIR").is_some() {
        if let Some(adjust) = host_adjust(env::vars_os()) {
            apply(&mut command, adjust);
        }
    }
    command
}

fn host_adjust<I, K, V>(env_vars: I) -> Option<HostAdjust>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    let vars: Vec<(OsString, OsString)> = env_vars
        .into_iter()
        .map(|(key, value)| (key.as_ref().to_os_string(), value.as_ref().to_os_string()))
        .collect();
    let appimage = lookup(&vars, "APPIMAGE").is_some() || lookup(&vars, "APPDIR").is_some();
    if !appimage {
        return None;
    }
    Some(HostAdjust {
        library_path: restore_or_remove(&vars, &SAVED_LIBRARY_PATH),
        preload: restore_or_remove(&vars, &SAVED_PRELOAD),
        path: lookup(&vars, "APPDIR")
            .and_then(|appdir| lookup(&vars, "PATH").and_then(|path| host_path(appdir, path))),
    })
}

fn lookup<'a>(vars: &'a [(OsString, OsString)], key: &str) -> Option<&'a OsStr> {
    vars.iter()
        .find(|(name, _)| name.as_os_str() == key)
        .map(|(_, value)| value.as_os_str())
}

fn restore_or_remove(vars: &[(OsString, OsString)], saved_names: &[&str]) -> EnvValue {
    let saved = saved_names.iter().find_map(|name| lookup(vars, name));
    match saved {
        Some(value) if !value.is_empty() => EnvValue::Set(value.to_os_string()),
        _ => EnvValue::Remove,
    }
}

/// `PATH` with every entry inside the AppImage mount taken out.
fn host_path(appdir: &OsStr, path: &OsStr) -> Option<OsString> {
    let root = trim_slash(Path::new(appdir));
    if root.as_os_str().is_empty() {
        return None;
    }
    let kept: Vec<PathBuf> = env::split_paths(path)
        .filter(|entry| !trim_slash(entry).starts_with(&root))
        .collect();
    env::join_paths(kept).ok()
}

fn trim_slash(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_path_buf()
    } else {
        PathBuf::from(trimmed.to_owned())
    }
}

fn apply(command: &mut Command, adjust: HostAdjust) {
    match adjust.library_path {
        EnvValue::Remove => {
            command.env_remove("LD_LIBRARY_PATH");
        }
        EnvValue::Set(value) => {
            command.env("LD_LIBRARY_PATH", value);
        }
    }
    match adjust.preload {
        EnvValue::Remove => {
            command.env_remove("LD_PRELOAD");
        }
        EnvValue::Set(value) => {
            command.env("LD_PRELOAD", value);
        }
    }
    if let Some(path) = adjust.path {
        command.env("PATH", path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect()
    }

    fn joined(entries: &[PathBuf]) -> OsString {
        env::join_paths(entries).unwrap()
    }

    /// AppRun writes `$APPDIR/usr/bin/` with a separator on the end.
    fn with_trailing_sep(path: &Path) -> PathBuf {
        let mut text = path.as_os_str().to_os_string();
        text.push(std::path::MAIN_SEPARATOR_STR);
        PathBuf::from(text)
    }

    #[test]
    fn outside_an_appimage_a_host_program_keeps_the_process_environment() {
        assert!(host_adjust(listed(&[
            ("PATH", "/usr/bin"),
            ("LD_LIBRARY_PATH", "/opt/lib")
        ]))
        .is_none());
    }

    #[test]
    fn an_appimage_drops_the_bundled_library_path_and_its_folders_on_path() {
        let mount = PathBuf::from("mount").join("Oddboro");
        let bundled = mount.join("usr").join("bin");
        let sibling = PathBuf::from("mount")
            .join("Oddborox")
            .join("usr")
            .join("bin");
        let host = PathBuf::from("usr").join("bin");
        let adjust = host_adjust(vec![
            (OsString::from("APPDIR"), mount.as_os_str().to_os_string()),
            (
                OsString::from("APPIMAGE"),
                OsString::from("Oddboro.AppImage"),
            ),
            (
                OsString::from("LD_LIBRARY_PATH"),
                mount.join("usr").join("lib").into(),
            ),
            (
                OsString::from("LD_PRELOAD"),
                mount.join("lib").join("preload.so").into(),
            ),
            (
                OsString::from("PATH"),
                joined(&[with_trailing_sep(&bundled), host.clone(), sibling.clone()]),
            ),
        ])
        .expect("running as an AppImage");
        assert_eq!(adjust.library_path, EnvValue::Remove);
        assert_eq!(adjust.preload, EnvValue::Remove);
        assert_eq!(adjust.path, Some(joined(&[host, sibling])));
    }

    #[test]
    fn a_saved_library_path_is_put_back_and_an_empty_one_means_unset() {
        let restored = host_adjust(listed(&[
            ("APPIMAGE", "Oddboro.AppImage"),
            ("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH", "/opt/nvidia"),
            ("LD_LIBRARY_PATH", "mount/usr/lib:/opt/nvidia"),
            ("APPIMAGE_ORIG_LD_PRELOAD", "/opt/preload.so"),
        ]))
        .unwrap();
        assert_eq!(
            restored.library_path,
            EnvValue::Set(OsString::from("/opt/nvidia"))
        );
        assert_eq!(
            restored.preload,
            EnvValue::Set(OsString::from("/opt/preload.so"))
        );
        assert!(restored.path.is_none(), "no APPDIR, so PATH stays");

        // The long name is set and empty, so the short name is not a fallback.
        let cleared = host_adjust(listed(&[
            ("APPDIR", "mount/Oddboro"),
            ("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH", ""),
            ("APPIMAGE_ORIG_LD_LIBRARY_PATH", "/opt/should-not-win"),
            ("PATH", ""),
        ]))
        .unwrap();
        assert_eq!(cleared.library_path, EnvValue::Remove);
        assert_eq!(cleared.preload, EnvValue::Remove);
    }

    #[test]
    fn the_adjust_is_what_the_child_command_receives() {
        let mut command = Command::new("true");
        apply(
            &mut command,
            HostAdjust {
                library_path: EnvValue::Remove,
                preload: EnvValue::Set(OsString::from("/opt/preload.so")),
                path: Some(OsString::from("/usr/bin")),
            },
        );
        let got: Vec<_> = command
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
            .collect();
        assert!(got.contains(&(OsString::from("LD_LIBRARY_PATH"), None)));
        assert!(got.contains(&(
            OsString::from("LD_PRELOAD"),
            Some(OsString::from("/opt/preload.so"))
        )));
        assert!(got.contains(&(OsString::from("PATH"), Some(OsString::from("/usr/bin")))));
    }
}
