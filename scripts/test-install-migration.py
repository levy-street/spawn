"""Exercise publishing and possession with a pre-store heartbeat and live image."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    installer = Path(sys.argv[1]).resolve()
    server = sys.argv[2]
    assert server.startswith("http://127.0.0.1:"), "migration fixture requires localhost"
    with tempfile.TemporaryDirectory(prefix="spawn-migration-") as temporary:
        root = Path(temporary)
        source = root / "legacy.c"
        # A native process is essential: /proc/<pid>/exe for a shell script
        # names its interpreter, which cannot reproduce a legacy daemon.
        source.write_text(
            '#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n'
            'int main(int argc,char **argv){\n'
            'if(argc>1 && !strcmp(argv[1],"--version")){puts("spawnd 0.0.1+gold");return 0;}\n'
            'if(argc>1 && !strcmp(argv[1],"__build-info"))return 2;\n'
            'while(1)pause();}\n'
        )
        legacy = root / "legacy"
        subprocess.run(["cc", str(source), "-o", str(legacy)], check=True)
        for variant in ("release", "diagnostics"):
            for managed in (False, True):
                case = root / f"{variant}-{managed}"
                binary = case / "bin"
                config = case / "config"
                home = case / "home"
                fakebin = case / "fakebin"
                for path in (binary, config, home, fakebin):
                    path.mkdir(parents=True, mode=0o700)
                log = case / "manager.log"
                for name in ("systemctl", "loginctl"):
                    command = fakebin / name
                    command.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MANAGER_LOG"\nexit 0\n')
                    command.chmod(0o755)
                env = {k: v for k, v in os.environ.items() if not k.startswith(("SPAWN", "XDG_"))}
                env.update(
                    HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
                    SPAWN_CONFIG_DIR=str(config), SPAWN_DISABLE_KEYRING="1", NO_COLOR="1",
                    PATH=str(fakebin) + os.pathsep + os.environ["PATH"], MANAGER_LOG=str(log),
                )
                shutil.copy2(legacy, binary / "spawnd")
                (binary / "spawn-worker").write_bytes(b"legacy worker must stay untouched")
                if managed:
                    units = home / ".config/systemd/user"
                    units.mkdir(parents=True)
                    (units / "spawn-legacy.service").write_text(f'ExecStart="{binary}/spawnd" run\n')
                version = "0.0.1+gold" + (".diagnostics" if variant == "diagnostics" else "")
                creds = config / "credentials.json"
                creds.write_text(json.dumps(dict(access_token="local-fixture", host_id="11111111-1111-1111-1111-111111111111", server_url=server)))
                creds.chmod(0o600)
                credentials_before = creds.read_bytes()
                child = subprocess.Popen([str(binary / "spawnd"), "run"])
                try:
                    (config / "state.json").write_text(json.dumps(dict(
                        pid=child.pid, version=version, connected=True, connected_at=None,
                        server=server, last_error=None, sessions=1,
                    )))
                    result = json.loads(subprocess.check_output([
                        str(installer), "__publish-release", "--install-root", str(case), "--json",
                    ], env=env, text=True))
                    assert not result["cli_replaced"], result
                    assert (binary / "spawnd").read_bytes() == legacy.read_bytes()
                    assert (binary / "spawn-worker").read_bytes() == b"legacy worker must stay untouched"
                    resumed = subprocess.run([
                        str(Path(result["dir"]) / "spawnd"), "--config-dir", str(config), "possess",
                    ], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
                    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
                    selections = list((case / "lib/spawn/instances").glob("*/current/release.json"))
                    assert len(selections) == 1, selections
                    meta = json.loads(selections[0].read_text())
                    assert meta["release_store"] == 1 and meta["variant"] == variant, meta
                    assert meta["version"] != version, meta
                    assert creds.read_bytes() == credentials_before
                    assert child.poll() is None
                    assert "restart" in log.read_text(), log.read_text()
                finally:
                    child.terminate()
                    child.wait(timeout=5)
        print("test-install-migration: PASS legacy pair preserved; possession selects a current matching variant")


if __name__ == "__main__":
    main()
