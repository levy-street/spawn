/** A host-control failure: the daemon's own error code, or this client's. */
export class HostControlTransportError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = "HostControlTransportError";
  }
}
