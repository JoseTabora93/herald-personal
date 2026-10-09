"""Daily plan generation, model and opening are separate durable claims."""

import json
import unittest
from unittest import mock

from herald_hermes.daily_jobs import (
    DailyPlanJob,
    JobError,
    cron_commands,
    validate_recommendations,
)

DATE = "2026-10-08"


class DailyJobTests(unittest.TestCase):
    def plan(self):
        return {
            "date": DATE,
            "revision": 1,
            "sources": [
                {
                    "id": "task:t1",
                    "kind": "task",
                    "status": "fresh",
                    "as_of": DATE,
                    "description": "Llamar proveedor",
                }
            ],
            "summary": "Plan base",
            "recommendations": [],
        }

    def test_replay_never_repeats_model_or_app_open(self):
        client = mock.Mock()
        client.request.side_effect = [
            self.plan(),
            {"claimed": False},
            {"claimed": False},
        ]
        model, opener = mock.Mock(), mock.Mock()
        job = DailyPlanJob(
            client,
            app_path="/Applications/Herald Personal.app",
            model=model,
            opener=opener,
        )
        result = job.run(DATE)
        self.assertFalse(result["opened"])
        model.assert_not_called()
        opener.assert_not_called()

    def test_open_requires_claim_and_fixed_argv_not_shell(self):
        client = mock.Mock()
        client.request.side_effect = [self.plan(), {}, {"claimed": True}]
        opener = mock.Mock()
        job = DailyPlanJob(
            client, app_path="/Applications/Herald Personal.app", opener=opener
        )
        result = job.run(DATE)
        self.assertTrue(result["opened"])
        self.assertEqual(
            opener.call_args.args[0],
            [
                "/usr/bin/open",
                "-a",
                "/Applications/Herald Personal.app",
                "--args",
                "--personal-plan",
                DATE,
            ],
        )
        self.assertEqual(
            client.request.call_args_list[-1].args[1],
            "/v1/daily-plans/" + DATE + "/open-claim",
        )

    def test_model_failure_preserves_base_records_safe_error_and_still_opens(self):
        client = mock.Mock()
        client.request.side_effect = [
            self.plan(),
            {"claimed": True},
            {},
            {"claimed": True},
        ]
        model = mock.Mock(side_effect=TimeoutError("PRIVATE PROVIDER SECRET"))
        opener = mock.Mock()
        result = DailyPlanJob(
            client,
            app_path="/Applications/Herald Personal.app",
            model=model,
            opener=opener,
        ).run(DATE)
        self.assertEqual(result["model_error"], "timeout")
        self.assertTrue(result["opened"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertIn(
            mock.call(
                "POST", "/v1/daily-plans/" + DATE + "/model-error", {"error": "timeout"}
            ),
            client.request.call_args_list,
        )

    def test_only_plan_evidence_may_back_recommendations(self):
        payload = {
            "summary": "Revisar el pendiente",
            "recommendations": [
                {
                    "title": "Llamar",
                    "reason": "Tiene fecha",
                    "evidence_refs": ["task:t1"],
                }
            ],
        }
        self.assertEqual(
            validate_recommendations(payload, self.plan())["summary"],
            payload["summary"],
        )
        payload["recommendations"][0]["evidence_refs"] = ["invented:secret"]
        with self.assertRaises(JobError):
            validate_recommendations(payload, self.plan())

    def test_invalid_model_shape_and_empty_evidence_fail_closed(self):
        for payload in (
            {
                "summary": "x",
                "recommendations": [{"title": "x", "reason": "y", "evidence_refs": []}],
            },
            {"summary": "x", "recommendations": [], "command": "open arbitrary"},
        ):
            with self.assertRaises(JobError):
                validate_recommendations(payload, self.plan())

    def test_bad_date_never_calls_api_or_opener(self):
        client = mock.Mock()
        with self.assertRaises(JobError):
            DailyPlanJob(client, app_path="/Applications/Herald Personal.app").run(
                "2026-02-30"
            )
        client.request.assert_not_called()

    def test_successful_model_recommendation_uses_revision_and_fixed_model_label(self):
        client = mock.Mock()
        client.request.side_effect = [
            self.plan(),
            {"claimed": True},
            {},
            {"claimed": False},
        ]
        model = mock.Mock(
            return_value={
                "summary": "Revisar",
                "recommendations": [
                    {
                        "title": "Llamar",
                        "reason": "Pendiente",
                        "evidence_refs": ["task:t1"],
                    }
                ],
            }
        )
        model.model_name = "operator-configured"
        result = DailyPlanJob(
            client, app_path="/Applications/Herald Personal.app", model=model
        ).run(DATE)
        self.assertTrue(result["model_updated"])
        body = client.request.call_args_list[2].args[2]
        self.assertEqual(
            (body["expected_revision"], body["model"]), (1, "operator-configured")
        )

    def test_invalid_provider_response_preserves_plan_and_open_failure_is_explicit(
        self,
    ):
        client = mock.Mock()
        client.request.side_effect = [
            self.plan(),
            {"claimed": True},
            {},
            {"claimed": True},
        ]
        model = mock.Mock(return_value={"summary": "inventado", "recommendations": []})
        opener = mock.Mock(side_effect=OSError("PRIVATE"))
        result = DailyPlanJob(
            client,
            app_path="/Applications/Herald Personal.app",
            model=model,
            opener=opener,
        ).run(DATE)
        self.assertEqual(result["model_error"], "invalid_response")
        self.assertEqual(result["open_error"], "local_open_failed")
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_native_cron_creation_is_paused_and_never_uses_shell_or_private_db(self):
        commands = cron_commands(
            "/trusted/hermes", "/private/hermes-home", "/private/venv/bin/python"
        )
        self.assertEqual(len(commands), 2)
        self.assertIn("0 8 * * *", commands[0])
        self.assertIn("*/5 * * * *", commands[1])
        for argv in commands:
            self.assertEqual(argv[:3], ["/trusted/hermes", "cron", "create"])
            self.assertIn("--paused", argv)
            self.assertIn("--no-agent", argv)
            self.assertIn("--deliver", argv)
            self.assertNotIn("--yolo", argv)
            self.assertNotIn("--accept-hooks", argv)


if __name__ == "__main__":
    unittest.main()
