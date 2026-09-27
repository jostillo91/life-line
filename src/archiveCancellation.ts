export class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive operation cancelled.')
    this.name = 'ArchiveCancelledError'
  }
}
