from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "smartaf_maintenance.py"
)
SPEC = importlib.util.spec_from_file_location(
    "smartaf_maintenance",
    MODULE_PATH,
)
assert SPEC is not None and SPEC.loader is not None
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def test_repository_path_rejects_traversal_and_absolute_paths(self) -> None:
        for value in ("../status", "/health/current.json", "a/../../b"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    maintenance.validate_repository_path(value)

    def test_extract_report_timestamp_supports_all_report_shapes(self) -> None:
        expected = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)
        for field in (
            "timestamp",
            "finished_at",
            "processed_at",
            "started_at",
            "created_at",
        ):
            with self.subTest(field=field):
                actual = maintenance.extract_report_timestamp(
                    {field: "2026-07-01T10:00:00+00:00"}
                )
                self.assertEqual(expected, actual)

    def test_retention_requires_age_and_count_thresholds(self) -> None:
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        reports = [
            {
                "path": f"reports/{index}.json",
                "timestamp": now - timedelta(days=age),
            }
            for index, age in enumerate((1, 2, 120, 121, 122))
        ]
        candidates = maintenance.select_retention_candidates(
            reports,
            now=now,
            keep_days=90,
            keep_count=3,
        )
        self.assertEqual(
            ["reports/3.json", "reports/4.json"],
            [candidate["path"] for candidate in candidates],
        )

    def test_retention_never_deletes_new_reports_outside_keep_count(self) -> None:
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        reports = [
            {
                "path": f"reports/{index}.json",
                "timestamp": now - timedelta(days=index),
            }
            for index in range(20)
        ]
        candidates = maintenance.select_retention_candidates(
            reports,
            now=now,
            keep_days=90,
            keep_count=10,
        )
        self.assertEqual([], candidates)

    def test_retention_preserves_old_reports_inside_keep_count(self) -> None:
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        reports = [
            {
                "path": f"reports/{index}.json",
                "timestamp": now - timedelta(days=100 + index),
            }
            for index in range(10)
        ]
        candidates = maintenance.select_retention_candidates(
            reports,
            now=now,
            keep_days=90,
            keep_count=10,
        )
        self.assertEqual([], candidates)

    def test_health_fingerprint_ignores_only_observation_time(self) -> None:
        first = {
            "observed_at": "2026-07-26T10:00:00+00:00",
            "overall_status": "healthy",
        }
        second = {
            "observed_at": "2026-07-26T11:00:00+00:00",
            "overall_status": "healthy",
        }
        degraded = {
            "observed_at": "2026-07-26T11:00:00+00:00",
            "overall_status": "degraded",
        }
        self.assertEqual(
            maintenance.health_fingerprint(first),
            maintenance.health_fingerprint(second),
        )
        self.assertNotEqual(
            maintenance.health_fingerprint(first),
            maintenance.health_fingerprint(degraded),
        )

    def test_missing_core_state_does_not_create_false_degraded_health(
        self,
    ) -> None:
        config = {
            "nodered_addon_slug": "node_red",
            "flows_path": "/flows.json",
        }
        component_values = {
            "supervisor_health": {
                "healthy": True,
                "supported": True,
            },
            "core_health": {"version": "2026.7.3"},
            "self_health": {"state": "started"},
            "addon_health": {"state": "started"},
            "flow_health": {"baseline_in_sync": True},
            "integration_health": {"version": "0.5.1"},
        }
        with (
            patch.object(
                maintenance,
                "supervisor_health",
                return_value=component_values["supervisor_health"],
            ),
            patch.object(
                maintenance,
                "core_health",
                return_value=component_values["core_health"],
            ),
            patch.object(
                maintenance,
                "self_health",
                return_value=component_values["self_health"],
            ),
            patch.object(
                maintenance,
                "addon_health",
                return_value=component_values["addon_health"],
            ),
            patch.object(
                maintenance,
                "flow_health",
                return_value=component_values["flow_health"],
            ),
            patch.object(
                maintenance,
                "integration_health",
                return_value=component_values["integration_health"],
            ),
        ):
            health = maintenance.build_health(
                config,
                {"enabled": False},
            )
        self.assertEqual("healthy", health["overall_status"])

    def test_explicit_stopped_core_state_is_degraded(self) -> None:
        config = {
            "nodered_addon_slug": "node_red",
            "flows_path": "/flows.json",
        }
        with (
            patch.object(
                maintenance,
                "supervisor_health",
                return_value={"healthy": True, "supported": True},
            ),
            patch.object(
                maintenance,
                "core_health",
                return_value={"state": "stopped"},
            ),
            patch.object(
                maintenance,
                "self_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "addon_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "flow_health",
                return_value={"baseline_in_sync": True},
            ),
            patch.object(
                maintenance,
                "integration_health",
                return_value={"version": "0.5.1"},
            ),
        ):
            health = maintenance.build_health(
                config,
                {"enabled": False},
            )
        self.assertEqual("degraded", health["overall_status"])

    def test_server_only_mode_requires_stopped_node_red_and_started_agent(
        self,
    ) -> None:
        config = {
            "nodered_addon_slug": "node_red",
            "local_agent_slug": "smartaf_local_agent",
            "server_only_mode": True,
            "flows_path": "/flows.json",
        }

        def addon_status(slug: str) -> dict[str, str]:
            return {
                "state": (
                    "stopped" if slug == "node_red" else "started"
                )
            }

        with (
            patch.object(
                maintenance,
                "supervisor_health",
                return_value={"healthy": True, "supported": True},
            ),
            patch.object(
                maintenance,
                "core_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "self_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "addon_health",
                side_effect=addon_status,
            ),
            patch.object(
                maintenance,
                "flow_health",
                return_value={"baseline_in_sync": True},
            ),
            patch.object(
                maintenance,
                "integration_health",
                return_value={"version": "0.5.1"},
            ),
        ):
            health = maintenance.build_health(
                config,
                {"enabled": False},
            )
        self.assertEqual("healthy", health["overall_status"])
        self.assertTrue(health["safety"]["server_only_mode"])

    def test_server_only_mode_rejects_stopped_local_agent(self) -> None:
        config = {
            "nodered_addon_slug": "node_red",
            "local_agent_slug": "smartaf_local_agent",
            "server_only_mode": True,
            "flows_path": "/flows.json",
        }

        with (
            patch.object(
                maintenance,
                "supervisor_health",
                return_value={"healthy": True, "supported": True},
            ),
            patch.object(
                maintenance,
                "core_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "self_health",
                return_value={"state": "started"},
            ),
            patch.object(
                maintenance,
                "addon_health",
                side_effect=(
                    {"state": "stopped"},
                    {"state": "stopped"},
                ),
            ),
            patch.object(
                maintenance,
                "flow_health",
                return_value={"baseline_in_sync": True},
            ),
            patch.object(
                maintenance,
                "integration_health",
                return_value={"version": "0.5.1"},
            ),
        ):
            health = maintenance.build_health(
                config,
                {"enabled": False},
            )
        self.assertEqual("degraded", health["overall_status"])

    def test_retention_failure_before_commit_never_deletes(self) -> None:
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        config = {
            "github_repository": "owner/repository",
            "status_directory": "deployments/status",
        }
        with (
            patch.object(
                maintenance,
                "scan_report_directory",
                side_effect=RuntimeError("temporary GitHub error"),
            ),
            patch.object(maintenance, "delete_report_paths") as delete,
        ):
            with self.assertRaises(RuntimeError):
                maintenance.run_retention(config, now)
            delete.assert_not_called()

    def test_retention_batches_only_eligible_paths(self) -> None:
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        old = {
            "path": "deployments/status/old.json",
            "timestamp": now - timedelta(days=120),
        }
        config = {
            "github_repository": "owner/repository",
            "status_directory": "deployments/status",
            "report_retention_days": 90,
            "report_retention_count": 10,
        }
        reports = [
            {
                "path": f"deployments/status/recent-{index}.json",
                "timestamp": now - timedelta(days=index),
            }
            for index in range(10)
        ] + [old]
        scan_result = {
            "directory": "deployments/status",
            "status": "ok",
            "file_count": len(reports),
            "timestamped_count": len(reports),
            "preserved_unparseable_count": 0,
        }

        def scan_side_effect(
            _config: dict[str, object],
            directory: str,
        ) -> tuple[list[dict[str, object]], dict[str, object]]:
            if directory == "deployments/status":
                return reports, dict(scan_result)
            return [], {
                "directory": directory,
                "status": "missing",
                "file_count": 0,
                "timestamped_count": 0,
                "preserved_unparseable_count": 0,
            }

        with (
            patch.object(
                maintenance,
                "scan_report_directory",
                side_effect=scan_side_effect,
            ),
            patch.object(
                maintenance,
                "delete_report_paths",
                return_value="commit-sha",
            ) as delete,
        ):
            result = maintenance.run_retention(config, now)
        delete.assert_called_once()
        self.assertEqual(
            ["deployments/status/old.json"],
            delete.call_args.args[1],
        )
        self.assertEqual(1, result["deleted_count"])


if __name__ == "__main__":
    unittest.main()
