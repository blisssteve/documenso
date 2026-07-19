#!/usr/bin/env python3
"""Static regression tests for the fork's Cloud Run deployment workflow."""

from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-cloud-run.yml"
START_SCRIPT = REPO_ROOT / "docker" / "start.sh"


def named_step_script(workflow: str, step_name: str) -> str:
    match = re.search(
        rf"^\s*- name: {re.escape(step_name)}\n\s+run: \|\n(?P<script>(?:\s{{10}}.*\n?)*)",
        workflow,
        flags=re.MULTILINE,
    )
    if match is None:
        raise AssertionError(f"Could not find run script for step {step_name!r}")
    return match.group("script")


class DeployCloudRunWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_deploy_preserves_image_default_command(self) -> None:
        deploy = named_step_script(self.workflow, "Deploy to Cloud Run")
        self.assertNotRegex(
            deploy,
            r"--(?:command|args)(?:=|\s)",
            "Cloud Run must use the image CMD (sh start.sh), which runs Prisma migrations",
        )

    def test_health_check_retries_and_fails_closed(self) -> None:
        health = named_step_script(self.workflow, "Health check")
        self.assertRegex(health, r"for\s+\w+\s+in\s+\$\(seq\s+1\s+\d+\)")
        self.assertRegex(health, r"curl[^\n]+%\{http_code\}")
        self.assertRegex(health, r"\bexit\s+1\b")
        self.assertNotRegex(
            health,
            r"\|\|\s*echo\s+[\"']?000",
            "curl errors must not append a second status code",
        )

    def test_start_script_fails_closed_when_migrations_fail(self) -> None:
        start_script = START_SCRIPT.read_text(encoding="utf-8")
        self.assertRegex(
            start_script,
            r"^#!/bin/sh\nset -eu\n",
            "Migration failure must stop the container before the server starts",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
