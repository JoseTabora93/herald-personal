"""Start a single service worker. Credentials stay in operator-owned environment/files."""

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Herald personal API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    uvicorn.run(
        "herald_personal.api:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        workers=1,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
