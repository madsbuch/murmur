#!/usr/bin/env python3
"""Exercise camera permission, initialization, cancel, and reopen in a release APK.

Run only on an unlocked, disposable English-language emulator with a back camera.
The script preserves app data and never prints the UI hierarchy or application logs.
"""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET


PACKAGE = "app.murmur.notes"
CAMERA = "android.permission.CAMERA"


def find_adb():
    candidates = [shutil.which("adb")]
    for sdk in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                str(Path.home() / "Library/Android/sdk")):
        if sdk:
            candidates.append(str(Path(sdk) / "platform-tools/adb"))
    return next((path for path in candidates if path and Path(path).is_file()), "adb")


class ScannerCheck:
    def __init__(self, adb, serial):
        self.command = [adb, "-s", serial]
        self.xml_path = f"/data/local/tmp/murmur-scanner-{uuid.uuid4().hex}.xml"
        self.pid = None

    def adb(self, *args, check=True, timeout=30):
        result = subprocess.run(self.command + list(args), capture_output=True,
                                text=True, timeout=timeout)
        if check and result.returncode:
            # Do not accidentally expose note text, invitations, or logs on failure.
            raise RuntimeError(f"adb {args[0]} failed (exit {result.returncode}).")
        return result.stdout.strip()

    def alive(self):
        pids = self.adb("shell", "pidof", PACKAGE, check=False).split()
        if self.pid not in pids:
            raise RuntimeError("Murmur exited or restarted while opening the scanner.")
        logs = self.logs(crash=True)
        if "FATAL EXCEPTION" in logs or "Fatal signal" in logs:
            raise RuntimeError("Android recorded a fatal crash for the Murmur process.")

    def logs(self, crash=False):
        args = ["logcat", "-d", f"--pid={self.pid}", "-v", "brief"]
        if crash:
            args += ["-b", "crash"]
        return self.adb(*args)

    def hierarchy(self):
        self.alive()
        self.adb("shell", "rm", "-f", self.xml_path)
        self.adb("shell", "uiautomator", "dump", self.xml_path, check=False)
        xml = self.adb("shell", "cat", self.xml_path, check=False)
        try:
            return ET.fromstring(xml)
        except ET.ParseError:
            return None

    @staticmethod
    def find(tree, labels=(), resource_ids=()):
        if tree is not None:
            for node in tree.iter("node"):
                label = node.get("text", "").strip() or node.get("content-desc", "").strip()
                resource_id = node.get("resource-id", "").split("/")[-1]
                if (label in labels or resource_id in resource_ids) and node.get("enabled") != "false":
                    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
                    if bounds:
                        x1, y1, x2, y2 = map(int, bounds.groups())
                        if x2 > x1 and y2 > y1:
                            return node, ((x1 + x2) // 2, (y1 + y2) // 2)
        return None

    def tap(self, match):
        _, (x, y) = match
        self.adb("shell", "input", "tap", str(x), str(y))

    def wait_for(self, *labels, resource_ids=(), tap=False, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            match = self.find(self.hierarchy(), labels, resource_ids)
            if match:
                if tap:
                    self.tap(match)
                return match
            time.sleep(0.5)
        raise RuntimeError(f"Timed out waiting for {labels[0] if labels else 'camera permission dialog'}.")

    def open_join(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            tree = self.hierarchy()
            if self.find(tree, ("Scan QR code",)):
                return
            # Fresh install, an existing notebook, or a phone editor after relaunch.
            for label in ("Join another network", "Join a network", "Manage network", "Notes"):
                match = self.find(tree, (label,))
                if match:
                    self.tap(match)
                    break
            time.sleep(0.5)
        raise RuntimeError("Could not reach the join screen without changing notebook data.")

    def assert_scanning(self, previous_streams):
        self.wait_for("Scan an invitation")
        # Preview can start before ML Kit crashes. Require detector initialization
        # and keep the same process alive well beyond the first camera frames.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.alive()
            time.sleep(1)
        self.wait_for("Cancel scanning")
        logs = self.logs()
        if "Selected local version of com.google.mlkit.dynamite.barcode" not in logs:
            raise RuntimeError("The bundled offline barcode detector did not initialize.")
        if logs.count("Update Preview stream state to STREAMING") <= previous_streams:
            raise RuntimeError("A new camera preview did not start streaming.")

    def run(self, apk):
        if self.adb("shell", "getprop", "ro.kernel.qemu") != "1":
            raise RuntimeError("Refusing to run: the selected device is not an emulator.")
        print("Installing release APK without clearing app data...", flush=True)
        self.adb("install", "-r", str(apk), timeout=120)
        package_info = self.adb("shell", "dumpsys", "package", PACKAGE)
        flags = re.findall(r"(?:pkgFlags|flags)=\[([^]]*)\]", package_info)
        if not flags or any("DEBUGGABLE" in value.split() for value in flags):
            raise RuntimeError("This check requires an installed, non-debuggable release APK.")
        self.adb("shell", "am", "force-stop", PACKAGE)
        self.adb("shell", "pm", "revoke", PACKAGE, CAMERA)
        self.adb("shell", "pm", "clear-permission-flags", PACKAGE, CAMERA, "user-set", "user-fixed")
        self.adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
        pids = self.adb("shell", "pidof", PACKAGE).split()
        if len(pids) != 1:
            raise RuntimeError("Murmur did not start with a single main process.")
        self.pid = pids[0]
        self.open_join()
        self.wait_for("Scan QR code", tap=True)
        self.wait_for("While using the app", "Allow", resource_ids=(
            "permission_allow_foreground_only_button", "permission_allow_button"), tap=True)
        print("Checking first scan after camera permission...", flush=True)
        self.assert_scanning(previous_streams=0)
        self.wait_for("Cancel scanning", tap=True)
        self.wait_for("Scan QR code")
        previous_streams = self.logs().count("Update Preview stream state to STREAMING")
        self.wait_for("Scan QR code", tap=True)
        print("Checking scanner reopens after cancellation...", flush=True)
        self.assert_scanning(previous_streams)
        self.wait_for("Cancel scanning", tap=True)
        self.wait_for("Scan QR code")
        self.alive()
        print("PASS: release camera grant, offline detector, cancel, and reopen; app data preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Explicit disposable emulator serial, e.g. emulator-5580")
    parser.add_argument("--apk", required=True, type=Path, help="Signed Murmur release APK")
    parser.add_argument("--adb", default=find_adb(), help="Path to Android SDK adb")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        parser.error("--serial must identify a disposable Android emulator, not a physical device")
    if not args.apk.is_file():
        parser.error("--apk does not exist")
    check = ScannerCheck(args.adb, args.serial)
    try:
        check.run(args.apk.resolve())
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        try:
            check.adb("shell", "rm", "-f", check.xml_path, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
