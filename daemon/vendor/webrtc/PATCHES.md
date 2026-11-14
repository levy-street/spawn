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

## The accept loop outlives a stream that never became a channel

`src/sctp_transport/mod.rs`, `accept_data_channels`: one task accepts every
incoming data channel of a peer connection, and upstream left its loop on any
error from `DataChannel::accept` — silently, unless the error was the
association's own `ErrStreamClosed`. A device that opens a channel and closes
it before the daemon has read its OPEN produces exactly such an error: the
reset stream reads as end-of-stream, which is not a DCEP OPEN
(`InvalidPayloadProtocolIdentifier`). The acceptor was gone from that moment
while ICE, DTLS, the association and every channel already open stayed up, so
the connection looked healthy to both ends and no channel opened on it again
until the daemon restarted. A browser abandons a channel that way whenever an
open takes longer than its timeout, which is whenever the acceptor is held up
— it runs the application's `on_data_channel` handler inline.

The patch separates the two cases. `ErrStreamClosed` — the association has no
more streams to give — still ends the loop and still reaches `on_error`. Any
other error is the end of that one stream: it is logged at warning level and
the loop goes on to the next. Each iteration consumes one stream from the
association's accept queue, so a failing stream cannot spin the loop.

A stream that failed for a reason other than its own reset (a first message
that is not an OPEN, a label that is not UTF-8) stays registered in the
association with nobody reading it, as it did upstream; this patch does not
reset it.

The native daemon regression
`a_stream_that_never_becomes_a_channel_leaves_the_pair_accepting` in
`rtc_pair.rs` sends a first message that is not an OPEN on a new stream and
requires the next channel on the same connection to open.
`a_channel_abandoned_while_admission_is_busy_leaves_the_pair_accepting`
opens and closes a channel while admission is held; that reproduced the
reset-before-OPEN failure for as long as admission ran inside the accept
loop (see the next section), and now covers a channel reset while it waits
to be admitted.

Remove this part of the override once an upstream release keeps accepting
after a per-stream failure.

## A channel's admission runs in a task of its own

`src/sctp_transport/mod.rs`, `accept_data_channels`, and
`src/peer_connection/peer_connection_internal.rs`, the wrapper that hands an
accepted channel to the application's `on_data_channel` handler. Upstream
awaited the handler's future inside the accept loop, and the wrapper held the
handler's mutex across that future as well. One channel whose admission
waited — in the daemon, on the admission lock or on a restarting session's
transition — therefore held up every channel behind it on the connection.
The peer's opens for those timed out, it reset their streams, and (before the
patch above) the first of those resets ended the acceptor.

The loop now calls the handler in the order channels arrive and spawns one
task per channel for the rest: the handler's future, then the registry
insert and accepted count, then `handle_open`, then the opened handler. Each
channel keeps upstream's order of its own steps, so callbacks a handler
installs are in place before the channel opens and before its first message
is read. The wrapper locks the application's handler to call it and releases
the lock before awaiting what it returned.

What changed for a handler: futures it returns for different channels of one
connection can run concurrently and complete in any order, and the wrapper's
lock no longer makes the application's handler be called in strict arrival
order when two channels arrive together. It is still never called
concurrently with itself. A handler future that panics ends that channel's
task, not the acceptor. Nothing bounds how many admissions wait at once
except the peer's own rate of opening channels; upstream's bound was one,
with sixteen more streams queued in the association.

The native daemon regression
`a_channel_waiting_on_admission_does_not_hold_up_the_next_on_its_connection`
in `rtc_pair.rs` holds one session's transition, starts an attach for it,
and requires a second attach and a host channel on the same connection to be
admitted meanwhile, then the first attach to complete once the transition is
released. `a_stream_that_never_becomes_a_channel_leaves_the_pair_accepting`
pins the patch above on its own: it needs no held acceptor.

## The acceptor's end is reported, not logged

`ErrStreamClosed` from `DataChannel::accept` means the association's accept
queue closed. Upstream's webrtc-sctp never closed it, so that branch was
unreachable and an acceptor waited on a closed association until the
transport was stopped locally. The vendored webrtc-sctp now closes the queue
when the association closes (see the `vendor/` entry in `daemon/CLAUDE.md`),
which makes the branch the ordinary end of every acceptor — after a local
`stop()` as much as after an association that died under a connected
transport. The branch therefore logs at debug level instead of error, and
still calls `on_error` before the loop ends. The daemon installs that handler
on host peers (`install_host_acceptor_watch` in `rtc.rs`) and retires a peer
that is still in its host map.

The native daemon regression
`a_pair_whose_association_ended_is_retired_and_announced` in `rtc_pair.rs`
stops the device's SCTP transport under a pair whose ICE stays connected and
requires the pair to leave the host map with one `unavailable` for its
binding.
