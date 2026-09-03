from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch


MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))
sys.modules.setdefault("websocket", MagicMock())
MODULE_PATH = MODULE_DIR / "smartaf_deploy_agent.py"
SPEC = importlib.util.spec_from_file_location(
    "smartaf_deploy_agent",
    MODULE_PATH,
)
assert SPEC is not None and SPEC.loader is not None
deploy_agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_agent)


class DeployRestartTimeoutTests(unittest.TestCase):
    @patch.object(deploy_agent.request, "urlopen")
    def test_http_json_keeps_default_timeout(self, urlopen) -> None:
        response = MagicMock()
        response.read.return_value = b"{}"
        urlopen.return_value.__enter__.return_value = response

        deploy_agent.http_json("https://example.invalid")

        self.assertEqual(30, urlopen.call_args.kwargs["timeout"])

    @patch.object(deploy_agent, "http_json")
    def test_supervisor_request_forwards_explicit_timeout(
        self,
        http_json,
    ) -> None:
        http_json.return_value = {}

        with patch.dict(os.environ, {"SUPERVISOR_TOKEN": "test-token"}):
            deploy_agent.supervisor_request(
                "/addons/example/restart",
                method="POST",
                timeout=120,
            )

        http_json.assert_called_once_with(
            "http://supervisor/addons/example/restart",
            token="test-token",
            method="POST",
            timeout=120,
        )

    @patch.object(deploy_agent.time, "sleep")
    @patch.object(deploy_agent.time, "time")
    @patch.object(deploy_agent, "supervisor_request")
    def test_restart_uses_configured_timeout_for_restart_request(
        self,
        supervisor_request,
        mocked_time,
        _sleep,
    ) -> None:
        supervisor_request.side_effect = [
            {},
            {"data": {"state": "started"}},
            {"data": {"state": "started"}},
        ]
        mocked_time.side_effect = [1000, 1001, 1002]

        deploy_agent.restart_nodered(
            {
                "nodered_addon_slug": "a0d7b954_nodered",
                "restart_timeout_seconds": 120,
            }
        )

        self.assertEqual(
            [
                call(
                    "/addons/a0d7b954_nodered/restart",
                    method="POST",
                    timeout=120,
                ),
                call("/addons/a0d7b954_nodered/info"),
                call("/addons/a0d7b954_nodered/info"),
            ],
            supervisor_request.call_args_list,
        )


if __name__ == "__main__":
    unittest.main()
