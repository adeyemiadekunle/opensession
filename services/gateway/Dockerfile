# OpenSession gateway (FastAPI). Runs next to the sandboxes and talks to them over
# their private networks, which is required on Docker Desktop (Windows/macOS).
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir ".[e2b]"

ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8000
EXPOSE 8000
CMD ["opensession"]
