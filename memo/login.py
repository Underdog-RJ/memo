import argparse
import os
import plistlib
import subprocess
import sys
from pathlib import Path

LABEL = "local.memo.agent"
ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description="管理 Memo 登录启动")
    parser.add_argument("action", choices=["enable", "disable"])
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("登录启动仅支持 macOS。")
    target = f"gui/{os.getuid()}"
    plist = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    launchctl = "/bin/launchctl"
    if plist.exists():
        subprocess.run([launchctl, "bootout", target, str(plist)], check=False)
    if args.action == "disable":
        plist.unlink(missing_ok=True)
        print("已移除 Memo 登录启动。")
        return

    logs = Path.home() / "Library/Application Support/Memo"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL, "ProgramArguments": [sys.executable, "-m", "memo.server"],
        "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False},
        "StandardOutPath": str(logs / "server.log"), "StandardErrorPath": str(logs / "server-error.log"),
    }
    from .store import atomic_write
    atomic_write(plist, plistlib.dumps(config).decode())
    subprocess.run([launchctl, "bootstrap", target, str(plist)], check=True)
    print("Memo 已设置为登录后启动。")


if __name__ == "__main__":
    main()
