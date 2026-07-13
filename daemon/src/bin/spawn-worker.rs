// spawn-worker — one process per agent (docs/SESSIOND.md).
//
// Owns the agent's PTY, keeps an encrypted-at-rest scrollback log, and speaks
// a framed protocol over a unix socket to the supervising `spawnd`. Runs in
// its own process group so the agent survives spawnd restarts and upgrades.

fn main() -> anyhow::Result<()> {
    spawnd::sessiond::worker::main()
}
