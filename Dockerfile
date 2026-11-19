# LLMProxy2 minimal runtime image.
#
# The release pipeline already produces a fully static, CGO-free binary per
# architecture, so the image carries only the binary plus CA certificates and
# tzdata (needed for TLS to upstreams and for cooldown/lease timestamps).
#
# Build (multi-arch, as done in CI):
#   docker buildx build \
#     --build-arg TARGETARCH=amd64 \
#     --build-arg VERSION=v20261119-02 --build-arg SEMVER=2.5.3 --build-arg COMMIT=deadbeef \
#     -t ghcr.io/khc8655/ocrprox2:latest --platform linux/amd64 .
#
# The binary is expected at dist/llmproxy-linux-<TARGETARCH> (produced by
# `npm run build:release`).

ARG TARGETARCH=amd64

# Intermediate stage pinned to the TARGET platform: buildx otherwise resolves an
# anonymous `COPY --from=alpine` against the builder architecture, which broke
# multi-arch builds (zoneinfo/certs paths not found).
FROM --platform=$TARGETPLATFORM alpine:3.20 AS assets

RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -S -g 10001 llmproxy \
 && adduser -S -u 10001 -G llmproxy -h /data -s /sbin/nologin llmproxy

FROM scratch

ARG TARGETARCH
ARG VERSION=dev
ARG SEMVER=0.0.0
ARG COMMIT=unknown

# CA bundle for outbound TLS, tz database for schedule/cooldown math, and the
# standard passwd/group entries so the non-root user resolves correctly.
COPY --from=assets /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=assets /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=assets /etc/passwd /etc/passwd
COPY --from=assets /etc/group /etc/group

# GitHub Release assets arrive without the executable bit, and COPY preserves mode.
# Force 0755 so the ENTRYPOINT can actually exec the binary.
COPY --chmod=0755 dist/llmproxy-linux-${TARGETARCH} /usr/local/bin/llmproxy

ENV TZ=UTC \
    LLMPROXY_ROLE=full \
    LLMPROXY_ADDR=[::]:8787 \
    PORT=8787 \
    CONFIG_DIR=/data

# Runs as root by default so a bind-mounted volume (created by the host user)
# stays writable without chown. For least privilege, pass `--user` with a UID that
# owns the mounted data dir, e.g. `-v $PWD/llmproxy-data:/data --user $(id -u):$(id -g)`.
# The image also ships an `llmproxy` account (UID/GID 10001) for that purpose.

# Full nodes keep configuration here; mount a volume to persist it.
VOLUME ["/data"]
WORKDIR /data

# 8787 = gateway + admin console. Lite mode is zero-disk and ignores /data.
EXPOSE 8787

LABEL org.opencontainers.image.title="LLMProxy2 (OCRProxy v2)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.description="High-performance LLM API gateway (role=lite|full), semver ${SEMVER}" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/local/bin/llmproxy"]