#!/usr/bin/env python3
"""
zed_gui.py — minimal GUI-automation primitives for driving the Zed Agent Panel on **Wayland**.

WHY THIS EXISTS (and when NOT to use it)
----------------------------------------
Zed is a native GPUI app (no browser, no Electron, no AT-SPI accessibility tree yet), so there are
NO stable selectors — only pixels. This module drives Zed the only way a native Wayland app can be
driven from the outside: kernel-level input injection (`ydotool`) + screen capture (`grim`) + image
template matching (OpenCV) + OCR (`tesseract`) to find/verify on-screen elements.

It is INHERENTLY FRAGILE: it breaks on theme/resolution/font/layout changes and Zed UI updates, and
it needs `/dev/uinput` access (root/udev). For testing the FORK's LOGIC (mode change handling, the
permission gate), prefer the ACP harness `experiments/probe-e-acp-mode-permission.mjs` — it is
deterministic, needs no GUI, and already proves the mode/permission behaviour end-to-end. Use THIS
only when you specifically need to exercise the REAL Zed UI → ACP wiring (what the panel actually
sends), which the ACP harness cannot see.

REQUIREMENTS (see README.md): ydotool + ydotoold running, grim, python3-opencv, tesseract.
"""
from __future__ import annotations
import subprocess
import time
import os
import shutil
import tempfile

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
except Exception as e:  # pragma: no cover
    raise SystemExit(f"opencv (cv2) + numpy required: {e}. On Gentoo: emerge media-libs/opencv (with python) + dev-python/numpy")


def _require(tool: str, hint: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise SystemExit(f"missing '{tool}'. {hint}")
    return path


class ZedGui:
    """Stateless-ish helper: each call shells out to ydotool/grim/tesseract. Coordinates are absolute
    screen pixels (Wayland global space). Construct once, reuse across a test."""

    def __init__(self, settle: float = 0.4):
        self.ydotool = _require("ydotool", "Gentoo: emerge x11-misc/ydotool; then run the ydotoold daemon (see README).")
        self.grim = _require("grim", "Gentoo: emerge gui-apps/grim (Wayland screenshot).")
        self.tesseract = shutil.which("tesseract")  # optional (OCR verification)
        self.settle = settle

    # --- screen capture -------------------------------------------------------------------------
    def screenshot(self, region: tuple[int, int, int, int] | None = None):
        """Capture the screen (or an x,y,w,h region) and return a BGR numpy image."""
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            path = f.name
        try:
            cmd = [self.grim]
            if region:
                x, y, w, h = region
                cmd += ["-g", f"{x},{y} {w}x{h}"]
            cmd += [path]
            subprocess.run(cmd, check=True, capture_output=True)
            img = cv2.imread(path)
            if img is None:
                raise RuntimeError("grim produced no readable image (is a Wayland compositor running?)")
            return img
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    # --- find an element by reference image -----------------------------------------------------
    def find(self, template_png: str, threshold: float = 0.85):
        """Template-match `template_png` (a cropped reference screenshot of the target element) on the
        full screen. Returns the CENTER (x, y) of the best match >= threshold, else None."""
        if not os.path.exists(template_png):
            raise SystemExit(f"reference image not found: {template_png} (capture it first — see README 'Capturing reference images').")
        tmpl = cv2.imread(template_png)
        if tmpl is None:
            raise SystemExit(f"unreadable reference image: {template_png}")
        screen = self.screenshot()
        res = cv2.matchTemplate(screen, tmpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)
        if max_val < threshold:
            return None
        th, tw = tmpl.shape[:2]
        return (max_loc[0] + tw // 2, max_loc[1] + th // 2, float(max_val))

    def wait_for(self, template_png: str, timeout: float = 12.0, threshold: float = 0.85):
        """Poll find() until the element appears or timeout. Returns (x, y, score) or raises."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            hit = self.find(template_png, threshold)
            if hit:
                return hit
            time.sleep(0.4)
        raise TimeoutError(f"element '{template_png}' not found within {timeout}s (threshold {threshold})")

    # --- input injection (ydotool, uinput) ------------------------------------------------------
    def _yd(self, *args: str):
        subprocess.run([self.ydotool, *args], check=True, capture_output=True)
        time.sleep(self.settle)

    def move(self, x: int, y: int):
        self._yd("mousemove", "--absolute", "-x", str(x), "-y", str(y))

    def click(self, x: int | None = None, y: int | None = None):
        if x is not None and y is not None:
            self.move(x, y)
        self._yd("click", "0xC0")  # 0xC0 = left button down+up

    def click_image(self, template_png: str, timeout: float = 12.0, threshold: float = 0.85):
        x, y, _ = self.wait_for(template_png, timeout, threshold)
        self.click(x, y)

    def type_text(self, text: str):
        self._yd("type", text)

    def key(self, *keycodes: str):
        # ydotool key uses Linux input-event keycodes, e.g. '28:1 28:0' = Enter press+release.
        self._yd("key", *keycodes)

    def enter(self):
        self.key("28:1", "28:0")

    # --- verification via OCR -------------------------------------------------------------------
    def read(self, region: tuple[int, int, int, int]) -> str:
        """OCR a screen region (x, y, w, h). Returns the recognised text (lowercased, stripped)."""
        if not self.tesseract:
            raise SystemExit("tesseract not installed (OCR verification). Gentoo: emerge app-text/tesseract.")
        img = self.screenshot(region)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            path = f.name
        try:
            cv2.imwrite(path, img)
            out = subprocess.run([self.tesseract, path, "stdout"], check=True, capture_output=True, text=True)
            return " ".join(out.stdout.split()).lower()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass


def launch_zed(folder: str) -> None:
    """Open `folder` in Zed (the CLI opens/raises a window). The Agent Panel + thread must then be
    opened by the caller (keybinding or click) — Zed exposes no scripting API for that."""
    zed = shutil.which("zed") or shutil.which("zedit") or shutil.which("zeditor")
    if not zed:
        raise SystemExit("`zed` CLI not found on PATH.")
    subprocess.Popen([zed, folder])
    time.sleep(4.0)
