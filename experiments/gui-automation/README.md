# GUI automation scaffold — driving the real Zed UI on Wayland

A **scaffold** for automating the Zed Agent Panel with mouse + keyboard, to run the live
permission-mode tests without doing them by hand. Honest framing up front:

> **Prefer the ACP harness.** `../probe-e-acp-mode-permission.mjs` already proves the mode/permission
> behaviour end-to-end (drives the fork over the real ACP wire + real `claude`, no GUI, deterministic).
> It is the recommended automation. Use THIS GUI scaffold only to additionally exercise the **real Zed
> UI → ACP wiring** (what the panel actually sends when you click), which the ACP harness cannot see.

## Why it must be pixel-based (and therefore fragile)

Zed is a native **GPUI** app — not a browser, not Electron. It exposes **no accessibility tree**
(AccessKit for GPUI is planned, not shipped), so there are **no stable selectors**. The only way to
drive it from outside on Wayland is: kernel input injection + screen capture + image matching.
Expect breakage on theme / resolution / font / layout changes and Zed updates. This is a maintenance
cost; budget for it.

## Requirements (Gentoo / bentoo)

```bash
# input injection (Wayland) — talks to /dev/uinput
emerge -av x11-misc/ydotool
# screen capture (Wayland)
emerge -av gui-apps/grim
# image matching + OCR (you already have opencv 5.0 + tesseract)
emerge -av media-libs/opencv      # must be built with the `python` USE flag
emerge -av app-text/tesseract
```

### `/dev/uinput` access for ydotool (root-only by default)

`ydotool` needs `/dev/uinput`, which is `root:root 0600`. Either run `ydotoold` as root, or grant your
user access with a udev rule + group:

```bash
# /etc/udev/rules.d/80-uinput.rules
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
```

```bash
sudo gpasswd -a "$USER" input        # add yourself to the input group
sudo udevadm control --reload && sudo udevadm trigger
# start the daemon (per-session); ydotool talks to it over a socket
ydotoold &                            # or as a user systemd service — see `man ydotoold`
export YDOTOOL_SOCKET=/run/user/$(id -u)/.ydotool_socket   # if your ydotoold uses a custom socket
```

Verify: `ydotool mousemove --absolute -x 100 -y 100` should move the cursor.

## Capturing reference images (one-time, per theme/resolution)

The scaffold finds UI elements by matching small cropped screenshots. Capture them once from YOUR Zed:

```bash
mkdir -p refs
# interactive region grab (slurp picks the rectangle): emerge gui-apps/slurp
grim -g "$(slurp)" refs/agent_panel_icon.png
grim -g "$(slurp)" refs/new_thread_button.png
grim -g "$(slurp)" refs/prompt_input.png
grim -g "$(slurp)" refs/mode_picker.png
grim -g "$(slurp)" refs/mode_default.png
grim -g "$(slurp)" refs/mode_acceptedits.png
grim -g "$(slurp)" refs/mode_bypass.png
grim -g "$(slurp)" refs/permission_prompt.png     # the approve/deny dialog
grim -g "$(slurp)" refs/allow_button.png
```

Crop tightly to the distinctive part of each element (less background → more robust matching).

## Run

```bash
python3 test_permission_modes.py
```

Expected verdict when the fix is correct: **default → prompt shown · acceptEdits → no prompt ·
bypassPermissions → no prompt.**

## Files

- `zed_gui.py` — primitives: `screenshot` (grim), `find`/`wait_for` (OpenCV template match), `click`/
  `type_text`/`key` (ydotool), `read` (grim + tesseract OCR), `launch_zed`.
- `test_permission_modes.py` — the permission-mode test flow (fill in `refs/` + coordinates).

## Limits / gotchas

- **ydotool has no window control** (focus/raise/move) — keep Zed maximised and frontmost; the script
  assumes a stable layout.
- **Multi-monitor / HiDPI**: coordinates are global Wayland pixels; capture refs at the same scale.
- **Timing**: `bypassPermissions`/`dontAsk` re-spawn the agent (a brief reconnect) — the `time.sleep`
  settles are conservative; tune them.
- **Don't run unattended on your main session** — injected input goes to whatever is focused.
