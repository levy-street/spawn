# Local patch to webrtc 0.17.2

Source: the unmodified crates.io `webrtc` 0.17.2 package, checksum
`baaacdf9d96224d7b6e2872ba065578f38775f7634367e3ac2cc87c7271da433`,
from upstream commit `1da3fe8ee84db8d266322cbcfcb357c745959a8e`.
`LICENSE-MIT` and `LICENSE-APACHE` are copied from that upstream commit's
repository root. Cargo's cache marker and the package's standalone lockfile
are omitted; the daemon's lockfile owns dependency resolution. This crate is
excluded from the daemon workspace to avoid adding its optional OpenSSL
feature dependencies to that lockfile.

The patch replaces the SCTP transport's channel vector with a registry that
prunes `Closed` channels when another channel is admitted, for both remotely
accepted and locally created channels. The previous vector retained every
closed channel and its callbacks for the entire peer lifetime. Connecting,
open, and closing channels remain registered. The last closed batch remains
until the next admission or parent close; no timer or forced reconnect is added.

The registry keeps a cumulative closed count for `PeerConnectionStats` and
reserves the IDs of pruned channels in a set bounded by the `u16` stream-ID
namespace. `Closed` can precede SCTP reset acknowledgement, so object pruning
must not change the existing policy of avoiding automatic ID reuse during a
parent's lifetime. Stream-ID exhaustion behavior is unchanged. Explicitly
negotiated IDs retain upstream behavior.

Modified upstream files:

- `src/sctp_transport/mod.rs`: registry, admission pruning, cumulative stats,
  and retained ID reservations.
- `src/peer_connection/mod.rs`: local admission and registry access.
- `src/peer_connection/peer_connection_internal.rs`: registry snapshot access.
- `src/sctp_transport/sctp_transport_test.rs`: adapt the existing ID-generator
  fixture to the registry type.
- `src/peer_connection/sdp/sdp_type.rs` and `src/rtp_transceiver/fmtp/mod.rs`:
  remove upstream trailing whitespace from two documentation comments.

Native daemon regressions in `rtc_pair.rs` open and close 256 real host
consumers, exercise a host request, check bounded local channel and remote
consumer ownership, cumulative close stats, and unique allocated IDs, and
require all consumer ownership to disappear after parent close. A separate
`rtc.rs` regression closes a host channel before it opens and checks that
unfired callbacks retain neither channel nor consumer state. They run in the
normal and diagnostics daemon suites, including native Windows CI.

Remove the override once an upstream release provides equivalent closed
channel cleanup without unsafe stream-ID reuse.
