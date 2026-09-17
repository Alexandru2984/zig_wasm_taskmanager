# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# ---------- build stage ----------
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS build
ARG TARGETARCH

RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned Zig toolchain.
RUN curl -fsSL "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz" -o /tmp/zig.tar.xz \
    && echo '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239  /tmp/zig.tar.xz' | sha256sum -c - \
    && mkdir -p /opt/zig \
    && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
    && rm /tmp/zig.tar.xz
ENV PATH="/opt/zig:${PATH}"

WORKDIR /src
COPY build.zig build.zig.zon ./
COPY src ./src
COPY frontend ./frontend
COPY public ./public
COPY scripts/stamp-assets.sh ./scripts/stamp-assets.sh
# zap links facil.io as a shared library that lives only in the build cache,
# so stage the binary together with libfacil.io.so for the runtime image.
RUN zig build -j4 -Doptimize=ReleaseSafe \
    && mkdir -p /out/bin /out/lib \
    && cp zig-out/bin/taskmanager /out/bin/taskmanager \
    && cp "$(ldd zig-out/bin/taskmanager | awk '/libfacil.io.so =>/ {print $3}')" /out/lib/libfacil.io.so \
    && bash scripts/stamp-assets.sh

# ---------- runtime stage ----------
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
ARG VCS_REF=unversioned
LABEL org.opencontainers.image.revision=$VCS_REF \
    io.taskmanager.portable-format="1" \
    io.taskmanager.schema="016"

# ca-certificates + curl: the app shells out to /usr/bin/curl to send email.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=build /out/bin/taskmanager /app/taskmanager
COPY --from=build /out/lib/ /app/lib/
COPY --from=build /src/public /app/public

USER 10001:10001
EXPOSE 9000

# Listen on all interfaces inside the container; the host maps the port.
# LD_LIBRARY_PATH lets the binary find libfacil.io.so staged above.
ENV INTERFACE=0.0.0.0 \
    PORT=9000 \
    LD_LIBRARY_PATH=/app/lib

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:9000/api/ready" || exit 1

CMD ["/app/taskmanager"]
