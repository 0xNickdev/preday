import { Link } from 'react-router-dom'

/** A coin whose leading edge breaks into pixels: part of the payment is already on its way to you. */
const MARK =
  'M13 2.5a9.5 9.5 0 010 19zM10 3.3h2.4v2.4h-2.4zM10 6.3h2.4v2.4h-2.4zM10 9.3h2.4v2.4h-2.4zM10 12.3h2.4v2.4h-2.4zM10 15.3h2.4v2.4h-2.4zM10 18.3h2.4v2.4h-2.4zM7.15 6.45h2.1v2.1h-2.1zM7.15 9.45h2.1v2.1h-2.1zM7.15 12.45h2.1v2.1h-2.1zM7.15 15.45h2.1v2.1h-2.1zM4.4 9.6h1.8v1.8h-1.8zM4.4 12.6h1.8v1.8h-1.8zM4.65 6.85h1.3v1.3h-1.3zM1.95 12.85h1.3v1.3h-1.3z'

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Preday home">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={MARK} />
      </svg>
      preday
    </Link>
  )
}
