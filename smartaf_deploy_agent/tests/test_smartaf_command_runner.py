from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import call, patch


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "smartaf_command_runner.py"
)
SPEC = importlib.util.spec_from_file_location(
    "smartaf_command_runner",
    MODULE_PATH,
)
assert SPEC is not None and SPEC.loader is not None
command_runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(command_runner)


class CommandRunnerSelfMutationTests(unittest.TestCase):
    @patch.object(command_runner, "supervisor_request")
    @patch.object(command_runner, "self_addon_slug")
    @patch.object(command_runner, "installed_addon_slugs")
    def test_self_restart_is_allowed(
        self,
        installed_addon_slugs,
        self_addon_slug,
        supervisor_request,
    ) -> None:
        installed_addon_slugs.return_value = {"smartaf_nodered_deploy"}
        self_addon_slug.return_value = "smartaf_nodered_deploy"

        result = command_runner.execute_command(
            "addon_restart",
            "smartaf_nodered_deploy",
        )

        self.assertEqual(
            {
                "detail": "add-on restart accepted",
                "target": "smartaf_nodered_deploy",
            },
            result,
        )
        supervisor_request.assert_called_once_with(
            "/addons/smartaf_nodered_deploy/restart",
            method="POST",
            timeout=120,
        )

    @patch.object(command_runner, "supervisor_request")
    @patch.object(command_runner, "self_addon_slug")
    @patch.object(command_runner, "installed_addon_slugs")
    def test_self_start_and_update_remain_forbidden(
        self,
        installed_addon_slugs,
        self_addon_slug,
        supervisor_request,
    ) -> None:
        installed_addon_slugs.return_value = {"smartaf_nodered_deploy"}
        self_addon_slug.return_value = "smartaf_nodered_deploy"

        for command in ("addon_start", "addon_update"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(
                    ValueError,
                    "cannot start or update its own add-on",
                ):
                    command_runner.execute_command(
                        command,
                        "smartaf_nodered_deploy",
                    )

        self.assertEqual([], supervisor_request.call_args_list)

    @patch.object(command_runner, "supervisor_request")
    @patch.object(command_runner, "self_addon_slug")
    @patch.object(command_runner, "installed_addon_slugs")
    def test_other_addon_restart_remains_allowed(
        self,
        installed_addon_slugs,
        self_addon_slug,
        supervisor_request,
    ) -> None:
        installed_addon_slugs.return_value = {
            "smartaf_nodered_deploy",
            "a0d7b954_nodered",
        }
        self_addon_slug.return_value = "smartaf_nodered_deploy"

        command_runner.execute_command(
            "addon_restart",
            "a0d7b954_nodered",
        )

        self.assertEqual(
            [
                call(
                    "/addons/a0d7b954_nodered/restart",
                    method="POST",
                    timeout=120,
                )
            ],
            supervisor_request.call_args_list,
        )


if __name__ == "__main__":
    unittest.main()
