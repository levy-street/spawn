// spawn-worker — one process per session (docs/SESSIOND.md).
//
// Owns the session's PTY, keeps an encrypted-at-rest scrollback log, and speaks
// a framed protocol over a protected local endpoint to the supervising
// `spawnd`. Owns its process tree independently so the session survives
// spawnd restarts and upgrades.

fn main() -> anyhow::Result<()> {
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--version"))
    {
        println!("{}", spawnd::version::worker_identity_line());
        return Ok(());
    }
    spawnd::sessiond::worker::main()
}
