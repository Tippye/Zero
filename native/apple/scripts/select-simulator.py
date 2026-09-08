#!/usr/bin/env python3
"""Select an installed simulator without booting or modifying any device."""

import argparse
import json
import pathlib
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("family", choices=["iPhone", "iPad"])
    parser.add_argument("--report", type=pathlib.Path)
    args = parser.parse_args()
    devices = json.loads(
        subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"])
    )["devices"]
    candidates = []
    for runtime, values in devices.items():
        version = re.search(r"\.iOS-(\d+)-(\d+)(?:-(\d+))?$", runtime)
        if not version:
            continue
        components = tuple(int(value or 0) for value in version.groups())
        # XCUIApplication.open(URL) in the UI suite requires iOS 16.4 or later.
        if components < (16, 4, 0):
            continue
        for device in values:
            if device.get("isAvailable", True) and device["name"].startswith(args.family):
                candidates.append((components, device["name"], runtime, device["udid"]))
    if not candidates:
        parser.error(f"No available {args.family} simulator with iOS 16.4 or later")
    _, name, runtime, udid = max(candidates)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps({"family": args.family, "name": name, "runtime": runtime, "udid": udid}, indent=2)
            + "\n"
        )
    print(udid)


if __name__ == "__main__":
    main()
