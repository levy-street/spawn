# Linux binaries retain the project's Ubuntu 22.04 / glibc 2.35 floor.
FROM ubuntu:22.04
ARG RUNNER_VERSION
ARG RUNNER_ARCH=x64
ARG RUNNER_SHA256
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh jq sudo unzip zip xz-utils zstd locales \
    build-essential clang cmake pkg-config libssl-dev libicu70 libkrb5-3 \
    liblttng-ust1 libunwind8 libnuma1 libasound2 libnss3 libx11-6 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libxrandr2 \
    libpulse0 libxkbcommon0 libdbus-1-3 libglib2.0-0 libgl1 libglu1-mesa \
    python3 python3-venv python3-pip redis-server ripgrep coturn \
    openjdk-17-jdk-headless openssh-client gnupg && \
    locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 1001 --shell /bin/bash runner && \
    printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner && \
    mkdir -p /opt/actions-runner /opt/hostedtoolcache /opt/cargo /opt/rustup && \
    chown -R runner:runner /opt/actions-runner /opt/hostedtoolcache /opt/cargo /opt/rustup
# Release and native evidence scripts use Python 3.11+ stdlib APIs. Keep a
# modern interpreter without raising the Ubuntu/glibc binary compatibility floor.
RUN python3 -m pip install --no-cache-dir uv==0.11.8 && \
    UV_PYTHON_INSTALL_DIR=/opt/python uv python install 3.13 && \
    ln -s "$(UV_PYTHON_INSTALL_DIR=/opt/python uv python find 3.13)" /usr/local/bin/python3
RUN test -n "$RUNNER_VERSION" && test -n "$RUNNER_SHA256" && \
    curl -fsSL --retry 3 "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" -o /tmp/runner.tar.gz && \
    printf '%s  /tmp/runner.tar.gz\n' "$RUNNER_SHA256" | sha256sum -c - && \
    tar -xzf /tmp/runner.tar.gz --no-same-owner -C /opt/actions-runner && \
    rm /tmp/runner.tar.gz && chown -R runner:runner /opt/actions-runner
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo \
    RUNNER_TOOL_CACHE=/home/runner/.cache/runner-tools AGENT_TOOLSDIRECTORY=/home/runner/.cache/runner-tools \
    CARGO_BUILD_JOBS=3 SPAWN_RUNNER_ISOLATION=container
ENV PATH=/opt/cargo/bin:/home/runner/.local/bin:${PATH}
USER runner
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh && \
    sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable && \
    rm /tmp/rustup-init.sh
ENV CARGO_HOME=/home/runner/.cargo
COPY --chown=runner:runner runner-entrypoint.py /opt/runner-entrypoint.py
WORKDIR /opt/actions-runner
ENTRYPOINT ["python3", "/opt/runner-entrypoint.py"]
