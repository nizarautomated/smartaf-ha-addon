from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIRECTORY))
if "websocket" not in sys.modules:
    websocket_stub = types.ModuleType("websocket")
    websocket_stub.WebSocketTimeoutException = TimeoutError
    websocket_stub.create_connection = None
    sys.modules["websocket"] = websocket_stub
SPEC = importlib.util.spec_from_file_location(
    "smartaf_deploy_agent",
    MODULE_DIRECTORY / "smartaf_deploy_agent.py",
)
assert SPEC is not None and SPEC.loader is not None
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


class DiagnosticTests(unittest.TestCase):
    def test_legacy_diagnostic_request_remains_valid(self) -> None:
        validated = agent.validate_diagnostic_request(
            {},
            {
                "diagnostic_id": "legacy-1",
                "entity_ids": ["binary_sensor.motion"],
                "duration_seconds": 10,
            },
        )
        self.assertEqual(
            (
                "legacy-1",
                ["binary_sensor.motion"],
                10,
                [],
                3,
            ),
            validated,
        )

    def test_trace_request_is_bounded_and_domain_restricted(self) -> None:
        validated = agent.validate_diagnostic_request(
            {},
            {
                "diagnostic_id": "trace-1",
                "entity_ids": ["light.kitchen"],
                "duration_seconds": 10,
                "automation_entity_ids": ["automation.kitchen_light"],
                "traces_per_automation": 5,
            },
        )
        self.assertEqual(["automation.kitchen_light"], validated[3])
        self.assertEqual(5, validated[4])
        for automation_ids, trace_count in (
            (["script.kitchen_light"], 1),
            (["automation.kitchen_light"], 6),
        ):
            with self.subTest(
                automation_ids=automation_ids,
                trace_count=trace_count,
            ):
                with self.assertRaises(ValueError):
                    agent.validate_diagnostic_request(
                        {},
                        {
                            "diagnostic_id": "invalid",
                            "entity_ids": ["light.kitchen"],
                            "duration_seconds": 10,
                            "automation_entity_ids": automation_ids,
                            "traces_per_automation": trace_count,
                        },
                    )

    def test_state_summary_excludes_attributes_and_bounds_context(self) -> None:
        summary = agent.state_diagnostic_summary(
            {
                "entity_id": "light.kitchen",
                "state": "on",
                "attributes": {"access_token": "secret", "brightness": 255},
                "last_changed": "2026-08-12T10:00:00+00:00",
                "last_updated": "2026-08-12T10:00:00.100000+00:00",
                "context": {
                    "id": "context-id",
                    "parent_id": "parent-id",
                    "user_id": "user-id",
                    "unexpected": "not-published",
                },
            }
        )
        self.assertNotIn("attributes", summary)
        self.assertEqual(
            {
                "id": "context-id",
                "parent_id": "parent-id",
                "user_id": "user-id",
            },
            summary["context"],
        )

    def test_trace_sanitization_redacts_secrets_and_omits_variables(self) -> None:
        sanitized = agent.sanitize_trace_value(
            {
                "token": "secret",
                "variables": {"mail": "private"},
                "result": {"entity_id": "light.kitchen"},
            }
        )
        self.assertEqual("[redacted]", sanitized["token"])
        self.assertEqual("[omitted]", sanitized["variables"])
        self.assertEqual(
            "light.kitchen",
            sanitized["result"]["entity_id"],
        )

    def test_trace_step_count_remains_accurate_after_output_cap(self) -> None:
        steps, total, dropped = agent.summarize_trace_steps(
            {"action/0": [{"result": {"value": 1}}] * 3},
            0,
        )
        self.assertEqual([], steps)
        self.assertEqual(3, total)
        self.assertEqual(3, dropped)

    def test_collect_traces_uses_only_resolved_automation_id(self) -> None:
        responses = [
            [
                {
                    "run_id": "run-1",
                    "state": "stopped",
                    "timestamp": {
                        "start": "2026-08-12T10:00:00+00:00",
                        "finish": "2026-08-12T10:00:00.250000+00:00",
                    },
                }
            ],
            {
                "run_id": "run-1",
                "state": "stopped",
                "context": {
                    "id": "trace-context",
                    "parent_id": "motion-context",
                    "user_id": None,
                },
                "trace": {
                    "action/0": [
                        {
                            "timestamp": "2026-08-12T10:00:00.100000+00:00",
                            "result": {
                                "params": {
                                    "domain": "light",
                                    "service": "turn_on",
                                    "token": "secret",
                                }
                            },
                        }
                    ]
                },
            },
        ]

        class FakeSocket:
            def close(self) -> None:
                pass

        fake_socket = FakeSocket()
        with (
            patch.object(
                agent,
                "homeassistant_entity_state",
                return_value={"attributes": {"id": "automation-config-id"}},
            ),
            patch.object(
                agent,
                "authenticated_homeassistant_websocket",
                return_value=fake_socket,
            ),
            patch.object(
                agent,
                "homeassistant_websocket_result",
                side_effect=responses,
            ) as websocket_result,
        ):
            report = agent.collect_automation_traces(
                ["automation.kitchen_light"],
                1,
            )

        self.assertEqual(2, websocket_result.call_count)
        self.assertEqual(1, len(report["traces"]))
        trace = report["traces"][0]
        self.assertEqual("automation-config-id", trace["item_id"])
        self.assertEqual(250, trace["timing"]["duration_ms"])
        self.assertEqual("trace-context", trace["context"]["id"])
        self.assertEqual(
            "[redacted]",
            trace["steps"][0]["result"]["params"]["token"],
        )


if __name__ == "__main__":
    unittest.main()
