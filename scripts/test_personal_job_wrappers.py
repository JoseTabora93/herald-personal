"""The installed cron interpreter does not inherit the service's PYTHONPATH."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("script,kind", [("herald_daily_plan.py", "daily"), ("herald_observer.py", "observer")])
def test_installed_wrapper_finds_owned_library_without_shell_environment(tmp_path, script, kind):
    package = tmp_path / "lib/herald_hermes"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "daily_jobs.py").write_text("import json\ndef main(args): print(json.dumps(args))\n")
    target = tmp_path / "hermes-home/scripts" / script
    target.parent.mkdir(parents=True)
    shutil.copyfile(Path(__file__).parents[1] / "integrations/hermes-personal/routines/scripts" / script, target)
    result = subprocess.run([sys.executable, str(target)], env={"PATH": os.environ["PATH"]}, cwd=tmp_path, capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    assert kind in result.stdout and "herald_jobs.json" in result.stdout
