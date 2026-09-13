# Native daemon-only builder; preserve Ubuntu 22.04 / glibc 2.35 compatibility.
FROM ubuntu:22.04
ARG RUNNER_VERSION
ARG RUNNER_SHA256
ENV DEBIAN_FRONTEND=noninteractive
RUN test "$(uname -m)" = aarch64 && \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git sudo unzip zip xz-utils zstd locales \
    build-essential pkg-config libssl-dev libicu70 libkrb5-3 \
    liblttng-ust1 libunwind8 python3 file && \
    locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 1001 --shell /bin/bash runner && \
    printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner && \
    mkdir -p /opt/actions-runner /opt/cargo /opt/rustup && \
    chown -R runner:runner /opt/actions-runner /opt/cargo /opt/rustup
RUN test -n "$RUNNER_VERSION" && test -n "$RUNNER_SHA256" && \
    curl -fsSL --retry 3 "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" -o /tmp/runner.tar.gz && \
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
