/** An expected authorization outcome caused by RLS hiding a resource. */
export class ResourceAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceAccessDeniedError';
  }
}
