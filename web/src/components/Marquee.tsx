const FACTS = [
  '5% flat fee',
  'No interest',
  'Repaid from your next payment',
  'Limits from $25 to $400',
  'Any coin, any network',
  'Nothing added if a client is late',
]

/** The short version of the terms, drifting past. The list is doubled so the loop has no seam. */
export function Marquee() {
  return (
    <div className="marquee">
      <div>
        {[false, true].map((copy) => (
          <ul key={String(copy)} aria-hidden={copy || undefined}>
            {FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  )
}
