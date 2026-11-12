export function Loading({ failed }: { failed: boolean }) {
  return (
    <p className="muted" role="status">
      {failed ? 'Could not reach NEAR testnet. Check your connection. This page keeps trying.' : 'Loading...'}
    </p>
  )
}
