# Always-on host for the Dallal ETLs (Google Cloud Run Job).
# Runs the exact same Python ETLs as the Mac — no laptop, no GitHub Actions.
FROM python:3.12-slim

# gh CLI (etl_github uses it) + base tools
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt google-cloud-storage pyjwt cryptography requests

COPY *.py ./
COPY data/ ./data/
COPY cloud/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

# First arg selects the job: "hourly" (default) or "derived".
ENTRYPOINT ["./entrypoint.sh"]
