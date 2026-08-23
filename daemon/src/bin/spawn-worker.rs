// spawn-worker — one process per session (docs/SESSIOND.md).
//
// Owns the session's PTY, keeps an encrypted-at-rest scrollback log, and speaks
// a framed protocol over a unix socket to the supervising `spawnd`. Runs in
// its own process group so the session survives spawnd restarts and upgrades.

fn main() -> anyhow::Result<()> {
    spawnd::sessiond::worker::main()
}
