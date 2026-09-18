# Local patch to webrtc-ice 0.17.2

Source: the crates.io `webrtc-ice` 0.17.2 package, checksum
`5b7fd30f52e6fda8664779b84b7904b2553b76fee24d9ca665e774ae32b13f53`,
from upstream commit `1da3fe8ee84db8d266322cbcfcb357c745959a8e`.
The MIT and Apache licenses are copied from that commit's repository root.
Cargo cache markers and the standalone lockfile are omitted; the daemon
workspace lockfile owns dependency resolution, including upstream test tools.

`src/agent/agent_transport.rs` treats typed UDP route errors
`NetworkUnreachable`, `HostUnreachable`, and `NetworkDown` as a dropped
datagram, returning zero bytes as it already does when no candidate exists.
Other errors and a closed ICE connection still fail. Matching happens before
the upstream error wrapper converts the IO error to a string.

A Windows shared-peer regression reproduced WSAENETUNREACH (10051) during ICE
restart. The error propagated through DTLS into SCTP's write loop, which closed
the whole association. ICE subsequently reported Connected with every existing
data channel Closed and new channels unadmitted. A temporary unavailable route
must instead allow SCTP's existing retransmission timers to recover. This adds
no retry loop, timer, deadline extension, or successful-delivery claim.

`src/agent/agent_transport_test.rs` injects each temporary route error through
a candidate's UDP connection, for both selected and fallback candidate pairs.
The first datagram is dropped; the next reaches a real UDP receiver through
the same ICE connection. Permission errors, broken pipes, and a closed ICE
connection still fail. A Windows-only assertion verifies classification of
the observed Winsock error. The existing real WebRTC shared-peer regression
also runs twenty times in native Windows CI without diagnostic logging.

Remove the override after an upstream release provides equivalent handling.

`src/udp_mux/mod.rs` also removes two redundant references in upstream log
arguments so the vendored crate passes the workspace's current Clippy gate.
