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
