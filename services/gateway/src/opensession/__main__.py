"""`python -m opensession` runs the gateway with uvicorn."""

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "opensession.gateway:app",
        host=os.environ.get("GATEWAY_HOST", "127.0.0.1"),
        port=int(os.environ.get("GATEWAY_PORT", "8000")),
    )


if __name__ == "__main__":
    main()
