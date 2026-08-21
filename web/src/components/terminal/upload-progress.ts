/** One in-flight upload's byte progress. */
export type UploadTrack = { sent: number; total: number };

/**
 * How full the terminal's upload bar should be, or null when nothing is in
 * flight. Concurrent uploads share one bar and are weighted by size, so
 * dropping a 20 MB file next to a 40 KB one doesn't jump the bar to nearly
 * full the moment the small one lands.
 */
export function uploadRatio(tracks: readonly UploadTrack[]): number | null {
  if (tracks.length === 0) return null;
  let total = 0;
  let sent = 0;
  for (const track of tracks) {
    const size = Math.max(0, track.total);
    total += size;
    sent += Math.min(Math.max(0, track.sent), size);
  }
  // Zero-byte uploads still have a start and an acknowledgement to wait for;
  // show the bar rather than dividing by zero.
  if (total === 0) return 0;
  return Math.min(1, sent / total);
}
