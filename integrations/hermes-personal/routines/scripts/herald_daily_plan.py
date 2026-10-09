"""Install under the isolated HERMES_HOME/scripts; cron uses the personal venv."""

from pathlib import Path
import sys

# The isolated cron interpreter must find the same owned library as the service.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))

from herald_hermes.daily_jobs import main

if __name__ == "__main__":
    main(
        [
            "daily",
            "--config",
            str(Path(__file__).resolve().parent.parent / "herald_jobs.json"),
        ]
    )
