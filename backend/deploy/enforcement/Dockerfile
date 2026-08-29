FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    dnsmasq nftables iproute2 ethtool tcpdump \
    && rm -rf /var/lib/apt/lists/*

