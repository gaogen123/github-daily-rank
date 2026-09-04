#!/usr/bin/env python3
"""Monitor StarRocks capacity and active GitHub Archive import processes."""

from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import TextIO

DEFAULT_STORAGE_PATH = "/data/starrocks/be-storage"
DEFAULT_INTERVAL_SECONDS = 10
DEFAULT_WARNING_PERCENT = 70.0
DEFAULT_CRITICAL_PERCENT = 85.0


def local_file_or_fallback(filename: str, fallback: str) -> str:
    local_path = Path(__file__).resolve().parent / filename
    return str(local_path) if local_path.is_file() else fallback


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default=DEFAULT_STORAGE_PATH, help="StarRocks storage path")
    parser.add_argument(
        "--starrocks-config",
        default=local_file_or_fallback(".starrocks-client.cnf", "/root/.starrocks-client.cnf"),
        help="MySQL client configuration file",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_INTERVAL_SECONDS,
        help="Polling interval in seconds",
    )
    parser.add_argument(
        "--warning",
        type=float,
        default=DEFAULT_WARNING_PERCENT,
        help="Warning threshold percentage",
    )
    parser.add_argument(
        "--critical",
        type=float,
        default=DEFAULT_CRITICAL_PERCENT,
        help="Critical threshold percentage",
    )
    parser.add_argument("--once", action="store_true", help="Check once and exit")
    parser.add_argument("--log-file", help="Append monitoring output to this file")
    return parser.parse_args()


def format_bytes(value: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    amount = float(value)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.1f}{unit}"
        amount /= 1024
    return f"{amount:.1f}TB"


def query_backend(config_path: str) -> dict[str, str]:
    result = subprocess.run(
        [
            "mysql",
            f"--defaults-extra-file={config_path}",
            "--batch",
            "--raw",
            "-e",
            "SHOW BACKENDS",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rows = list(csv.DictReader(result.stdout.splitlines(), delimiter="\t"))
    if not rows:
        raise RuntimeError("SHOW BACKENDS returned no rows")
    alive_rows = [row for row in rows if row.get("Alive", "").lower() == "true"]
    return alive_rows[0] if alive_rows else rows[0]


def count_import_processes() -> tuple[int, int]:
    result = subprocess.run(
        ["ps", "-eo", "args="],
        check=True,
        capture_output=True,
        text=True,
    )
    commands = result.stdout.splitlines()
    ods_count = sum("load_githubarchive_to_starrocks.py" in command for command in commands)
    dwd_count = sum("aggregate_githubarchive_repo_daily.py" in command for command in commands)
    return ods_count, dwd_count


def numeric_percent(value: str | None) -> float:
    if not value:
        return 0.0
    return float(value.strip().removesuffix("%"))


def capacity_status(usage: float, warning: float, critical: float) -> str:
    if usage >= critical:
        return "CRITICAL"
    if usage >= warning:
        return "WARNING"
    return "OK"


def emit(message: str, log: TextIO | None) -> None:
    print(message, flush=True)
    if log is not None:
        print(message, file=log, flush=True)


def check_once(args: argparse.Namespace, log: TextIO | None) -> int:
    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        try:
            disk = shutil.disk_usage(args.path)
            filesystem_path = args.path
        except PermissionError:
            disk = shutil.disk_usage("/")
            filesystem_path = "/"
        filesystem_usage = disk.used / disk.total * 100
        backend = query_backend(args.starrocks_config)
        backend_usage = numeric_percent(backend.get("MaxDiskUsedPct") or backend.get("UsedPct"))
        backend_memory = numeric_percent(backend.get("MemUsedPct"))
        effective_usage = max(filesystem_usage, backend_usage)
        status = capacity_status(effective_usage, args.warning, args.critical)
        ods_count, dwd_count = count_import_processes()

        emit(
            " | ".join(
                (
                    f"[{timestamp}] {status}",
                    f"fs({filesystem_path})={filesystem_usage:.1f}% free={format_bytes(disk.free)}",
                    f"be={backend_usage:.1f}% avail={backend.get('AvailCapacity', '?')}",
                    f"be_data={backend.get('DataUsedCapacity', '?')}",
                    f"tablets={backend.get('TabletNum', '?')}",
                    f"mem={backend_memory:.1f}%",
                    f"queries={backend.get('NumRunningQueries', '?')}",
                    f"imports(ods={ods_count},dwd={dwd_count})",
                    f"alive={backend.get('Alive', '?')}",
                )
            ),
            log,
        )
        return {"OK": 0, "WARNING": 1, "CRITICAL": 2}[status]
    except Exception as error:
        emit(f"[{timestamp}] UNKNOWN | {type(error).__name__}: {error}", log)
        return 3


def validate_args(args: argparse.Namespace) -> None:
    if args.interval <= 0:
        raise ValueError("--interval must be greater than zero")
    if not 0 <= args.warning < args.critical <= 100:
        raise ValueError("thresholds must satisfy 0 <= warning < critical <= 100")
    if not Path(args.starrocks_config).is_file():
        raise FileNotFoundError(args.starrocks_config)


def main() -> int:
    args = parse_args()
    validate_args(args)
    log: TextIO | None = None
    if args.log_file:
        log_path = Path(args.log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = log_path.open("a", encoding="utf-8")

    try:
        if args.once:
            return check_once(args, log)
        while True:
            check_once(args, log)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        emit("monitor stopped", log)
        return 0
    finally:
        if log is not None:
            log.close()


if __name__ == "__main__":
    sys.exit(main())
