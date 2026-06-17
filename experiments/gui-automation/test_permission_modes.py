#!/usr/bin/env python3
"""
test_permission_modes.py — SKELETON GUI test of the live permission-mode flow in the REAL Zed UI.

This drives the actual Zed Agent Panel (mouse + keyboard) to verify what the manual test checks:
for each mode, ask claude to create a file and observe whether Zed shows a permission prompt.

IT IS A SCAFFOLD: the `REF` reference images must be captured from YOUR Zed first (see README →
"Capturing reference images"), and the coordinates/regions tuned to your screen. The control flow is
complete; the pixels are yours to fill in.

For the deterministic, no-GUI equivalent (recommended), run instead:
    cd fork && node experiments/probe-e-acp-mode-permission.mjs
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from zed_gui import ZedGui, launch_zed  # noqa: E402

REF = os.path.join(os.path.dirname(__file__), "refs")  # capture these PNGs first (see README)
WORKDIR = os.path.expanduser("~/Desktop/zed-gui-test")  # a folder Zed already trusts


def ref(name: str) -> str:
    return os.path.join(REF, name)


def run() -> None:
    os.makedirs(WORKDIR, exist_ok=True)
    g = ZedGui()

    # 1) Open Zed on the test folder, then open a fresh Agent-Panel thread with the fork agent.
    launch_zed(WORKDIR)
    #    Zed has no scripting API for the panel — open it by your configured keybinding, e.g.:
    #    g.key("125:1", "32:1", "32:0", "125:0")  # Super+A (ADJUST to your keymap), or click the icon:
    g.click_image(ref("agent_panel_icon.png"))            # <-- capture this
    g.click_image(ref("new_thread_button.png"))           # <-- capture this

    # 2) Materialise the session (a baseline message) so the conversation is cached.
    g.click_image(ref("prompt_input.png"))                # <-- capture this (the input box)
    g.type_text("oi")
    g.enter()
    time.sleep(8)  # wait for the reply

    results = {}
    modes = {
        "default": ref("mode_default.png"),
        "acceptEdits": ref("mode_acceptedits.png"),
        "bypassPermissions": ref("mode_bypass.png"),
    }
    for mode, mode_ref in modes.items():
        # 3) Open the mode picker and select `mode`.
        g.click_image(ref("mode_picker.png"))             # <-- the mode dropdown
        g.click_image(mode_ref)                            # <-- the menu entry for this mode
        time.sleep(3)  # settle (re-spawn for bypass)

        # 4) Ask claude to write a file.
        g.click_image(ref("prompt_input.png"))
        g.type_text(f"Crie o arquivo del-{mode}.txt com o conteudo: oi")
        g.enter()

        # 5) Observe: did a permission prompt appear within a short window?
        time.sleep(6)
        prompt_shown = g.find(ref("permission_prompt.png"), threshold=0.82) is not None
        results[mode] = prompt_shown
        if prompt_shown:
            # Approve it so the turn completes (capture the Allow button ref).
            g.click_image(ref("allow_button.png"), timeout=6)
        time.sleep(6)

    # 6) Verdict — the fix is correct when:
    #    default → prompt shown ; acceptEdits → NO prompt ; bypassPermissions → NO prompt.
    print("RESULTS (prompt shown per mode):", results)
    ok = results.get("default") is True and results.get("acceptEdits") is False and results.get("bypassPermissions") is False
    print("VERDICT:", "PASS — permission mode honored in the real Zed UI" if ok else "FAIL/INCONCLUSIVE — see results + refs/coords")


if __name__ == "__main__":
    run()
